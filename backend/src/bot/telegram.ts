import { Telegraf } from 'telegraf';
import { logger } from '../utils/logger';
import { getSmartBot } from './smart-bot';
import { setupMessageCollector } from '../workflows/collect-messages';

/**
 * Telegram Bots Setup
 *
 * Bot 1 (Silent Bot): Собирает сообщения из чатов проектов
 * Bot 2 (Smart Bot): Анализирует, общается, отправляет уведомления
 */

const silentBotToken = process.env.TELEGRAM_BOT_TOKEN!;
const smartBotToken = process.env.TELEGRAM_PRODUCER_BOT_TOKEN!;

if (!silentBotToken) {
  throw new Error('TELEGRAM_BOT_TOKEN is required for Silent Bot');
}

if (!smartBotToken) {
  throw new Error('TELEGRAM_PRODUCER_BOT_TOKEN is required for Smart Bot');
}

// Bot 1: Silent Bot (молчаливый)
export const silentBot = new Telegraf(silentBotToken);

// Setup Silent Bot handlers

// Приветствие при добавлении бота в группу или когда кто-то вступает
silentBot.on('new_chat_members', async (ctx) => {
  try {
    const newMembers = ctx.message.new_chat_members;
    const botInfo = await ctx.telegram.getMe();

    // Проверяем, добавили ли бота в группу
    const botAdded = newMembers?.some(member => member.id === botInfo.id);

    if (botAdded) {
      // Бот был добавлен в группу - отправляем приветствие
      const welcomeText =
        'Привет! Я — бот Статус Ниндзя 🥷\n' +
        'Читаю проектные чаты и собираю статусы, дедлайны и риски,\n' +
        'чтобы вам не приходилось выяснять, что происходит.\n\n' +
        'Я обрабатываю Telegram ID, имя и сообщения в чате в соответствии с законодательством. ' +
        'Серверы находятся в России и после проекта данные удаляются.\n\n' +
        'Оставаясь здесь, вы соглашаетесь с [политикой](https://drive.google.com/file/d/1Mkrxyt6un8yDYt9qaui7O0IVR2tV1DP9/view) ' +
        'обработки персональных данных.\n' +
        'Удалить меня можно через продюсера.';

      await ctx.reply(welcomeText, { parse_mode: 'Markdown' });
      logger.info(`Silent Bot added to chat ${ctx.chat.id}, sent welcome message`);
    } else if (newMembers && newMembers.length > 0) {
      // Другие люди вступили в группу - отправляем приветствие им
      const welcomeText =
        'Привет! Я — бот Статус Ниндзя 🥷\n' +
        'Читаю проектные чаты и собираю статусы, дедлайны и риски,\n' +
        'чтобы вам не приходилось выяснять, что происходит.\n\n' +
        'Я обрабатываю Telegram ID, имя и сообщения в чате в соответствии с законодательством. ' +
        'Серверы находятся в России и после проекта данные удаляются.\n\n' +
        'Оставаясь здесь, вы соглашаетесь с [политикой](https://drive.google.com/file/d/1Mkrxyt6un8yDYt9qaui7O0IVR2tV1DP9/view) ' +
        'обработки персональных данных.\n' +
        'Удалить меня можно через продюсера.';

      await ctx.reply(welcomeText, { parse_mode: 'Markdown' });
      logger.info(`New members joined chat ${ctx.chat.id}, sent welcome message`);
    }
  } catch (error) {
    logger.error('Error in new_chat_members handler:', error);
  }
});

silentBot.help((ctx) => {
  ctx.reply(
    'Я автоматически собираю сообщения из этого чата для анализа статусов проекта.\n' +
    'Просто общайтесь как обычно, я всё записываю. 📝'
  );
});

// Setup message collection
setupMessageCollector(silentBot);

// Bot 2: Smart Bot (умный)
export const smartBot = getSmartBot(smartBotToken);

export async function startTelegramBots() {
  try {
    // Graceful shutdown handlers
    process.once('SIGINT', () => {
      silentBot.stop('SIGINT');
      smartBot.getBot().stop('SIGINT');
    });

    process.once('SIGTERM', () => {
      silentBot.stop('SIGTERM');
      smartBot.getBot().stop('SIGTERM');
    });

    // Start Silent Bot (работает в фоне)
    logger.info('🤖 Starting Silent Bot...');
    silentBot.launch().then(() => {
      logger.info('✅ Silent Bot (Bot 1) polling started');
    }).catch((error) => {
      logger.error('❌ Silent Bot failed:', error);
    });

    // Start Smart Bot (используем его launch метод)
    logger.info('🤖 Starting Smart Bot...');
    smartBot.launch().then(() => {
      logger.info('✅ Smart Bot (Bot 2) polling started');
    }).catch((error) => {
      logger.error('❌ Smart Bot failed:', error);
    });

    // Даём ботам время на инициализацию
    await new Promise(resolve => setTimeout(resolve, 1000));

    logger.info('✅ Telegram bots launched');

  } catch (error) {
    logger.error('Failed to start Telegram bots:', error);
    throw error;
  }
}
