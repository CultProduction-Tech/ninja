import cron from 'node-cron';
import { logger } from '../utils/logger';
import { SupabaseClient, getDefaultClientSettings } from '../database/supabase';
import { DashboardClient } from '../database/dashboard-supabase';
import { getSmartBot } from '../bot/smart-bot';
import { AIServiceClient } from '../services/ai-client';

/**
 * Status notification scheduler
 * Runs every hour and checks which projects need status updates sent to producers
 * Sends status 1 hour before the client's deadline
 */
export function startStatusScheduler() {
  // Run every hour at minute 0
  const cronSchedule = '0 * * * *';

  logger.info(`Status notification scheduler started with cron: ${cronSchedule}`);

  cron.schedule(cronSchedule, async () => {
    logger.info('⏰ Status notification scheduler triggered');
    await checkAndSendStatusUpdates();
  });
}

/**
 * Check all projects and send status updates if needed
 */
export async function checkAndSendStatusUpdates() {
  try {
    logger.info('🔍 Checking projects for status updates...');

    // Get all projects
    const projects = await SupabaseClient.getAllProjects();

    if (!projects || projects.length === 0) {
      logger.info('No projects found');
      return;
    }

    const now = new Date();
    const currentDay = getDayOfWeek(now); // e.g., "Mon", "Tue"
    const currentHour = now.getHours(); // 0-23 in Moscow time (assumes server is in Moscow timezone)

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

    logger.info(`✅ Status notification check completed. Sent ${sentCount} updates.`);

  } catch (error) {
    logger.error('❌ Error in checkAndSendStatusUpdates:', error);
  }
}

/**
 * Check if status should be sent now for a project
 */
async function shouldSendStatusNow(
  projectId: number,
  currentDay: string,
  currentHour: number
): Promise<boolean> {
  try {
    // Get client settings
    const settings = await SupabaseClient.getClientSettings(projectId);
    const defaults = getDefaultClientSettings();

    const frequencyDays = settings.status_frequency_day || defaults.status_frequency_day;
    const frequencyTime = settings.status_frequency_time || defaults.status_frequency_time;

    // Parse frequency days (e.g., "Mon,Tue,Wed,Thu,Fri")
    const allowedDays = frequencyDays.split(',').map((d: string) => d.trim());

    // Check if today is allowed
    if (!allowedDays.includes(currentDay)) {
      return false;
    }

    // Parse time (format: "10:00:00+03")
    const timeMatch = frequencyTime.match(/^(\d{1,2}):(\d{2})/);
    if (!timeMatch) {
      logger.error(`Invalid time format: ${frequencyTime}`);
      return false;
    }

    const deadlineHour = parseInt(timeMatch[1], 10);

    // Send 1 hour before deadline
    const sendHour = deadlineHour - 1;

    if (currentHour === sendHour) {
      logger.info(`✅ Project ${projectId}: Time to send (${currentHour}:00, deadline at ${deadlineHour}:00)`);
      return true;
    }

    return false;

  } catch (error) {
    logger.error(`Error in shouldSendStatusNow for project ${projectId}:`, error);
    return false;
  }
}

/**
 * Send status update to producer for a project
 * (called from scheduler)
 */
async function sendStatusToProducer(project: any) {
  try {
    logger.info(`📤 Sending status update for project ${project.project_id}: ${project.project_name}`);

    // 🚨 TESTING MODE: Only send to admin
    const TEST_MODE = process.env.TEST_MODE === 'true';
    const TEST_TELEGRAM_ID = process.env.TEST_TELEGRAM_ID || '489599665';

    // Get client settings to determine format
    const clientSettings = await SupabaseClient.getClientSettings(project.project_id);
    const format = clientSettings.format_status || 'длинный';

    // Get active blocks from Dashboard
    const activeBlocks = await DashboardClient.getActiveBlocks(project.project_name);

    if (activeBlocks.length === 0) {
      logger.warn(`No active blocks found for project ${project.project_name}`);
      return;
    }

    // Get project data from Status Ninja (for standard blocks)
    const projectData = await SupabaseClient.getProject(project.project_id);

    // Get custom block statuses from Status Ninja (for custom blocks)
    let customStatuses = await SupabaseClient.getCustomBlockStatuses(project.project_id);

    // Check if we need to analyze custom blocks on-demand
    const customBlocks = activeBlocks.filter(b => b.type !== 'standard');
    if (customBlocks.length > 0) {
      // Check if we have statuses for all custom blocks
      const missingBlocks = customBlocks.filter(block =>
        !customStatuses.find(s => s.block_id === block.id && s.status_analysis)
      );

      if (missingBlocks.length > 0) {
        logger.info(`🔍 Missing statuses for ${missingBlocks.length} custom blocks, analyzing on-demand...`);

        // Analyze missing custom blocks
        const newStatuses = await analyzeCustomBlocksOnDemand(project, missingBlocks);

        // Merge with existing statuses
        customStatuses = [...customStatuses, ...newStatuses];
      }
    }

    // Format current statuses
    const statusMap: Record<string, string> = {};
    for (const block of activeBlocks) {
      const blockKey = block.id || block.name;

      if (block.type !== 'standard') {
        // CUSTOM BLOCKS: Read from custom_block_statuses table
        const customStatus = customStatuses.find(s => s.block_id === block.id);
        if (customStatus && customStatus.status_analysis) {
          statusMap[blockKey] = customStatus.status_analysis;
        }
      } else {
        // STANDARD BLOCKS: Read from projects table (fields like doc, storyboard_cult, etc.)
        const fieldName = getStandardFieldMapping(block.name);
        if (fieldName && projectData && projectData[fieldName]) {
          statusMap[blockKey] = projectData[fieldName];
        }
      }
    }

    // Format the status message
    let updateText = formatStatusForClient(activeBlocks, statusMap, format);

    // Determine recipient
    let recipientTgId: string;
    let recipientInfo: string;

    if (TEST_MODE) {
      // TEST MODE: Always send to admin
      recipientTgId = TEST_TELEGRAM_ID;
      recipientInfo = `admin ${TEST_TELEGRAM_ID} (TEST MODE)`;

      // Add test mode prefix
      const producerName = project.producer?.producer_name || 'Неизвестный продюсер';
      const testPrefix = `🧪 [TEST MODE]\n📧 Продюсер: ${producerName}\n\n`;
      updateText = testPrefix + updateText;

      logger.info(`🧪 TEST MODE: Sending status to ${recipientInfo} instead of producer`);
    } else {
      // NORMAL MODE: Send to actual producer
      if (!project.producer || !project.producer.producer_tg_chat_id) {
        logger.warn(`No producer found for project ${project.project_id}`);
        return;
      }
      recipientTgId = project.producer.producer_tg_chat_id.toString();
      recipientInfo = `producer ${recipientTgId}`;
    }

    // Send via Smart Bot
    const smartBot = getSmartBot();
    await smartBot.notifyProducer(
      recipientTgId,
      project.project_name,
      updateText
    );

    logger.info(`✅ Sent status update for project ${project.project_name} to ${recipientInfo}`);

  } catch (error) {
    logger.error(`Error sending status for project ${project.project_id}:`, error);
  }
}

/**
 * Analyze custom blocks on-demand when statuses are missing
 * Takes last 100 messages and analyzes only custom blocks
 */
async function analyzeCustomBlocksOnDemand(project: any, customBlocks: any[]): Promise<any[]> {
  try {
    logger.info(`🔍 Analyzing ${customBlocks.length} custom blocks on-demand for project ${project.project_id}`);

    // Get last 100 messages from ALL chats of this project (increased from 50)
    const messages = await SupabaseClient.getLastMessagesForProject(project.project_id, 100);

    if (messages.length === 0) {
      logger.info(`No messages found in chats for project ${project.project_id}`);
      return [];
    }

    logger.info(`Found ${messages.length} messages from all project chats for analysis`);

    // Prepare conversation text with user roles (NEW: Продюсер/Клиент/Команда)
    logger.info(`🔄 Formatting ${messages.length} messages with user roles...`);
    const conversationText = await SupabaseClient.formatConversationWithRoles(messages);

    // Call AI service to analyze ONLY custom blocks
    const analysisResults = await AIServiceClient.analyzeDynamicBlocks({
      projectId: project.project_id,
      projectName: project.project_name,
      blocks: customBlocks,
      conversation: conversationText
    });

    logger.info(`✅ AI analysis completed for ${customBlocks.length} custom blocks`);

    // Save results to custom_block_statuses
    const savedStatuses = [];
    for (const block of customBlocks) {
      const blockKey = block.id || block.name;
      const newStatus = analysisResults[blockKey];

      if (newStatus) {
        // Save to database
        await SupabaseClient.upsertCustomBlockStatus({
          project_id: project.project_id,
          block_id: block.id!,
          block_name: block.name,
          block_type: block.type,
          status_analysis: newStatus
        });

        logger.info(`✅ Saved status for custom block: ${block.name}`);

        // Add to returned array
        savedStatuses.push({
          project_id: project.project_id,
          block_id: block.id,
          block_name: block.name,
          block_type: block.type,
          status_analysis: newStatus
        });
      }
    }

    logger.info(`✅ Saved ${savedStatuses.length} custom block statuses`);
    return savedStatuses;

  } catch (error) {
    logger.error(`Error in analyzeCustomBlocksOnDemand:`, error);
    return [];
  }
}

/**
 * Map standard block names from Dashboard to Status Ninja field names
 * EXPORTED for use in admin commands
 */
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
    'animation': 'animation_cult'
  };

  return mapping[dashboardBlockName] || null;
}

/**
 * Format status for client (called from scheduler)
 * EXPORTED for use in admin commands
 */
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

  // Group by categories
  const important = statuses.filter(s => s.category === 'important');
  const approved = statuses.filter(s => s.category === 'approved');
  const dates = statuses.filter(s => s.category === 'dates');
  const inProgress = statuses.filter(s => s.category === 'in_progress');
  const noInfo = statuses.filter(s => s.category === 'no_info');

  const sections: string[] = [];

  if (format === 'короткий') {
    // SHORT FORMAT
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

    // Add "No info" section at the end
    if (noInfo.length > 0) {
      sections.push('📋 Нет информации:\n' + noInfo.map(s => `- ${s.name}`).join('\n'));
    }

  } else {
    // LONG FORMAT
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

    // Add "No info" section at the end
    if (noInfo.length > 0) {
      sections.push('📋 Нет информации:\n' + noInfo.map(s => `- ${s.name}`).join('\n'));
    }
  }

  return sections.join('\n\n');
}

/**
 * Categorize status based on keywords
 */
function categorizeStatus(status: string): 'important' | 'in_progress' | 'approved' | 'dates' | 'no_info' {
  const lowerStatus = status.toLowerCase();

  // Check for "no info" first
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

/**
 * Format standard block names for display
 * EXPORTED for use in admin commands
 */
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

/**
 * Get current day of week in format "Mon", "Tue", etc.
 */
function getDayOfWeek(date: Date): string {
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  return days[date.getDay()];
}

/**
 * ADMIN: Send status to producer immediately (for testing)
 * This is exported for use in admin commands
 */
export async function sendStatusToProducerAdmin(project: any) {
  await sendStatusToProducer(project);
}
