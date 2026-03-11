import cron from 'node-cron';
import { logger } from '../utils/logger';
import { SupabaseClient } from '../database/supabase';
import { AIServiceClient } from '../services/ai-client';
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

  // Глоссарий: автообновление 1-го числа каждого месяца в 03:00
  cron.schedule('0 3 1 * *', async () => {
    logger.info('Monthly glossary auto-discovery triggered');
    await runGlossaryDiscovery();
  });
}

export async function runGlossaryDiscovery() {
  try {
    const projects = await SupabaseClient.getAllProjects();
    logger.info(`Glossary discovery: processing ${projects.length} projects`);

    let totalNew = 0;

    for (const project of projects) {
      try {
        if (project.status === 'finished') {
          logger.info(`Glossary: skipping finished project ${project.project_name}`);
          continue;
        }

        const messages = await SupabaseClient.getLastMessagesForProject(project.project_id, 200);

        if (messages.length < 10) {
          logger.info(`Glossary: skipping ${project.project_name} — too few messages (${messages.length})`);
          continue;
        }

        const conversationText = await SupabaseClient.formatConversationWithRoles(messages);

        const result = await AIServiceClient.discoverGlossaryTerms({
          conversation: conversationText,
          projectName: project.project_name
        });

        totalNew += result.newTermsAdded;
        logger.info(`Glossary: ${project.project_name} — found ${result.discovered.length}, new: ${result.newTermsAdded}`);

        // Пауза между проектами чтобы не перегружать AI
        await new Promise(resolve => setTimeout(resolve, 2000));
      } catch (projError) {
        logger.error(`Glossary discovery error for ${project.project_name}:`, projError);
      }
    }

    logger.info(`Glossary discovery complete: ${totalNew} new terms added across all projects`);

    // Уведомляем админа если найдены новые термины
    if (totalNew > 0) {
      try {
        const adminTgId = process.env.TEST_TELEGRAM_ID || '489599665';
        const smartBot = getSmartBot();
        await smartBot.sendDirectMessage(
          adminTgId,
          `📚 Глоссарий обновлён автоматически!\n\n` +
          `Найдено новых терминов: ${totalNew}\n` +
          `Используйте /admin_glossary для просмотра и одобрения.`
        );
      } catch (notifyError) {
        logger.warn('Failed to notify admin about glossary update:', notifyError);
      }
    }
  } catch (error) {
    logger.error('Error in glossary discovery:', error);
  }
}

export async function checkAndTriggerUpdate() {
  try {
    logger.info('Checking for new messages to analyze...');

    await SupabaseClient.updateSystemFlag('one_more_update', false);

    const chats = await SupabaseClient.getAllChats();
    const systemSettings = await SupabaseClient.getSystemSettings();
    const messageLimit = systemSettings.number_of_new_messages || 200;

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
