import { Telegraf, Context } from 'telegraf';
import { logger } from '../utils/logger';
import { SupabaseClient } from '../database/supabase';

export function setupMessageCollector(bot: Telegraf) {
  bot.on('message', async (ctx: Context) => {
    try {
      if (!ctx.message || !('text' in ctx.message)) return;

      const message = ctx.message;
      const chatId = message.chat.id.toString();
      const senderId = message.from.id.toString();
      const messageText = extractMessageWithLinks(message);
      const chatName = 'title' in message.chat ? message.chat.title : 'Private';

      await SupabaseClient.saveMessage({
        telegram_chat_id: chatId,
        sender_id: senderId,
        message_text: messageText,
        chat_name_tg: chatName || '',
        is_analyzed: false
      });

      logger.info(`Message collected from chat ${chatId}`);

      if ('new_chat_member' in message) {
        await sendWelcomeMessage(ctx);
      }

    } catch (error) {
      logger.error('Error collecting message:', error);
    }
  });
}

function extractMessageWithLinks(message: any): string {
  const text = message.text || '';
  const entities = message.entities || [];

  const links: string[] = [];

  entities.forEach((entity: any) => {
    if (entity.type === 'url') {
      const url = text.substring(entity.offset, entity.offset + entity.length);
      links.push(url);
    } else if (entity.type === 'text_link') {
      links.push(entity.url);
    }
  });

  let fullText = text;
  if (links.length > 0) {
    fullText += '\n\nСсылки:\n' + links.join('\n');
  }

  return fullText;
}

async function sendWelcomeMessage(ctx: Context) {
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
}
