import { logger } from '../utils/logger';
import { SupabaseClient } from '../database/supabase';
import { DashboardClient, DashboardBlock } from '../database/dashboard-supabase';
import { AIServiceClient } from '../services/ai-client';
import {
  getStandardFieldMapping,
  getBlockDisplayName,
  categorizeStatus,
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

    // Фильтруем: блоки с осмысленным ручным статусом не отправляем на AI-анализ
    const blocksForAI = activeBlocks.filter(block => {
      const blockKey = block.id || block.name;
      const manual = manualStatuses.get(blockKey);
      return !manual || manual.status === 'Не определён';
    });

    if (manualStatuses.size > 0) {
      logger.info(`${manualStatuses.size} blocks have manual statuses (skipping AI analysis for them)`);
    }

    // Собираем результаты: ручные статусы (кроме "Не определён") + AI-анализ
    const analysisResults: Record<string, string> = {};

    // Сначала добавляем осмысленные ручные статусы
    for (const [blockKey, manual] of manualStatuses) {
      if (manual.status !== 'Не определён') {
        analysisResults[blockKey] = manual.status;
      }
    }

    // Затем анализируем остальные через AI
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
      logger.info(`All blocks have manual statuses, skipping AI analysis`);
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
    changedStatuses.push({ name: displayName, status: newStatus, category, phase: block.phase || 'pre' });
  }

  if (changedStatuses.length === 0) {
    return dryRun
      ? '[DRY RUN] Нет изменений в статусах'
      : 'Нет изменений в статусах';
  }

  const sections: string[] = [];
  const prefix = dryRun ? '[DRY RUN - сохранено в projects_test]\n\n' : '';

  if (format === 'короткий') {
    const important = changedStatuses.filter(s => s.category === 'important');
    const approved = changedStatuses.filter(s => s.category === 'approved');
    const inProgress = changedStatuses.filter(s => s.category === 'in_progress');

    if (inProgress.length > 0) {
      sections.push(inProgress.map(s => `📍 ${s.name}\n${s.status}`).join('\n\n'));
    }

    if (approved.length > 0) {
      sections.push('✅ Согласовано:\n' + approved.map(s => `- ${s.name}`).join('\n'));
    }

    if (important.length > 0) {
      sections.push('❓ Важно:\n' + important.map(s => `${s.status}`).join('\n\n'));
    }

  } else {
    // Длинный формат — группировка по этапам
    const preStatuses = changedStatuses.filter(s => s.phase === 'pre');
    const postStatuses = changedStatuses.filter(s => s.phase === 'post');

    const formatPhase = (phaseStatuses: StatusItem[]): string[] => {
      const phaseSections: string[] = [];

      const important = phaseStatuses.filter(s => s.category === 'important');
      const inProgress = phaseStatuses.filter(s => s.category === 'in_progress');
      const approved = phaseStatuses.filter(s => s.category === 'approved');
      const dates = phaseStatuses.filter(s => s.category === 'dates');

      if (important.length > 0) {
        phaseSections.push('❓ Важные вопросы:\n' + important.map(s => `${s.status}`).join('\n\n'));
      }

      if (inProgress.length > 0) {
        phaseSections.push(inProgress.map(s => `📍 ${s.name}\n${s.status}`).join('\n\n'));
      }

      if (approved.length > 0) {
        phaseSections.push('✅ Согласовано:\n' + approved.map(s => `- ${s.name}`).join('\n'));
      }

      if (dates.length > 0) {
        phaseSections.push('‼️ Важные даты:\n' + dates.map(s => `${s.status}`).join('\n\n'));
      }

      return phaseSections;
    };

    if (preStatuses.length > 0) {
      const preSections = formatPhase(preStatuses);
      if (preSections.length > 0) {
        sections.push('🎬 Пре-продакшн:\n\n' + preSections.join('\n\n'));
      }
    }

    if (postStatuses.length > 0) {
      const postSections = formatPhase(postStatuses);
      if (postSections.length > 0) {
        sections.push('🎞️ Пост-продакшн:\n\n' + postSections.join('\n\n'));
      }
    }
  }

  return prefix + sections.join('\n\n');
}

