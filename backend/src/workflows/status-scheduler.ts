import cron from 'node-cron';
import { logger } from '../utils/logger';
import { SupabaseClient, getDefaultClientSettings } from '../database/supabase';
import { DashboardClient } from '../database/dashboard-supabase';
import { getSmartBot } from '../bot/smart-bot';
import { AIServiceClient } from '../services/ai-client';

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

    const clientSettings = await SupabaseClient.getClientSettings(project.project_id);
    const format = clientSettings.format_status || 'длинный';

    const activeBlocks = await DashboardClient.getActiveBlocks(project.project_name);

    if (activeBlocks.length === 0) {
      logger.warn(`No active blocks found for project ${project.project_name}`);
      return;
    }

    const DRY_RUN = process.env.DRY_RUN === 'true';
    const projectData = DRY_RUN
      ? await SupabaseClient.getProjectTest(project.project_id)
      : await SupabaseClient.getProject(project.project_id);

    if (DRY_RUN) {
      logger.info(`[DRY RUN] Reading statuses from projects_test table`);
    }

    let customStatuses = await SupabaseClient.getCustomBlockStatuses(project.project_id);

    const customBlocks = activeBlocks.filter(b => b.type !== 'standard');
    if (customBlocks.length > 0) {
      const missingBlocks = customBlocks.filter(block =>
        !customStatuses.find(s => s.block_id === block.id && s.status_analysis)
      );

      if (missingBlocks.length > 0) {
        logger.info(`Missing statuses for ${missingBlocks.length} custom blocks, analyzing on-demand...`);

        const newStatuses = await analyzeCustomBlocksOnDemand(project, missingBlocks);

        customStatuses = [...customStatuses, ...newStatuses];
      }
    }

    const statusMap: Record<string, string> = {};
    for (const block of activeBlocks) {
      const blockKey = block.id || block.name;

      if (block.type !== 'standard') {
        const customStatus = customStatuses.find(s => s.block_id === block.id);
        if (customStatus && customStatus.status_analysis) {
          statusMap[blockKey] = customStatus.status_analysis;
        }
      } else {
        const fieldName = getStandardFieldMapping(block.name);
        if (fieldName && projectData && projectData[fieldName]) {
          statusMap[blockKey] = projectData[fieldName];
        }
      }
    }

    let updateText = formatStatusForClient(activeBlocks, statusMap, format);

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
    await smartBot.notifyProducer(
      recipientTgId,
      project.project_name,
      updateText
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

export function getStandardFieldMapping(dashboardBlockName: string): string | null {
  const mapping: Record<string, string> = {
    'documents': 'doc',
    'storyboard': 'storyboard_cult',
    'casting': 'casting_cult',
    'location': 'location_cult',
    'props': 'props_cult',
    'wardrobe': 'clothes_cult',
    'editing': 'editing_cult',
    'voice': 'vo_cult',
    'music': 'music_cult',
    'color': 'colorgrading_cult',
    'photos': 'photos_cult',
    'cg': 'cg_cult',
    'animatic': 'animatic_cult',
    'modelling': 'modelling_cult',
    'styleshots': 'styleshots_cult',
    'animation': 'animation_cult',
    'Документы': 'doc',
    'Раскадровка': 'storyboard_cult',
    'Кастинг': 'casting_cult',
    'Локация': 'location_cult',
    'Реквизит': 'props_cult',
    'Костюмы': 'clothes_cult',
    'Монтаж': 'editing_cult',
    'Озвучка': 'vo_cult',
    'Музыка': 'music_cult',
    'Цветокоррекция': 'colorgrading_cult',
    'Фото': 'photos_cult',
    'CG': 'cg_cult',
    'Аниматик': 'animatic_cult',
    'Моделирование': 'modelling_cult',
    'Стайлшоты': 'styleshots_cult',
    'Анимация': 'animation_cult'
  };

  return mapping[dashboardBlockName] || null;
}

export function formatStatusForClient(
  blocks: any[],
  statusMap: Record<string, string>,
  format: 'короткий' | 'длинный'
): string {
  interface StatusItem {
    name: string;
    status: string;
    category: 'important' | 'in_progress' | 'approved' | 'dates' | 'no_info';
  }

  const statuses: StatusItem[] = [];

  for (const block of blocks) {
    const blockKey = block.id || block.name;
    const status = statusMap[blockKey];

    if (status) {
      const displayName = block.type === 'standard'
        ? formatStandardBlockName(block.name)
        : block.name;

      const category = categorizeStatus(status);
      statuses.push({ name: displayName, status, category });
    }
  }

  if (statuses.length === 0) {
    return 'Нет актуальной информации о статусе проекта';
  }

  const important = statuses.filter(s => s.category === 'important');
  const approved = statuses.filter(s => s.category === 'approved');
  const dates = statuses.filter(s => s.category === 'dates');
  const inProgress = statuses.filter(s => s.category === 'in_progress');
  const noInfo = statuses.filter(s => s.category === 'no_info');

  const sections: string[] = [];

  if (format === 'короткий') {
    if (important.length > 0) {
      sections.push('❓ Важно:\n' + important.map(s => `${s.status}`).join('\n\n'));
    }

    if (inProgress.length > 0) {
      sections.push(inProgress.map(s => `📍 ${s.name}\n${s.status}`).join('\n\n'));
    }

    if (dates.length > 0) {
      sections.push(dates.map(s => `📍 ${s.name}\n${s.status}`).join('\n\n'));
    }

    if (approved.length > 0) {
      sections.push('✅ Согласовано:\n' + approved.map(s => `- ${s.name}`).join('\n'));
    }

    if (noInfo.length > 0) {
      sections.push('📋 Нет информации:\n' + noInfo.map(s => `- ${s.name}`).join('\n'));
    }

  } else {
    if (important.length > 0) {
      sections.push('❓ Важные вопросы:\n' + important.map(s => `${s.status}`).join('\n\n'));
    }

    if (inProgress.length > 0) {
      sections.push('Наши процессы:\n\n' + inProgress.map(s => `📍 ${s.name}\n${s.status}`).join('\n\n'));
    }

    if (approved.length > 0) {
      sections.push('✅ Согласовано:\n' + approved.map(s => `- ${s.name}`).join('\n'));
    }

    if (dates.length > 0) {
      sections.push('‼️ Важные даты и этапы проекта:\n' + dates.map(s => `${s.status}`).join('\n\n'));
    }

    if (noInfo.length > 0) {
      sections.push('📋 Нет информации:\n' + noInfo.map(s => `- ${s.name}`).join('\n'));
    }
  }

  return sections.join('\n\n');
}

function categorizeStatus(status: string): 'important' | 'in_progress' | 'approved' | 'dates' | 'no_info' {
  const lowerStatus = status.toLowerCase();

  if (lowerStatus.includes('информация отсутствует') || lowerStatus.includes('нет информации')) {
    return 'no_info';
  }

  const importantKeywords = [
    'важно', 'необходимо', 'срочно', 'нужно утвердить', 'требуется',
    'критично', 'обязательно', 'должны', 'надо'
  ];

  const approvedKeywords = [
    'согласовано', 'утверждено', 'одобрено', 'окнули', 'ок от клиента',
    'подписан', 'готов', 'завершен', 'принято', 'финальн'
  ];

  const datePattern = /\d{1,2}[.\-\/]\d{1,2}|\d{1,2}\s+(января|февраля|марта|апреля|мая|июня|июля|августа|сентября|октября|ноября|декабря)|PPM|pre-PPM|съемка|презентация/i;

  if (importantKeywords.some(keyword => lowerStatus.includes(keyword))) {
    return 'important';
  }

  if (approvedKeywords.some(keyword => lowerStatus.includes(keyword))) {
    return 'approved';
  }

  if (datePattern.test(status)) {
    return 'dates';
  }

  return 'in_progress';
}

export function formatStandardBlockName(blockName: string): string {
  const names: Record<string, string> = {
    'documents': 'Договор',
    'storyboard': 'Раскадровка',
    'casting': 'Кастинг',
    'location': 'Локации',
    'props': 'Реквизит',
    'wardrobe': 'Одежда',
    'editing': 'Монтаж',
    'voice': 'Войсовер',
    'music': 'Музыка',
    'color': 'Цветокоррекция',
    'photos': 'Фото',
    'cg': 'CG',
    'animatic': 'Аниматик',
    'modelling': 'Моделирование',
    'styleshots': 'Стайлшоты',
    'animation': 'Анимация'
  };

  return names[blockName] || blockName;
}

function getDayOfWeek(date: Date): string {
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  return days[date.getDay()];
}

export async function sendStatusToProducerAdmin(project: any) {
  await sendStatusToProducer(project);
}
