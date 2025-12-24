import { logger } from '../utils/logger';
import { SupabaseClient } from '../database/supabase';
import { AIServiceClient } from '../services/ai-client';

/**
 * Main orchestrator for Status Update workflow
 * This replaces the massive n8n Status Update workflow (8240 lines)
 *
 * Returns: Updates map { projectId: updateText } for notifications
 */
export async function runStatusUpdate(): Promise<Record<number, string>> {
  const DRY_RUN = process.env.DRY_RUN === 'true';

  if (DRY_RUN) {
    logger.info('🧪 DRY RUN MODE: Changes will NOT be saved to database');
  }

  logger.info('🚀 Starting status update workflow...');

  const updatesMap: Record<number, string> = {};

  try {
    // 1. Get all chats
    const chats = await SupabaseClient.getAllChats();
    const systemSettings = await SupabaseClient.getSystemSettings();
    const messageLimit = systemSettings.number_of_new_messages || 50;

    logger.info(`Found ${chats.length} chats to process`);

    // 2. Process each chat
    for (const chat of chats) {
      const updates = await processChat(chat, messageLimit, DRY_RUN);

      if (updates) {
        updatesMap[chat.project_id] = updates;
      }
    }

    // 3. Check if we need to run again
    const updatedSettings = await SupabaseClient.getSystemSettings();
    if (updatedSettings.one_more_update) {
      logger.info('⚠️ one_more_update flag is true, will need another run');
    }

    logger.info('✅ Status update workflow completed');

    return updatesMap;

  } catch (error) {
    logger.error('❌ Error in runStatusUpdate:', error);
    throw error;
  }
}

async function processChat(chat: any, messageLimit: number, dryRun: boolean = false): Promise<string | null> {
  try {
    const chatId = chat.telegram_chat_id.toString();
    const projectId = chat.project_id;

    logger.info(`📝 Processing chat ${chatId} for project ${projectId}`);

    // Get unanalyzed messages
    const messages = await SupabaseClient.getUnanalyzedMessages(chatId, messageLimit);

    if (messages.length === 0) {
      logger.info(`No new messages in chat ${chatId}`);
      return null;
    }

    logger.info(`Found ${messages.length} messages in chat ${chatId}`);

    // Get project details
    const project = await SupabaseClient.getProject(projectId);

    if (!project) {
      logger.warn(`Project ${projectId} not found`);
      return null;
    }

    // Prepare conversation text
    const conversationText = messages
      .map((m: any) => `[${m.sender_id}]: ${m.message_text}`)
      .join('\n\n');

    // Call AI service to analyze all project stages
    // This replaces the 19 LLM chains from n8n
    logger.info(`🤖 Calling AI service to analyze project ${project.project_name}...`);

    const analysisResults = await AIServiceClient.analyzeProjectStatus({
      projectId,
      projectName: project.project_name,
      currentStatus: project,
      conversation: conversationText
    });

    if (dryRun) {
      // DRY RUN: Показываем что изменилось бы, но НЕ сохраняем
      logger.info(`🧪 [DRY RUN] Would update project ${projectId}:`);
      logger.info(JSON.stringify(analysisResults, null, 2));
      logger.info(`🧪 [DRY RUN] Would mark ${messages.length} messages as analyzed`);
    } else {
      // Реальное сохранение: Update project fields in database
      await SupabaseClient.updateProjectFields(projectId, analysisResults);

      // Mark messages as analyzed
      const messageIds = messages.map((m: any) => m.message_id);
      await SupabaseClient.markMessagesAsAnalyzed(messageIds);
    }

    logger.info(`✅ Completed processing chat ${chatId}`);

    // Format update text for notification
    const updateText = formatUpdateText(project, analysisResults, dryRun);
    return updateText;

  } catch (error) {
    logger.error(`❌ Error processing chat ${chat.telegram_chat_id}:`, error);
    return null;
  }
}

/**
 * Format update text for producer notification
 */
function formatUpdateText(project: any, updates: any, dryRun: boolean = false): string {
  const changedFields = [];

  // Check which fields changed
  const fields = Object.keys(updates);

  for (const field of fields) {
    if (updates[field] && updates[field] !== project[field]) {
      changedFields.push(`• ${formatFieldName(field)}: ${updates[field]}`);
    }
  }

  if (changedFields.length === 0) {
    return dryRun
      ? '🧪 [DRY RUN] Нет изменений в статусах'
      : 'Нет изменений в статусах';
  }

  const prefix = dryRun ? '🧪 [DRY RUN - НЕ СОХРАНЕНО В БД]\n\n' : '';
  return prefix + changedFields.join('\n');
}

/**
 * Format field name for display
 */
function formatFieldName(field: string): string {
  const names: Record<string, string> = {
    doc: 'Договор',
    act: 'Акт',
    storyboard_client: 'Раскадровка (клиент)',
    storyboard_cult: 'Раскадровка (Cult)',
    aigen_client: 'AI-генерации (клиент)',
    aigen_cult: 'AI-генерации (Cult)',
    casting_client: 'Кастинг (клиент)',
    casting_cult: 'Кастинг (Cult)',
    clothes_client: 'Одежда (клиент)',
    clothes_cult: 'Одежда (Cult)',
    props_client: 'Реквизит (клиент)',
    props_cult: 'Реквизит (Cult)',
    location_client: 'Локации (клиент)',
    location_cult: 'Локации (Cult)',
    animatic_client: 'Аниматик (клиент)',
    animatic_cult: 'Аниматик (Cult)',
    modelling_client: 'Моделирование (клиент)',
    modelling_cult: 'Моделирование (Cult)',
    styleshots_client: 'Стайлшоты (клиент)',
    styleshots_cult: 'Стайлшоты (Cult)',
    animation_client: 'Анимация (клиент)',
    animation_cult: 'Анимация (Cult)',
    editing_client: 'Монтаж (клиент)',
    editing_cult: 'Монтаж (Cult)',
    music_client: 'Музыка (клиент)',
    music_cult: 'Музыка (Cult)',
    vo_client: 'Войсовер (клиент)',
    vo_cult: 'Войсовер (Cult)',
    colorgrading_client: 'Цветокор (клиент)',
    colorgrading_cult: 'Цветокор (Cult)',
    photos_client: 'Фото (клиент)',
    photos_cult: 'Фото (Cult)',
    cg_client: 'CG (клиент)',
    cg_cult: 'CG (Cult)',
  };

  return names[field] || field;
}
