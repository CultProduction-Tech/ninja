import cron from 'node-cron';
import { logger } from '../utils/logger';
import { SupabaseClient } from '../database/supabase';
import { runStatusUpdate } from './orchestrator';
import { getSmartBot } from '../bot/smart-bot';
import { isInQuietHours, checkWeekendPolicy } from '../utils/schedule-helpers';

export function startScheduler() {
  const cronSchedule = process.env.STATUS_UPDATE_CRON || '0 */8 * * *';

  logger.info(`Scheduler started with cron: ${cronSchedule}`);

  cron.schedule(cronSchedule, async () => {
    logger.info('Scheduled status update triggered');
    await checkAndTriggerUpdate();
  });
}

export async function checkAndTriggerUpdate() {
  try {
    logger.info('Checking for new messages to analyze...');

    await SupabaseClient.updateSystemFlag('one_more_update', false);

    const chats = await SupabaseClient.getAllChats();
    const systemSettings = await SupabaseClient.getSystemSettings();
    const messageLimit = systemSettings.number_of_new_messages || 50;

    let needsAnotherRun = false;
    let totalUnanalyzed = 0;

    for (const chat of chats) {
      const unanalyzedMessages = await SupabaseClient.getUnanalyzedMessages(
        chat.telegram_chat_id,
        1000
      );

      totalUnanalyzed += unanalyzedMessages.length;

      logger.info(
        `Chat ${chat.telegram_chat_id}: ${unanalyzedMessages.length} unanalyzed messages`
      );

      if (unanalyzedMessages.length > messageLimit) {
        needsAnotherRun = true;
      }
    }

    if (totalUnanalyzed === 0) {
      logger.info('No new messages to analyze');
      return;
    }

    logger.info(`Total unanalyzed messages: ${totalUnanalyzed}`);

    if (needsAnotherRun) {
      await SupabaseClient.updateSystemFlag('one_more_update', true);
      logger.info('Set one_more_update=true - will need another run after this');
    }

    const updates = await runStatusUpdate();

    if (updates && Object.keys(updates).length > 0) {
      // Фильтруем проекты в тихих часах или с выключенными выходными
      const filteredUpdates: Record<number, string> = {};
      for (const [projectIdStr, updateText] of Object.entries(updates)) {
        const projectId = Number(projectIdStr);
        const settings = await SupabaseClient.getClientSettings(projectId);

        if (isInQuietHours(settings.quiet_from, settings.quiet_to)) {
          logger.info(`Project ${projectId}: Skipping notification - quiet hours`);
          continue;
        }

        const weekendPolicy = checkWeekendPolicy(settings.weekend);
        if (weekendPolicy.blocked) {
          logger.info(`Project ${projectId}: Skipping notification - weekends disabled`);
          continue;
        }

        filteredUpdates[projectId] = updateText as string;
      }

      if (Object.keys(filteredUpdates).length > 0) {
        const smartBot = getSmartBot();
        await smartBot.notifyAllProducers(filteredUpdates);
        logger.info('Sent notifications to producers');
      } else {
        logger.info('All notifications filtered out (quiet hours / weekends)');
      }
    }

    logger.info('Status update completed');

  } catch (error) {
    logger.error('Error in checkAndTriggerUpdate:', error);
    throw error;
  }
}
