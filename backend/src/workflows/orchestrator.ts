import { logger } from '../utils/logger';
import { SupabaseClient } from '../database/supabase';
import { DashboardClient, DashboardBlock } from '../database/dashboard-supabase';
import { AIServiceClient } from '../services/ai-client';

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
    const messageLimit = systemSettings.number_of_new_messages || 100;

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

    const activeBlocks = await DashboardClient.getActiveBlocks(project.project_name);

    if (activeBlocks.length === 0) {
      logger.warn(`No active blocks found for project ${project.project_name}`);
      return null;
    }

    logger.info(`Found ${activeBlocks.length} active blocks for ${project.project_name}:`);
    activeBlocks.forEach(block => {
      logger.info(`  - ${block.name} (${block.type})`);
    });

    logger.info(`Formatting ${messages.length} messages with user roles...`);
    const conversationText = await SupabaseClient.formatConversationWithRoles(messages);

    logger.info(`Calling AI service to analyze ${activeBlocks.length} blocks for ${project.project_name}...`);

    const analysisResults = await AIServiceClient.analyzeDynamicBlocks({
      projectId,
      projectName: project.project_name,
      blocks: activeBlocks,
      conversation: conversationText
    });

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

      if (block.type === 'standard') {
        const fieldMapping = getStandardFieldMapping(block.name);

        if (fieldMapping) {
          if (!dryRun) {
            await SupabaseClient.updateProjectField(projectId, fieldMapping, newStatus);
            logger.info(`Updated projects table: ${projectName} / ${fieldMapping}`);
          } else {
            await SupabaseClient.ensureProjectTestExists(projectId);
            await SupabaseClient.updateProjectTestField(projectId, fieldMapping, newStatus);
            logger.info(`[DRY RUN] Updated projects_test table: ${projectName} / ${fieldMapping}`);
          }
        }

      } else {
        await SupabaseClient.upsertCustomBlockStatus({
          project_id: projectId,
          block_id: block.id,
          block_name: block.name,
          block_type: block.type,
          status_analysis: newStatus
        });
        const prefix = dryRun ? '[DRY RUN] ' : '';
        logger.info(`${prefix}Updated Status Ninja custom block: ${projectName} / ${block.name}`);
      }
    }
  } catch (error) {
    logger.error('Error saving analysis results:', error);
    throw error;
  }
}

function getStandardFieldMapping(dashboardBlockName: string): string | null {
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
    'animation': 'animation_cult'
  };

  return mapping[dashboardBlockName] || null;
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
    category: 'important' | 'in_progress' | 'approved' | 'dates';
  }

  const changedStatuses: StatusItem[] = [];

  for (const block of blocks) {
    const blockKey = block.id || block.name;
    const newStatus = updates[blockKey];

    if (!newStatus || newStatus.toLowerCase().includes('информация отсутствует')) {
      continue;
    }

    const displayName = block.type === 'standard'
      ? formatStandardBlockName(block.name)
      : block.name;

    const category = categorizeStatus(newStatus);
    changedStatuses.push({ name: displayName, status: newStatus, category });
  }

  if (changedStatuses.length === 0) {
    return dryRun
      ? '[DRY RUN] Нет изменений в статусах'
      : 'Нет изменений в статусах';
  }

  const important = changedStatuses.filter(s => s.category === 'important');
  const approved = changedStatuses.filter(s => s.category === 'approved');
  const dates = changedStatuses.filter(s => s.category === 'dates');
  const inProgress = changedStatuses.filter(s => s.category === 'in_progress');

  const sections: string[] = [];
  const prefix = dryRun ? '[DRY RUN - сохранено в projects_test]\n\n' : '';

  if (format === 'короткий') {
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
  }

  return prefix + sections.join('\n\n');
}

function categorizeStatus(status: string): 'important' | 'in_progress' | 'approved' | 'dates' {
  const lowerStatus = status.toLowerCase();

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

function formatStandardBlockName(blockName: string): string {
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
