import { logger } from '../utils/logger';
import { getSmartBot } from './smart-bot';

const botToken = process.env.TELEGRAM_BOT_TOKEN!;

if (!botToken) {
  throw new Error('TELEGRAM_BOT_TOKEN is required');
}

export const smartBot = getSmartBot(botToken);

export async function startTelegramBots() {
  try {
    process.once('SIGINT', () => smartBot.getBot().stop('SIGINT'));
    process.once('SIGTERM', () => smartBot.getBot().stop('SIGTERM'));

    logger.info('Starting bot...');
    smartBot.launch().then(() => {
      logger.info('Bot polling started');
    }).catch((error) => {
      logger.error('Bot failed:', error);
    });

    await new Promise(resolve => setTimeout(resolve, 1000));

    logger.info('Telegram bot launched');

  } catch (error) {
    logger.error('Failed to start bot:', error);
    throw error;
  }
}
