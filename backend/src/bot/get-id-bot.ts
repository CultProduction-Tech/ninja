import { Telegraf } from 'telegraf';
import { logger } from '../utils/logger';
import { SupabaseClient } from '../database/supabase';

export function setupGetIdBot() {
  const token = process.env.TELEGRAM_GET_ID_BOT_TOKEN!;
  const bot = new Telegraf(token);

  bot.start((ctx) => {
    ctx.reply(
      'Привет! Перешлите мне любое сообщение от человека, ' +
      'и я верну вам его Telegram ID.'
    );
  });

  // Handle forwarded messages
  bot.on('message', async (ctx) => {
    try {
      const message = ctx.message;

      // Check if message is forwarded
      if ('forward_from' in message && message.forward_from) {
        const forwardedFrom: any = message.forward_from;
        const telegramId = forwardedFrom.id;
        const firstName = forwardedFrom.first_name || '';
        const lastName = forwardedFrom.last_name || '';
        const username = forwardedFrom.username || '';

        // Save to database
        await SupabaseClient.saveMessage({
          telegram_chat_id: ctx.chat.id.toString(),
          sender_id: telegramId.toString(),
          message_text: `ID: ${telegramId}`,
          chat_name_tg: 'Get ID Bot',
          is_analyzed: true
        });

        // Send response
        await ctx.reply(`Telegram ID: ${telegramId}`);

        logger.info(`Get ID Bot: Retrieved ID ${telegramId} for ${firstName} ${lastName}`);

      } else {
        await ctx.reply('Пожалуйста, перешлите сообщение от пользователя.');
      }

    } catch (error) {
      logger.error('Get ID Bot error:', error);
      await ctx.reply('Произошла ошибка при получении ID.');
    }
  });

  return bot;
}
