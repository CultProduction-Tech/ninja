import cron from 'node-cron';
import { logger } from '../utils/logger';
import { SupabaseClient } from '../database/supabase';
import { runStatusUpdate } from './orchestrator';
import { getSmartBot } from '../bot/smart-bot';

export function startScheduler() {
  // Default: every 8 hours
  const cronSchedule = process.env.STATUS_UPDATE_CRON || '0 */8 * * *';

  logger.info(`Scheduler started with cron: ${cronSchedule}`);

  cron.schedule(cronSchedule, async () => {
    logger.info('⏰ Scheduled status update triggered');
    await checkAndTriggerUpdate();
  });
}

export async function checkAndTriggerUpdate() {
  try {
    logger.info('🔍 Checking for new messages to analyze...');

    // Reset the "one_more_update" flag
    await SupabaseClient.updateSystemFlag('one_more_update', false);

    // Get all chats
    const chats = await SupabaseClient.getAllChats();
    const systemSettings = await SupabaseClient.getSystemSettings();
    const messageLimit = systemSettings.number_of_new_messages || 50;

    let needsAnotherRun = false;
    let totalUnanalyzed = 0;

    // Check each chat for new messages
    for (const chat of chats) {
      const unanalyzedMessages = await SupabaseClient.getUnanalyzedMessages(
        chat.telegram_chat_id,
        1000 // Get all to count
      );

      totalUnanalyzed += unanalyzedMessages.length;

      logger.info(
        `Chat ${chat.telegram_chat_id}: ${unanalyzedMessages.length} unanalyzed messages`
      );

      // If more messages than limit, we'll need another run
      if (unanalyzedMessages.length > messageLimit) {
        needsAnotherRun = true;
      }
    }

    if (totalUnanalyzed === 0) {
      logger.info('✅ No new messages to analyze');
      return;
    }

    logger.info(`📊 Total unanalyzed messages: ${totalUnanalyzed}`);

    // Set flag if another run is needed
    if (needsAnotherRun) {
      await SupabaseClient.updateSystemFlag('one_more_update', true);
      logger.info('⚠️ Set one_more_update=true - will need another run after this');
    }

    // Trigger the main status update workflow
    const updates = await runStatusUpdate();

    // Send notifications to producers via Smart Bot
    if (updates && Object.keys(updates).length > 0) {
      const smartBot = getSmartBot();
      await smartBot.notifyAllProducers(updates);
      logger.info('✅ Sent notifications to producers');
    }

    logger.info('✅ Status update completed');

  } catch (error) {
    logger.error('❌ Error in checkAndTriggerUpdate:', error);
    throw error;
  }
}
