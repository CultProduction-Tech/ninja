import { logger } from '../utils/logger';
import { SupabaseClient } from '../database/supabase';
import { DashboardClient, DashboardBlock } from '../database/dashboard-supabase';
import { AIServiceClient } from '../services/ai-client';
import {
  getStandardFieldMapping,
  getBlockDisplayName,
  categorizeStatus,
  extractAIColor,
} from '../shared/block-registry';

export async function runStatusUpdate(): Promise<Record<number, string>> {
  const DRY_RUN = process.env.DRY_RUN === 'true';

  if (DRY_RUN) {
    logger.info('DRY RUN MODE: Changes will NOT be saved to database');
  }

  logger.info('Starting status update workflow...');

  const updatesMap: Record<number, string> = {};

  try {
    const chats = await SupabaseClient.getAllChats();
    const systemSettings = await SupabaseClient.getSystemSettings();
    const messageLimit = systemSettings.number_of_new_messages || 200;

    logger.info(`Found ${chats.length} chats to process`);

    for (const chat of chats) {
      const updates = await processChat(chat, messageLimit, DRY_RUN);

      if (updates) {
        updatesMap[chat.project_id] = updates;
      }
    }

    const updatedSettings = await SupabaseClient.getSystemSettings();
    if (updatedSettings.one_more_update) {
      logger.info('one_more_update flag is true, will need another run');
    }

    logger.info('Status update workflow completed');

    return updatesMap;

  } catch (error) {
    logger.error('Error in runStatusUpdate:', error);
    throw error;
  }
}

async function processChat(chat: any, messageLimit: number, dryRun: boolean = false): Promise<string | null> {
  try {
    const chatId = chat.telegram_chat_id.toString();
    const projectId = chat.project_id;

    logger.info(`Processing chat ${chatId} for project ${projectId}`);

    let messages;
    if (dryRun) {
      const testMessageLimit = 200;
      messages = await SupabaseClient.getLastMessages(chatId, testMessageLimit);
      logger.info(`[DRY RUN] Getting last ${testMessageLimit} messages (ignoring is_analyzed flag)`);
    } else {
      messages = await SupabaseClient.getUnanalyzedMessages(chatId, messageLimit);
    }

    if (messages.length === 0) {
      logger.info(`No messages in chat ${chatId}`);
      return null;
    }

    logger.info(`Found ${messages.length} messages in chat ${chatId}`);

    const project = await SupabaseClient.getProject(projectId);

    if (!project) {
      logger.warn(`Project ${projectId} not found`);
      return null;
    }

    // Пропускаем завершённые проекты
    if (project.status === 'finished') {
      logger.info(`Project ${projectId} (${project.project_name}) is finished, skipping`);
      return null;
    }

    const activeBlocks = await DashboardClient.getActiveBlocks(project.project_name);

    if (activeBlocks.length === 0) {
      logger.warn(`No active blocks found for project ${project.project_name}`);
      return null;
    }

    logger.info(`Found ${activeBlocks.length} active blocks for ${project.project_name}:`);
    activeBlocks.forEach(block => {
      logger.info(`  - ${block.name} (${block.type})`);
    });

    // Загружаем ручные статусы из дашборда
    const manualStatuses = await DashboardClient.getManualStatuses(project.project_name);
    const MANUAL_STATUS_MAX_AGE_DAYS = 3;

    // Фильтруем: блоки со свежим ручным статусом (< 3 дней) не отправляем на AI-анализ
    const blocksForAI = activeBlocks.filter(block => {
      const blockKey = block.id || block.name;
      const manual = manualStatuses.get(blockKey);
      if (!manual || manual.status === 'Не определён') return true;
      const ageDays = (Date.now() - new Date(manual.changedAt).getTime()) / 86400000;
      if (ageDays >= MANUAL_STATUS_MAX_AGE_DAYS) {
        logger.info(`Block ${block.name}: manual status expired (${ageDays.toFixed(1)}d old), sending to AI`);
        return true;
      }
      return false;
    });

    if (manualStatuses.size > 0) {
      logger.info(`${manualStatuses.size} blocks have manual statuses from dashboard`);
    }

    // Собираем результаты: свежие ручные статусы + AI-анализ
    const analysisResults: Record<string, string> = {};

    // Свежие ручные статусы (< 5 дней)
    for (const [blockKey, manual] of manualStatuses) {
      if (manual.status !== 'Не определён') {
        const ageDays = (Date.now() - new Date(manual.changedAt).getTime()) / 86400000;
        if (ageDays < MANUAL_STATUS_MAX_AGE_DAYS) {
          analysisResults[blockKey] = manual.status;
        }
      }
    }

    // Анализируем остальные через AI
    if (blocksForAI.length > 0) {
      logger.info(`Formatting ${messages.length} messages with user roles...`);
      const conversationText = await SupabaseClient.formatConversationWithRoles(messages);

      logger.info(`Calling AI service to analyze ${blocksForAI.length} blocks for ${project.project_name}...`);

      const aiResults = await AIServiceClient.analyzeDynamicBlocks({
        projectId,
        projectName: project.project_name,
        blocks: blocksForAI,
        conversation: conversationText
      });

      Object.assign(analysisResults, aiResults);
    } else {
      logger.info(`All blocks have fresh manual statuses, skipping AI analysis`);
    }

    if (dryRun) {
      logger.info(`[DRY RUN] Updating project ${projectId}:`);
      logger.info(JSON.stringify(analysisResults, null, 2));
      logger.info(`[DRY RUN] NOT marking ${messages.length} messages as analyzed (for re-testing)`);

      await saveAnalysisResults(projectId, project.project_name, activeBlocks, analysisResults, true);
    } else {
      await saveAnalysisResults(projectId, project.project_name, activeBlocks, analysisResults, false);

      const messageIds = messages.map((m: any) => m.message_id);
      await SupabaseClient.markMessagesAsAnalyzed(messageIds);
    }

    logger.info(`Completed processing chat ${chatId}`);

    const clientSettings = await SupabaseClient.getClientSettings(projectId);
    const format = clientSettings.format_status || 'длинный';

    const updateText = formatUpdateText(activeBlocks, analysisResults, format, dryRun);
    return updateText;

  } catch (error) {
    logger.error(`Error processing chat ${chat.telegram_chat_id}:`, error);
    return null;
  }
}

async function saveAnalysisResults(
  projectId: number,
  projectName: string,
  blocks: DashboardBlock[],
  analysisResults: Record<string, string>,
  dryRun: boolean = false
) {
  try {
    for (const block of blocks) {
      const blockKey = block.id || block.name;
      const newStatus = analysisResults[blockKey];

      if (!newStatus) continue;

      // Пропускаем "информация отсутствует" — не перезаписываем старый статус
      if (newStatus.toLowerCase().includes('информация отсутствует')) {
        logger.info(`Block ${block.name}: no new info, keeping existing status`);
        continue;
      }

      // Все блоки (и стандартные, и кастомные) пишем в custom_block_statuses
      await SupabaseClient.upsertCustomBlockStatus({
        project_id: projectId,
        block_id: block.id || block.name,
        block_name: block.name,
        block_type: block.type,
        status_analysis: newStatus
      });

      // Синхронизируем в дашборд (OCTOPUS)
      try {
        await DashboardClient.syncStatusToDashboard(
          projectName, block.id || block.name, block.name, block.type, newStatus
        );
      } catch (dashError) {
        logger.warn(`Dashboard sync failed for ${block.name} (non-critical):`, dashError);
      }

      // Стандартные блоки дополнительно пишем в projects/projects_test (dual-write, не критично)
      if (block.type === 'standard') {
        const fieldMapping = getStandardFieldMapping(block.name);
        if (fieldMapping) {
          try {
            if (!dryRun) {
              await SupabaseClient.updateProjectField(projectId, fieldMapping, newStatus);
            } else {
              await SupabaseClient.ensureProjectTestExists(projectId);
              await SupabaseClient.updateProjectTestField(projectId, fieldMapping, newStatus);
            }
          } catch (dualWriteError) {
            logger.warn(`Dual-write failed for ${block.name} (non-critical):`, dualWriteError);
          }
        }
      }

      const prefix = dryRun ? '[DRY RUN] ' : '';
      logger.info(`${prefix}Updated block: ${projectName} / ${block.name}`);
    }

    try {
      const statusMap: Record<string, string> = {};
      const blocksForDashboard: Array<{ name: string; status: string; isDocuments: boolean }> = [];

      for (const block of blocks) {
        const blockKey = block.id || block.name;
        const status = analysisResults[blockKey];
        if (status && !status.toLowerCase().includes('информация отсутствует')) {
          statusMap[blockKey] = status;
          const isDocuments = block.name === 'documents' || block.name.toLowerCase().includes('документ') || block.name.toLowerCase().includes('договор');
          blocksForDashboard.push({ name: block.name, status, isDocuments });
        }
      }

      let dashboardStatusMap: Record<string, string> = {};
      if (blocksForDashboard.length > 0) {
        dashboardStatusMap = await AIServiceClient.classifyDashboardStatuses(blocksForDashboard);
        logger.info(`Dashboard statuses classified for ${projectName}: ${JSON.stringify(dashboardStatusMap)}`);
      }

      await DashboardClient.syncProjectTaskStatus(projectId, projectName, blocks, statusMap, dashboardStatusMap);
    } catch (syncError) {
      logger.warn(`project_task_status sync failed for ${projectName} (non-critical):`, syncError);
    }
  } catch (error) {
    logger.error('Error saving analysis results:', error);
    throw error;
  }
}


function formatUpdateText(
  blocks: DashboardBlock[],
  updates: Record<string, string>,
  format: 'короткий' | 'длинный' = 'длинный',
  dryRun: boolean = false
): string {
  interface StatusItem {
    name: string;
    status: string;
    category: 'important' | 'in_progress' | 'approved' | 'dates' | 'no_info';
    phase: 'pre' | 'post';
  }

  const changedStatuses: StatusItem[] = [];

  for (const block of blocks) {
    const blockKey = block.id || block.name;
    const newStatus = updates[blockKey];

    if (!newStatus || newStatus.toLowerCase().includes('информация отсутствует')) {
      continue;
    }

    const displayName = block.type === 'standard'
      ? getBlockDisplayName(block.name)
      : block.name;

    const category = categorizeStatus(newStatus);
    const cleanStatus = extractAIColor(newStatus).text;
    changedStatuses.push({ name: displayName, status: cleanStatus, category, phase: block.phase || 'pre' });
  }

  if (changedStatuses.length === 0) {
    return dryRun
      ? '[DRY RUN] Нет изменений в статусах'
      : 'Нет изменений в статусах';
  }

  const sections: string[] = [];
  const prefix = dryRun ? '[DRY RUN - сохранено в projects_test]\n\n' : '';

  // Маркер по категории — стандартные кружочки (как в status-scheduler)
  const marker = (cat: string) => {
    switch (cat) {
      case 'approved': return '🟢';
      case 'important': return '🔴';
      case 'dates':
      case 'in_progress': return '🟡';
      default: return '⚪';
    }
  };

  // Кастомные эмодзи для заголовков фаз
  const customPre = process.env.CUSTOM_EMOJI_YELLOW;
  const customPost = process.env.CUSTOM_EMOJI_RED;
  const preHeader = customPre
    ? `<tg-emoji emoji-id="${customPre}">🩷</tg-emoji> Пре-продакшн:`
    : '🩷 Пре-продакшн:';
  const postHeader = customPost
    ? `<tg-emoji emoji-id="${customPost}">🖤</tg-emoji> Пост-продакшн:`
    : '🖤 Пост-продакшн:';

  if (format === 'короткий') {
    let num = 1;
    const lines: string[] = [];
    const approvedNames: string[] = [];

    for (const s of changedStatuses) {
      if (s.category === 'approved') {
        approvedNames.push(s.name);
        continue;
      }
      const brief = s.status.split('\n')[0].trim();
      lines.push(`${num}. ${marker(s.category)}${s.name}\n${brief}`);
      num++;
    }

    if (approvedNames.length > 0) {
      lines.push(`${num}. ${marker('approved')}Согласовано\n${approvedNames.join(', ')}`);
    }

    sections.push(lines.join('\n\n'));

  } else {
    // Длинный формат — группировка по этапам
    const preStatuses = changedStatuses.filter(s => s.phase === 'pre');
    const postStatuses = changedStatuses.filter(s => s.phase === 'post');

    const formatPhase = (phaseStatuses: StatusItem[]): string => {
      let num = 1;
      const lines: string[] = [];
      const importantBlocks: string[] = [];

      for (const s of phaseStatuses) {
        // Правило: если согласовано — только "Согласовано", без доп. комментариев
        const displayStatus = s.category === 'approved' ? '- Согласовано' : s.status;
        lines.push(`${num}. ${marker(s.category)}${s.name}\n${displayStatus}`);
        num++;

        if (s.category === 'important') {
          importantBlocks.push(`- ${s.name}: ${s.status.split('\n')[0].trim()}`);
        }
      }

      let result = lines.join('\n\n');

      if (importantBlocks.length > 0) {
        result += '\n\n‼️ Ждём от клиента:\n' + importantBlocks.join('\n');
      }

      return result;
    };

    if (preStatuses.length > 0) {
      sections.push(preHeader + '\n\n' + formatPhase(preStatuses));
    }

    if (postStatuses.length > 0) {
      sections.push(postHeader + '\n\n' + formatPhase(postStatuses));
    }
  }

  return prefix + sections.join('\n\n');
}

