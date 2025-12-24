import { Telegraf, Context } from 'telegraf';
import { logger } from '../utils/logger';
import { AIServiceClient } from '../services/ai-client';
import { SupabaseClient } from '../database/supabase';
import { runStatusUpdate } from '../workflows/orchestrator';

/**
 * Smart Bot (Бот 2)
 *
 * Функции:
 * 1. Анализирует сообщения по таймеру (через scheduler)
 * 2. Проставляет статусы в БД
 * 3. Отправляет уведомления продюсерам
 * 4. Общается с продюсерами и клиентами (чат с памятью)
 * 5. Различает продюсеров и клиентов
 * 6. Ищет проекты и отвечает на вопросы
 */
export class SmartBot {
  private bot: Telegraf;

  constructor(token: string) {
    this.bot = new Telegraf(token);
    this.setupHandlers();
  }

  private setupHandlers() {
    // Start command
    this.bot.start(async (ctx) => {
      try {
        const userId = ctx.from.id.toString();
        logger.info(`📩 Smart Bot: /start from user ${userId}`);

        const userType = await this.getUserType(userId);
        logger.info(`👤 User ${userId} type: ${userType}`);

        if (userType === 'producer') {
          ctx.reply(
          'Привет! Я — умный бот Статус Ниндзя 🥷\n\n' +
          'Я автоматически анализирую чаты проектов и могу:\n' +
          '• Отвечать на вопросы о статусах проектов\n' +
          '• Искать информацию по проектам\n' +
          '• Уведомлять об обновлениях\n\n' +
          'Команды:\n' +
          '/analyze - запустить анализ вручную\n' +
          '/status - показать статусы проектов\n\n' +
          'Просто задавай вопросы!'
        );
      } else if (userType === 'client') {
        ctx.reply(
          'Здравствуйте! Я — бот для отслеживания статусов проектов.\n\n' +
          'Вы можете задавать мне вопросы о вашем проекте, и я постараюсь помочь.\n\n' +
          'Команда /status покажет статусы ваших проектов.'
        );
      } else {
        ctx.reply(
          'Привет! Я не могу определить ваш статус (продюсер/клиент).\n' +
          'Пожалуйста, свяжитесь с администратором.'
        );
      }
      } catch (error) {
        logger.error('❌ Error in /start handler:', error);
        ctx.reply('Произошла ошибка. Попробуйте позже.');
      }
    });

    // Admin commands (only for producers)
    this.bot.command('analyze', async (ctx) => {
      try {
        const userId = ctx.from.id.toString();
        logger.info(`📩 Smart Bot: /analyze from user ${userId}`);

        const userType = await this.getUserType(userId);

        if (userType !== 'producer') {
          ctx.reply('У вас нет доступа к этой команде.');
          return;
        }

        const DRY_RUN = process.env.DRY_RUN === 'true';

        if (DRY_RUN) {
          ctx.reply('🧪 Запускаю анализ статусов в режиме DRY RUN...\n(Данные в БД НЕ будут изменены) ⏳');
        } else {
          ctx.reply('Запускаю анализ статусов... ⏳');
        }

        const updates = await runStatusUpdate();

        // Send notifications to producers
        if (updates && Object.keys(updates).length > 0) {
          await this.notifyAllProducers(updates);

          if (DRY_RUN) {
            ctx.reply('✅ Анализ завершен!\n🧪 DRY RUN: Изменения НЕ сохранены в БД.\n✉️ Уведомления отправлены!');
          } else {
            ctx.reply('✅ Анализ завершен! Статусы обновлены.\n✉️ Уведомления отправлены!');
          }
        } else {
          ctx.reply('✅ Анализ завершен. Новых обновлений нет.');
        }
      } catch (error) {
        logger.error('❌ Error in /analyze:', error);
        ctx.reply('❌ Ошибка при анализе. Проверьте логи.');
      }
    });

    this.bot.command('status', async (ctx) => {
      try {
        const userId = ctx.from.id.toString();
        logger.info(`📩 Smart Bot: /status from user ${userId}`);

        const TEST_TELEGRAM_ID = process.env.TEST_TELEGRAM_ID || '489599665';
        const isAdmin = userId === TEST_TELEGRAM_ID;

        let projects;

        if (isAdmin) {
          // Admin sees ALL projects
          logger.info(`👑 Admin request: showing all projects`);
          projects = await SupabaseClient.getAllProjects();
        } else {
          // Regular users see only their projects
          projects = await this.getUserProjects(userId);
        }

        if (!projects || projects.length === 0) {
          ctx.reply('Нет активных проектов.');
          return;
        }

        // Send header message
        const header = isAdmin
          ? `👑 Найдено проектов: ${projects.length}\nОтправляю статусы...`
          : `📊 Найдено проектов: ${projects.length}\nОтправляю статусы...`;

        await ctx.reply(header);

        // Send each project as separate message
        for (let i = 0; i < projects.length; i++) {
          const project = projects[i];
          const statusMessage = this.formatProjectStatus(project);

          // Check if message is too long and split if needed
          if (statusMessage.length <= 4000) {
            await ctx.reply(statusMessage);
          } else {
            // Split long project status into parts
            const parts = this.splitMessage(statusMessage, 4000);
            for (let j = 0; j < parts.length; j++) {
              await ctx.reply(parts[j]);
              if (j < parts.length - 1) {
                await new Promise(resolve => setTimeout(resolve, 300));
              }
            }
          }

          // Small delay between messages
          if (i < projects.length - 1) {
            await new Promise(resolve => setTimeout(resolve, 800));
          }
        }

      } catch (error) {
        logger.error('❌ Error in /status:', error);
        const errorMsg = error instanceof Error ? error.message : String(error);
        logger.error('Error details:', errorMsg);
        ctx.reply(`Произошла ошибка при получении статусов:\n${errorMsg}`);
      }
    });

    // Handle text messages (chat)
    this.bot.on('text', async (ctx: Context) => {
      if (!('text' in ctx.message)) return;

      try {
        const userId = ctx.from.id.toString();
        const userMessage = ctx.message.text;

        // Skip if it's a command (already handled)
        if (userMessage.startsWith('/')) return;

        logger.info(`💬 Smart Bot: User ${userId} sent: ${userMessage}`);

        // Determine user type
        const userType = await this.getUserType(userId);

        // Send typing indicator
        await ctx.sendChatAction('typing');

        // Get user's projects context
        const userProjects = await this.getUserProjects(userId);

        // Call AI service with user type and projects context
        const response = await AIServiceClient.chatWithContext({
          userId,
          message: userMessage,
          userType,
          projects: userProjects
        });

        await ctx.reply(response.answer);

      } catch (error) {
        logger.error('Smart Bot error:', error);
        await ctx.reply('Извините, произошла ошибка. Попробуйте позже.');
      }
    });

    // Handle voice messages (future)
    this.bot.on('voice', async (ctx) => {
      await ctx.reply('Обработка голосовых сообщений скоро будет доступна.');
    });
  }

  /**
   * Determine user type: producer or client
   * Uses existing tables: producers (producer_tg_chat_id), clients (client_chat_id)
   */
  private async getUserType(telegramId: string): Promise<'producer' | 'client' | 'unknown'> {
    try {
      // Check in producers table
      const producer = await SupabaseClient.getProducer(telegramId);
      if (producer) return 'producer';

      // Check in clients table
      const client = await SupabaseClient.getClient(telegramId);
      if (client) return 'client';

      return 'unknown';
    } catch (error) {
      logger.error('Error determining user type:', error);
      return 'unknown';
    }
  }

  /**
   * Get projects associated with this user
   */
  private async getUserProjects(telegramId: string): Promise<any[]> {
    try {
      const userType = await this.getUserType(telegramId);

      if (userType === 'producer') {
        const producer = await SupabaseClient.getProducer(telegramId);
        if (!producer) return [];

        return await SupabaseClient.getProducerProjects(producer.producer_id);

      } else if (userType === 'client') {
        const client = await SupabaseClient.getClient(telegramId);
        if (!client) return [];

        return await SupabaseClient.getClientProjects(client.client_id);
      }

      return [];
    } catch (error) {
      logger.error('Error getting user projects:', error);
      return [];
    }
  }

  /**
   * Send status update to producer
   * Called after analysis completes
   */
  async notifyProducer(producerTgChatId: string, projectName: string, updates: string) {
    try {
      const header = `📊 Обновление статуса проекта "${projectName}":\n\n`;
      const fullMessage = header + updates;

      // Telegram message limit is 4096 characters
      const MAX_LENGTH = 4000; // Leave some margin

      if (fullMessage.length <= MAX_LENGTH) {
        // Message fits in one part
        await this.bot.telegram.sendMessage(producerTgChatId, fullMessage);
      } else {
        // Split into multiple messages
        const parts = this.splitMessage(updates, MAX_LENGTH - header.length);

        for (let i = 0; i < parts.length; i++) {
          const partHeader = i === 0
            ? header
            : `📊 Обновление статуса проекта "${projectName}" (часть ${i + 1}):\n\n`;

          await this.bot.telegram.sendMessage(
            producerTgChatId,
            partHeader + parts[i]
          );

          // Small delay between messages
          if (i < parts.length - 1) {
            await new Promise(resolve => setTimeout(resolve, 500));
          }
        }
      }

      logger.info(`Notified producer ${producerTgChatId} about project ${projectName}`);
    } catch (error) {
      logger.error(`Error notifying producer ${producerTgChatId}:`, error);
    }
  }

  /**
   * Format project status in structured way
   */
  private formatProjectStatus(project: any): string {
    const noInfo = 'информация отсутствует';

    let msg = `Название проекта:\n${project.project_name}\n\n`;
    msg += `Информация о статусе проекта в структурированном виде:\n`;
    msg += `"${project.project_name}" - ежедневный статус\n\n`;

    // 📋 Документы
    msg += `📋 Документы\n`;
    msg += `- ${project.doc || 'Работа не начата'}\n\n`;

    // 🎨 Сториборд
    msg += `🎨 Сториборд\n`;
    msg += `- Что и когда ждем от клиента/агентства: ${project.storyboard_client || noInfo}\n`;
    msg += `- Что и во сколько пришлем/что делаем сейчас: ${project.storyboard_cult || noInfo}\n`;
    msg += `- Когда ждем обратную связь от клиента: ${noInfo}\n\n`;

    // 🤖 AI-генерации
    msg += `🤖 AI-генерации\n`;
    msg += `- Что и когда ждем от клиента/агентства: ${project.aigen_client || noInfo}\n`;
    msg += `- Что и во сколько пришлем/что делаем сейчас: ${project.aigen_cult || noInfo}\n`;
    msg += `- Когда ждем обратную связь от клиента: ${noInfo}\n\n`;

    // 🎭 Кастинг
    msg += `🎭 Кастинг\n`;
    msg += `- Что и когда ждем от клиента/агентства: ${project.casting_client || noInfo}\n`;
    msg += `- Что и во сколько пришлем/что делаем сейчас: ${project.casting_cult || noInfo}\n`;
    msg += `- Когда ждем обратную связь от клиента: ${noInfo}\n\n`;

    // 👕 Костюм
    msg += `👕 Костюм\n`;
    msg += `- Что и когда ждем от клиента/агентства: ${project.clothes_client || noInfo}\n`;
    msg += `- Что и во сколько пришлем/что делаем сейчас: ${project.clothes_cult || noInfo}\n`;
    msg += `- Когда ждем обратную связь от клиента: ${noInfo}\n\n`;

    // 🎪 Эскизы и реквизит
    msg += `🎪 Эскизы и реквизит\n`;
    msg += `- Что и когда ждем от клиента/агентства: ${project.props_client || noInfo}\n`;
    msg += `- Что и во сколько пришлем/что делаем сейчас: ${project.props_cult || noInfo}\n`;
    msg += `- Когда ждем обратную связь от клиента: ${noInfo}\n\n`;

    // 📍 Локации / Декорации
    msg += `📍 Локации / Декорации\n`;
    msg += `- Что и когда ждем от клиента/агентства: ${project.location_client || noInfo}\n`;
    msg += `- Что и во сколько пришлем/что делаем сейчас: ${project.location_cult || noInfo}\n`;
    msg += `- Когда ждем обратную связь от клиента: ${noInfo}\n\n`;

    // 🎬 Аниматик
    msg += `🎬 Аниматик\n`;
    msg += `- Что и когда ждем от клиента/агентства: ${project.animatic_client || noInfo}\n`;
    msg += `- Что и во сколько пришлем/что делаем сейчас: ${project.animatic_cult || noInfo}\n`;
    msg += `- Когда ждем обратную связь от клиента: ${noInfo}\n\n`;

    // 🏗️ Моделирование
    msg += `🏗️ Моделирование\n`;
    msg += `- Что и когда ждем от клиента/агентства: ${project.modelling_client || noInfo}\n`;
    msg += `- Что и во сколько пришлем/что делаем сейчас: ${project.modelling_cult || noInfo}\n`;
    msg += `- Когда ждем обратную связь от клиента: ${noInfo}\n\n`;

    // 📸 Стайлшоты
    msg += `📸 Стайлшоты\n`;
    msg += `- Что и когда ждем от клиента/агентства: ${project.styleshots_client || noInfo}\n`;
    msg += `- Что и во сколько пришлем/что делаем сейчас: ${project.styleshots_cult || noInfo}\n`;
    msg += `- Когда ждем обратную связь от клиента: ${noInfo}\n\n`;

    // 🎞️ Анимация
    msg += `🎞️ Анимация\n`;
    msg += `- Что и когда ждем от клиента/агентства: ${project.animation_client || noInfo}\n`;
    msg += `- Что и во сколько пришлем/что делаем сейчас: ${project.animation_cult || noInfo}\n`;
    msg += `- Когда ждем обратную связь от клиента: ${noInfo}\n\n`;

    // ✂️ Монтаж
    msg += `✂️ Монтаж\n`;
    msg += `- Что и когда ждем от клиента/агентства: ${project.editing_client || noInfo}\n`;
    msg += `- Что и во сколько пришлем/что делаем сейчас: ${project.editing_cult || noInfo}\n`;
    msg += `- Когда ждем обратную связь от клиента: ${noInfo}\n\n`;

    // 🎵 Музыка
    msg += `🎵 Музыка\n`;
    msg += `- Что и когда ждем от клиента/агентства: ${project.music_client || noInfo}\n`;
    msg += `- Что и во сколько пришлем/что делаем сейчас: ${project.music_cult || noInfo}\n`;
    msg += `- Когда ждем обратную связь от клиента: ${noInfo}\n\n`;

    // 🎤 Войсовер
    msg += `🎤 Войсовер\n`;
    msg += `- Что и когда ждем от клиента/агентства: ${project.vo_client || noInfo}\n`;
    msg += `- Что и во сколько пришлем/что делаем сейчас: ${project.vo_cult || noInfo}\n`;
    msg += `- Когда ждем обратную связь от клиента: ${noInfo}\n\n`;

    // 🎨 Цветокоррекция
    msg += `🎨 Цветокоррекция\n`;
    msg += `- Что и когда ждем от клиента/агентства: ${project.colorgrading_client || noInfo}\n`;
    msg += `- Что и во сколько пришлем/что делаем сейчас: ${project.colorgrading_cult || noInfo}\n`;
    msg += `- Когда ждем обратную связь от клиента: ${noInfo}\n\n`;

    // 📷 Фото
    msg += `📷 Фото\n`;
    msg += `- Что и когда ждем от клиента/агентства: ${project.photos_client || noInfo}\n`;
    msg += `- Что и во сколько пришлем/что делаем сейчас: ${project.photos_cult || noInfo}\n`;
    msg += `- Когда ждем обратную связь от клиента: ${noInfo}\n\n`;

    // 💫 CG
    msg += `💫 CG\n`;
    msg += `- Что и когда ждем от клиента/агентства: ${project.cg_client || noInfo}\n`;
    msg += `- Что и во сколько пришлем/что делаем сейчас: ${project.cg_cult || noInfo}\n`;
    msg += `- Когда ждем обратную связь от клиента: ${noInfo}\n\n`;

    msg += `Все ли верно? Если какая-то информация неточная, пожалуйста, укажи, что нужно подправить`;

    return msg;
  }

  /**
   * Truncate long text with ellipsis
   */
  private truncate(text: string, maxLength: number): string {
    if (!text) return '';
    if (text.length <= maxLength) return text;
    return text.substring(0, maxLength) + '...';
  }

  /**
   * Split long message into parts by line breaks
   */
  private splitMessage(text: string, maxLength: number): string[] {
    const parts: string[] = [];
    const lines = text.split('\n');
    let currentPart = '';

    for (const line of lines) {
      if ((currentPart + line + '\n').length > maxLength) {
        if (currentPart) {
          parts.push(currentPart.trim());
          currentPart = '';
        }

        // If single line is too long, split it
        if (line.length > maxLength) {
          let remainingLine = line;
          while (remainingLine.length > maxLength) {
            parts.push(remainingLine.substring(0, maxLength));
            remainingLine = remainingLine.substring(maxLength);
          }
          currentPart = remainingLine + '\n';
        } else {
          currentPart = line + '\n';
        }
      } else {
        currentPart += line + '\n';
      }
    }

    if (currentPart.trim()) {
      parts.push(currentPart.trim());
    }

    return parts;
  }

  /**
   * Send status updates to all producers
   */
  async notifyAllProducers(updates: Record<number, string>) {
    try {
      // 🚨 TESTING MODE: Only send to Darya (489599665)
      const TEST_MODE = process.env.TEST_MODE === 'true';
      const TEST_TELEGRAM_ID = process.env.TEST_TELEGRAM_ID || '489599665';

      if (TEST_MODE) {
        logger.info(`🧪 TEST MODE: Sending all notifications only to ${TEST_TELEGRAM_ID}`);

        // In test mode, send ALL updates to test user only
        for (const [projectId, updateText] of Object.entries(updates)) {
          const project = await SupabaseClient.getProject(Number(projectId));

          if (project) {
            await this.notifyProducer(
              TEST_TELEGRAM_ID,
              project.project_name,
              updateText
            );
          }
        }
        return;
      }

      // Normal mode: send to actual producers
      for (const [projectId, updateText] of Object.entries(updates)) {
        // Get project with producer info
        const project = await SupabaseClient.getProject(Number(projectId));

        if (project && project.producer && project.producer.producer_tg_chat_id) {
          const producerTgId = project.producer.producer_tg_chat_id.toString();

          await this.notifyProducer(
            producerTgId,
            project.project_name,
            updateText
          );
        }

        // Notify producer2 if exists
        if (project && project.producer2) {
          const { data: producer2 } = await SupabaseClient.supabase
            .from('producers')
            .select('producer_tg_chat_id')
            .eq('producer_id', project.producer2)
            .single();

          if (producer2 && producer2.producer_tg_chat_id) {
            const producer2TgId = producer2.producer_tg_chat_id.toString();

            await this.notifyProducer(
              producer2TgId,
              project.project_name,
              updateText
            );
          }
        }
      }
    } catch (error) {
      logger.error('Error notifying producers:', error);
    }
  }

  /**
   * Launch the bot
   */
  async launch() {
    await this.bot.launch();
    logger.info('Smart Bot launched');

    // Graceful shutdown
    process.once('SIGINT', () => this.bot.stop('SIGINT'));
    process.once('SIGTERM', () => this.bot.stop('SIGTERM'));
  }

  /**
   * Get bot instance for external use
   */
  getBot() {
    return this.bot;
  }
}

// Export singleton instance
let smartBotInstance: SmartBot | null = null;

export function getSmartBot(token?: string): SmartBot {
  if (!smartBotInstance) {
    if (!token) {
      throw new Error('Token required to initialize Smart Bot');
    }
    smartBotInstance = new SmartBot(token);
  }
  return smartBotInstance;
}
