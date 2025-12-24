import { logger } from '../utils/logger';
import { SupabaseClient } from '../database/supabase';
import { DashboardClient, DashboardBlock } from '../database/dashboard-supabase';
import { AIServiceClient } from '../services/ai-client';

/**
 * Main orchestrator for Status Update workflow
 * NEW: Dynamic blocks from Dashboard
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

    // 🆕 Get active blocks from Dashboard
    const activeBlocks = await DashboardClient.getActiveBlocks(project.project_name);

    if (activeBlocks.length === 0) {
      logger.warn(`No active blocks found for project ${project.project_name}`);
      return null;
    }

    logger.info(`📊 Found ${activeBlocks.length} active blocks for ${project.project_name}:`);
    activeBlocks.forEach(block => {
      logger.info(`  - ${block.name} (${block.type})`);
    });

    // Prepare conversation text
    const conversationText = messages
      .map((m: any) => `[${m.sender_id}]: ${m.message_text}`)
      .join('\n\n');

    // 🆕 Call AI service to analyze ONLY active blocks
    logger.info(`🤖 Calling AI service to analyze ${activeBlocks.length} blocks for ${project.project_name}...`);

    const analysisResults = await AIServiceClient.analyzeDynamicBlocks({
      projectId,
      projectName: project.project_name,
      blocks: activeBlocks,
      conversation: conversationText
    });

    if (dryRun) {
      // DRY RUN: Show what would change
      logger.info(`🧪 [DRY RUN] Would update project ${projectId}:`);
      logger.info(JSON.stringify(analysisResults, null, 2));
      logger.info(`🧪 [DRY RUN] Would mark ${messages.length} messages as analyzed`);
    } else {
      // 🆕 Save results to both databases
      await saveAnalysisResults(projectId, project.project_name, activeBlocks, analysisResults);

      // Mark messages as analyzed
      const messageIds = messages.map((m: any) => m.message_id);
      await SupabaseClient.markMessagesAsAnalyzed(messageIds);
    }

    logger.info(`✅ Completed processing chat ${chatId}`);

    // Format update text for notification
    const updateText = formatUpdateText(activeBlocks, analysisResults, dryRun);
    return updateText;

  } catch (error) {
    logger.error(`❌ Error processing chat ${chat.telegram_chat_id}:`, error);
    return null;
  }
}

/**
 * 🆕 Save analysis results to both databases
 */
async function saveAnalysisResults(
  projectId: number,
  projectName: string,
  blocks: DashboardBlock[],
  analysisResults: Record<string, string>
) {
  try {
    for (const block of blocks) {
      const blockKey = block.id || block.name; // Use ID for custom, name for standard
      const newStatus = analysisResults[blockKey];

      if (!newStatus) continue;

      if (block.type === 'standard') {
        // Standard block: Save to Status Ninja projects table (old fields)
        const fieldMapping = getStandardFieldMapping(block.name);

        if (fieldMapping) {
          await SupabaseClient.updateProjectField(projectId, fieldMapping, newStatus);
          logger.info(`✅ Updated Status Ninja: ${projectName} / ${fieldMapping}`);
        }

        // Also update Dashboard
        await DashboardClient.updateStandardBlockStatus(projectName, block.name, newStatus);

      } else {
        // Custom block: Save to Status Ninja custom_block_statuses table
        await SupabaseClient.upsertCustomBlockStatus({
          project_id: projectId,
          block_id: block.id!,
          block_name: block.name,
          block_type: block.type,
          status_analysis: newStatus
        });
        logger.info(`✅ Updated Status Ninja custom block: ${projectName} / ${block.name}`);

        // Also update Dashboard
        await DashboardClient.updateCustomBlockStatus(
          projectName,
          block.id!,
          block.type as 'custom_pre' | 'custom_post',
          newStatus
        );
      }
    }
  } catch (error) {
    logger.error('Error saving analysis results:', error);
    throw error;
  }
}

/**
 * 🆕 Map standard block names from Dashboard to Status Ninja field names
 */
function getStandardFieldMapping(dashboardBlockName: string): string | null {
  const mapping: Record<string, string> = {
    'documents': 'doc',
    'storyboard': 'storyboard_cult', // Default to cult, can be improved later
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

/**
 * 🆕 Format update text for producer notification (dynamic blocks)
 * Structured format with categories and emojis
 */
function formatUpdateText(blocks: DashboardBlock[], updates: Record<string, string>, dryRun: boolean = false): string {
  interface StatusItem {
    name: string;
    status: string;
    category: 'important' | 'in_progress' | 'approved' | 'dates';
  }

  const changedStatuses: StatusItem[] = [];

  // Collect all changed statuses
  for (const block of blocks) {
    const blockKey = block.id || block.name;
    const newStatus = updates[blockKey];

    if (newStatus && newStatus !== block.currentStatus) {
      const displayName = block.type === 'standard'
        ? formatStandardBlockName(block.name)
        : block.name;

      const category = categorizeStatus(newStatus);
      changedStatuses.push({ name: displayName, status: newStatus, category });
    }
  }

  if (changedStatuses.length === 0) {
    return dryRun
      ? '🧪 [DRY RUN] Нет изменений в статусах'
      : 'Нет изменений в статусах';
  }

  // Group by categories
  const important = changedStatuses.filter(s => s.category === 'important');
  const approved = changedStatuses.filter(s => s.category === 'approved');
  const dates = changedStatuses.filter(s => s.category === 'dates');
  const inProgress = changedStatuses.filter(s => s.category === 'in_progress');

  const sections: string[] = [];
  const prefix = dryRun ? '🧪 [DRY RUN - НЕ СОХРАНЕНО В БД]\n\n' : '';

  // Important questions section
  if (important.length > 0) {
    sections.push('❓ Важные вопросы:\n' + important.map(s => `${s.name}: ${s.status}`).join('\n\n'));
  }

  // In progress section
  if (inProgress.length > 0) {
    sections.push('Наши процессы:\n\n' + inProgress.map(s => `📍 ${s.name}\n${s.status}`).join('\n\n'));
  }

  // Approved section
  if (approved.length > 0) {
    sections.push('✅ Согласовано:\n' + approved.map(s => `- ${s.name}`).join('\n'));
  }

  // Important dates section
  if (dates.length > 0) {
    sections.push('‼️ Важные даты и этапы:\n' + dates.map(s => `${s.status}`).join('\n\n'));
  }

  return prefix + sections.join('\n\n');
}

/**
 * Categorize status based on keywords
 */
function categorizeStatus(status: string): 'important' | 'in_progress' | 'approved' | 'dates' {
  const lowerStatus = status.toLowerCase();

  // Important questions (urgent, needs approval, etc.)
  const importantKeywords = [
    'важно', 'необходимо', 'срочно', 'нужно утвердить', 'требуется',
    'критично', 'обязательно', 'должны', 'надо'
  ];

  // Approved/done
  const approvedKeywords = [
    'согласовано', 'утверждено', 'одобрено', 'окнули', 'ок от клиента',
    'подписан', 'готов', 'завершен', 'принято', 'финальн'
  ];

  // Date-related
  const datePattern = /\d{1,2}[.\-\/]\d{1,2}|\d{1,2}\s+(января|февраля|марта|апреля|мая|июня|июля|августа|сентября|октября|ноября|декабря)|PPM|pre-PPM|съемка|презентация/i;

  // Check categories
  if (importantKeywords.some(keyword => lowerStatus.includes(keyword))) {
    return 'important';
  }

  if (approvedKeywords.some(keyword => lowerStatus.includes(keyword))) {
    return 'approved';
  }

  if (datePattern.test(status)) {
    return 'dates';
  }

  // Default: in progress
  return 'in_progress';
}

/**
 * Format standard block names for display
 */
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
