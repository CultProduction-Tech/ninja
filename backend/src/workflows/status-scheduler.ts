import cron from 'node-cron';
import { logger } from '../utils/logger';
import { SupabaseClient, getDefaultClientSettings } from '../database/supabase';
import { DashboardClient } from '../database/dashboard-supabase';
import { getSmartBot } from '../bot/smart-bot';
import { AIServiceClient } from '../services/ai-client';
import {
  getBlockDisplayName,
  categorizeStatus,
} from '../shared/block-registry';
import { isInQuietHours, checkWeekendPolicy } from '../utils/schedule-helpers';

export function startStatusScheduler() {
  const cronSchedule = '0 * * * *';

  logger.info(`Status notification scheduler started with cron: ${cronSchedule}`);

  cron.schedule(cronSchedule, async () => {
    logger.info('Status notification scheduler triggered');
    await checkAndSendStatusUpdates();
  });
}

export async function checkAndSendStatusUpdates() {
  try {
    logger.info('Checking projects for status updates...');

    const projects = await SupabaseClient.getAllProjects();

    if (!projects || projects.length === 0) {
      logger.info('No projects found');
      return;
    }

    const now = new Date();
    const currentDay = getDayOfWeek(now);
    const currentHour = now.getHours();

    logger.info(`Current time: ${currentDay} ${currentHour}:00`);

    let sentCount = 0;

    for (const project of projects) {
      try {
        const shouldSend = await shouldSendStatusNow(
          project.project_id,
          currentDay,
          currentHour
        );

        if (shouldSend) {
          await sendStatusToProducer(project);
          sentCount++;
        }
      } catch (error) {
        logger.error(`Error checking project ${project.project_id}:`, error);
      }
    }

    logger.info(`Status notification check completed. Sent ${sentCount} updates.`);

  } catch (error) {
    logger.error('Error in checkAndSendStatusUpdates:', error);
  }
}

async function shouldSendStatusNow(
  projectId: number,
  currentDay: string,
  currentHour: number
): Promise<boolean> {
  try {
    const settings = await SupabaseClient.getClientSettings(projectId);
    const defaults = getDefaultClientSettings();

    // Проверка тихого режима
    if (isInQuietHours(settings.quiet_from, settings.quiet_to)) {
      logger.info(`Project ${projectId}: Skipping - quiet hours (${settings.quiet_from} - ${settings.quiet_to})`);
      return false;
    }

    // Проверка выходных
    const weekendPolicy = checkWeekendPolicy(settings.weekend);
    if (weekendPolicy.blocked) {
      logger.info(`Project ${projectId}: Skipping - weekends disabled`);
      return false;
    }

    const frequencyDays = settings.status_frequency_day || defaults.status_frequency_day;
    const frequencyTime = settings.status_frequency_time || defaults.status_frequency_time;

    const allowedDays = frequencyDays.split(',').map((d: string) => d.trim());

    if (!allowedDays.includes(currentDay)) {
      return false;
    }

    const timeMatch = frequencyTime.match(/^(\d{1,2}):(\d{2})/);
    if (!timeMatch) {
      logger.error(`Invalid time format: ${frequencyTime}`);
      return false;
    }

    const deadlineHour = parseInt(timeMatch[1], 10);

    const sendHour = deadlineHour - 1;

    if (currentHour === sendHour) {
      logger.info(`Project ${projectId}: Time to send (${currentHour}:00, deadline at ${deadlineHour}:00)`);
      return true;
    }

    return false;

  } catch (error) {
    logger.error(`Error in shouldSendStatusNow for project ${projectId}:`, error);
    return false;
  }
}

async function sendStatusToProducer(project: any) {
  try {
    logger.info(`Sending status update for project ${project.project_id}: ${project.project_name}`);

    const TEST_MODE = process.env.TEST_MODE === 'true';
    const TEST_TELEGRAM_ID = process.env.TEST_TELEGRAM_ID || '489599665';
    const DRY_RUN = process.env.DRY_RUN === 'true';

    const clientSettings = await SupabaseClient.getClientSettings(project.project_id);
    const format = clientSettings.format_status || 'длинный';

    const activeBlocks = await DashboardClient.getActiveBlocks(project.project_name);

    if (activeBlocks.length === 0) {
      logger.warn(`No active blocks found for project ${project.project_name}`);
      return;
    }

    // Загружаем ручные статусы из дашборда (приоритет над AI)
    const manualStatuses = await DashboardClient.getManualStatuses(project.project_name);

    if (manualStatuses.size > 0) {
      logger.info(`${manualStatuses.size} blocks have manual statuses from dashboard`);
    }

    // AI-статусы из единого хранилища custom_block_statuses
    let allStatuses = await SupabaseClient.getCustomBlockStatuses(project.project_id);

    // Блоки без статуса (ни ручного, ни AI) — анализируем на лету
    const missingBlocks = activeBlocks.filter(block => {
      const blockId = block.id || block.name;
      const manual = manualStatuses.get(blockId);
      if (manual && manual.status !== 'Не определён') return false; // есть осмысленный ручной — не нужен AI
      return !allStatuses.find(s => s.block_id === blockId && s.status_analysis);
    });

    if (missingBlocks.length > 0) {
      logger.info(`Missing statuses for ${missingBlocks.length} blocks, analyzing on-demand...`);
      const newStatuses = await analyzeCustomBlocksOnDemand(project, missingBlocks);
      allStatuses = [...allStatuses, ...newStatuses];
    }

    // Собираем итоговую карту статусов: ручные > AI
    const statusMap: Record<string, string> = {};
    for (const block of activeBlocks) {
      const blockKey = block.id || block.name;

      // Ручной статус из дашборда — приоритет (кроме "Не определён")
      const manual = manualStatuses.get(blockKey);
      if (manual && manual.status !== 'Не определён') {
        statusMap[blockKey] = manual.status;
        continue;
      }

      // Иначе — AI-статус
      const status = allStatuses.find(s => s.block_id === blockKey);
      if (status && status.status_analysis) {
        statusMap[blockKey] = status.status_analysis;
      }
    }

    // Проверка выходных — urgent only
    const weekendPolicy = checkWeekendPolicy(clientSettings.weekend);
    let updateText = formatStatusForClient(activeBlocks, statusMap, format, weekendPolicy.urgentOnly);

    if (!updateText || updateText.trim() === '') {
      logger.info(`Project ${project.project_id}: No statuses to send (urgentOnly=${weekendPolicy.urgentOnly}), skipping`);
      return;
    }

    // Резолвим [#id] теги в ссылки на сообщения
    const allMessages = await SupabaseClient.getLastMessagesForProject(project.project_id, 200);
    const linkMap = SupabaseClient.buildMessageLinkMap(allMessages);
    updateText = resolveMessageLinks(updateText, linkMap);

    let recipientTgId: string;
    let recipientInfo: string;

    if (TEST_MODE) {
      recipientTgId = TEST_TELEGRAM_ID;
      recipientInfo = `admin ${TEST_TELEGRAM_ID} (TEST MODE)`;

      const producerName = project.producer?.producer_name || 'Неизвестный продюсер';
      let testPrefix = `[TEST MODE]\nПродюсер: ${producerName}\n`;

      if (DRY_RUN) {
        testPrefix += `[DRY RUN - данные из projects_test]\n`;
      }

      testPrefix += `\n`;
      updateText = testPrefix + updateText;

      logger.info(`TEST MODE: Sending status to ${recipientInfo} instead of producer`);
    } else {
      if (!project.producer || !project.producer.producer_tg_chat_id) {
        logger.warn(`No producer found for project ${project.project_id}`);
        return;
      }
      recipientTgId = project.producer.producer_tg_chat_id.toString();
      recipientInfo = `producer ${recipientTgId}`;
    }

    const smartBot = getSmartBot();

    // Если включена отправка клиенту — добавляем кнопку подтверждения
    let clientTgId: string | null = null;
    let clientStatusText: string | null = null;

    if (clientSettings.send_to_client && project.client?.client_chat_id) {
      const clientText = formatStatusForClient(activeBlocks, statusMap, 'короткий', weekendPolicy.urgentOnly);

      if (clientText && clientText.trim() !== '') {
        clientStatusText = resolveMessageLinks(clientText, linkMap);

        if (TEST_MODE) {
          clientTgId = TEST_TELEGRAM_ID;
        } else {
          clientTgId = project.client.client_chat_id.toString();
        }
      }
    }

    await smartBot.notifyProducerWithClientApproval(
      recipientTgId,
      project.project_name,
      updateText,
      clientTgId,
      clientStatusText
    );

    logger.info(`Sent status update for project ${project.project_name} to ${recipientInfo}`);

  } catch (error) {
    logger.error(`Error sending status for project ${project.project_id}:`, error);
  }
}

async function analyzeCustomBlocksOnDemand(project: any, customBlocks: any[]): Promise<any[]> {
  try {
    logger.info(`Analyzing ${customBlocks.length} custom blocks on-demand for project ${project.project_id}`);

    const messages = await SupabaseClient.getLastMessagesForProject(project.project_id, 100);

    if (messages.length === 0) {
      logger.info(`No messages found in chats for project ${project.project_id}`);
      return [];
    }

    logger.info(`Found ${messages.length} messages from all project chats for analysis`);

    logger.info(`Formatting ${messages.length} messages with user roles...`);
    const conversationText = await SupabaseClient.formatConversationWithRoles(messages);

    const analysisResults = await AIServiceClient.analyzeDynamicBlocks({
      projectId: project.project_id,
      projectName: project.project_name,
      blocks: customBlocks,
      conversation: conversationText
    });

    logger.info(`AI analysis completed for ${customBlocks.length} custom blocks`);

    const savedStatuses = [];
    for (const block of customBlocks) {
      const blockKey = block.id || block.name;
      const newStatus = analysisResults[blockKey];

      if (newStatus) {
        await SupabaseClient.upsertCustomBlockStatus({
          project_id: project.project_id,
          block_id: block.id!,
          block_name: block.name,
          block_type: block.type,
          status_analysis: newStatus
        });

        // Синхронизируем в дашборд (OCTOPUS)
        try {
          await DashboardClient.syncStatusToDashboard(
            project.project_name, block.id!, block.name, block.type, newStatus
          );
        } catch (dashError) {
          logger.warn(`Dashboard sync failed for ${block.name} (non-critical):`, dashError);
        }

        logger.info(`Saved status for custom block: ${block.name}`);

        savedStatuses.push({
          project_id: project.project_id,
          block_id: block.id,
          block_name: block.name,
          block_type: block.type,
          status_analysis: newStatus
        });
      }
    }

    logger.info(`Saved ${savedStatuses.length} custom block statuses`);
    return savedStatuses;

  } catch (error) {
    logger.error(`Error in analyzeCustomBlocksOnDemand:`, error);
    return [];
  }
}


export function formatStatusForClient(
  blocks: any[],
  statusMap: Record<string, string>,
  format: 'короткий' | 'длинный',
  urgentOnly: boolean = false
): string {
  interface StatusItem {
    name: string;
    status: string;
    category: 'important' | 'in_progress' | 'approved' | 'dates' | 'no_info';
    phase: 'pre' | 'post';
  }

  const statuses: StatusItem[] = [];

  for (const block of blocks) {
    const blockKey = block.id || block.name;
    const status = statusMap[blockKey];

    if (status) {
      const displayName = block.type === 'standard'
        ? getBlockDisplayName(block.name)
        : block.name;

      const category = categorizeStatus(status);
      statuses.push({ name: displayName, status, category, phase: block.phase || 'pre' });
    }
  }

  if (statuses.length === 0) {
    return 'Нет актуальной информации о статусе проекта';
  }

  // Режим выходных — только срочные
  if (urgentOnly) {
    const urgent = statuses.filter(s => s.category === 'important');
    if (urgent.length === 0) return '';
    return '❓ Срочное:\n' + urgent.map(s => `${s.status}`).join('\n\n');
  }

  const sections: string[] = [];

  // Маркер по категории
  const marker = (cat: string) => {
    switch (cat) {
      case 'approved': return '💚';
      case 'important': return '❤️';
      case 'dates': return '💛';
      case 'in_progress': return '💛';
      default: return '📍';
    }
  };

  if (format === 'короткий') {
    // Короткий: нумерованный список, одна строка на блок
    // Пример: 1. 💛Монтаж — Ждём ОС
    //         2. 💚Музыка — Согласована
    let num = 1;
    const lines: string[] = [];
    const approvedNames: string[] = [];

    for (const s of statuses) {
      if (s.category === 'no_info') continue;
      if (s.category === 'approved') {
        approvedNames.push(s.name);
        continue;
      }
      // Берём первую строку статуса как краткое описание
      const brief = s.status.split('\n')[0].trim();
      lines.push(`${num}. ${marker(s.category)}${s.name}\n${brief}`);
      num++;
    }

    if (approvedNames.length > 0) {
      lines.push(`${num}. 💚Согласовано\n${approvedNames.join(', ')}`);
    }

    sections.push(lines.join('\n\n'));

  } else {
    // Длинный: нумерованный список с полным текстом, группировка по фазам
    // Пример: 1. 📍Документы
    //         Запустили процесс... Отправили договор...
    const formatPhase = (phaseStatuses: StatusItem[]): string => {
      let num = 1;
      const lines: string[] = [];
      const importantQuestions: string[] = [];

      for (const s of phaseStatuses) {
        if (s.category === 'no_info') continue;

        lines.push(`${num}. ${marker(s.category)}${s.name}\n${s.status}`);
        num++;

        // Собираем важные вопросы отдельно
        if (s.category === 'important') {
          importantQuestions.push(s.status);
        }
      }

      return lines.join('\n\n');
    };

    const preStatuses = statuses.filter(s => s.phase === 'pre');
    const postStatuses = statuses.filter(s => s.phase === 'post');

    if (preStatuses.length > 0 && postStatuses.length > 0) {
      // Есть обе фазы — добавляем заголовки
      const preText = formatPhase(preStatuses);
      if (preText) sections.push('🎬 Пре-продакшн:\n\n' + preText);
      const postText = formatPhase(postStatuses);
      if (postText) sections.push('🎞️ Пост-продакшн:\n\n' + postText);
    } else {
      // Одна фаза — без заголовков
      const allText = formatPhase(statuses);
      if (allText) sections.push(allText);
    }

    // Важные вопросы/ожидания — в конце отдельным блоком
    const important = statuses.filter(s => s.category === 'important');
    if (important.length > 0) {
      sections.push('‼️ Ждём от клиента:\n' + important.map(s => `- ${s.name}: ${s.status.split('\n')[0]}`).join('\n'));
    }
  }

  return sections.join('\n\n');
}

/**
 * Заменяет теги [#id] в тексте статуса на кликабельные ссылки на сообщения в Telegram.
 * linkMap: Map<message_id, telegram_deep_link>
 * Если ссылка не найдена (нет telegram_message_id), тег просто удаляется.
 */
export function resolveMessageLinks(text: string, linkMap: Map<number, string>): string {
  return text.replace(/\[#(\d+)\]/g, (match, idStr) => {
    const id = parseInt(idStr, 10);
    const link = linkMap.get(id);
    if (link) {
      return `(📎)`;
    }
    // Нет ссылки — убираем тег
    return '';
  });
}

/**
 * Версия для HTML parse_mode: теги → кликабельные ссылки.
 */
export function resolveMessageLinksHtml(text: string, linkMap: Map<number, string>): string {
  // Сначала списки вида [#123, #456, #789]
  text = text.replace(/\[#(\d+(?:,\s*#?\d+)*)\]/g, (match, inner) => {
    const ids = inner.split(',').map((s: string) => parseInt(s.replace(/[^0-9]/g, ''), 10));
    const links = ids
      .map((id: number) => {
        const link = linkMap.get(id);
        return link ? `<a href="${link}">📎</a>` : null;
      })
      .filter(Boolean);
    return links.length > 0 ? links.join(' ') : match;
  });

  // Затем одиночные [#123]
  text = text.replace(/\[#(\d+)\]/g, (match, idStr) => {
    const id = parseInt(idStr, 10);
    const link = linkMap.get(id);
    return link ? `<a href="${link}">📎</a>` : match;
  });

  return text;
}



function getDayOfWeek(date: Date): string {
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  return days[date.getDay()];
}

export async function sendStatusToProducerAdmin(project: any) {
  await sendStatusToProducer(project);
}
