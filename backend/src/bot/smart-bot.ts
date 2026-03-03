import { Telegraf, Context } from 'telegraf';
import { logger } from '../utils/logger';
import { AIServiceClient } from '../services/ai-client';
import { SupabaseClient, getDefaultClientSettings } from '../database/supabase';
import { DashboardClient } from '../database/dashboard-supabase';
import { runStatusUpdate } from '../workflows/orchestrator';
import { formatStatusForClient } from '../workflows/status-scheduler';
import {
  getStandardFieldMapping,
  getBlockDisplayName,
  getBlockEmoji,
} from '../shared/block-registry';

interface ConversationMessage {
  role: 'user' | 'assistant';
  content: string;
  timestamp: number;
}

export class SmartBot {
  private bot: Telegraf;
  private userContext: Map<string, { projectId: number; timestamp: number }> = new Map();
  private conversationHistory: Map<string, ConversationMessage[]> = new Map();

  constructor(token: string) {
    this.bot = new Telegraf(token, {
      handlerTimeout: 300000
    });
    this.setupHandlers();
  }

  private setupHandlers() {
    this.bot.command('help', async (ctx) => {
      try {
        const userId = ctx.from.id.toString();
        const TEST_TELEGRAM_ID = process.env.TEST_TELEGRAM_ID || '489599665';
        const isAdmin = userId === TEST_TELEGRAM_ID;

        let message = '📖 Доступные команды:\n\n';

        message += '🔹 /start - приветствие и описание бота\n';
        message += '🔹 /status - показать статусы всех проектов\n';
        message += '🔹 /analyze - запустить анализ вручную (продюсеры)\n';
        message += '🔹 /help - показать эту справку\n';

        message += '🔹 /reset - сбросить контекст диалога\n';

        if (isAdmin) {
          message += '\n👑 АДМИНСКИЕ КОМАНДЫ:\n';
          message += '🔸 /admin_projects - список всех проектов с ID\n';
          message += '🔸 /admin_settings [ID] - настройки клиента для проекта\n';
          message += '🔸 /admin_blocks [ID] - активные блоки проекта\n';
          message += '🔸 /admin_status [ID] - текущий статус проекта из БД\n';
          message += '🔸 /admin_analyze [ID] - анализ последних 100 сообщений\n';
          message += '🔸 /admin_analyze_full [ID] - ПОЛНЫЙ анализ ВСЕХ сообщений ⚡\n';
          message += '🔸 /admin_send [ID] - отправка статусов (один проект или все)\n';
          message += '\n💡 Без указания ID команды применяются ко всем проектам';
        }

        ctx.reply(message);

      } catch (error) {
        logger.error('Error in /help:', error);
        ctx.reply('❌ Ошибка при получении справки');
      }
    });

    this.bot.command('reset', async (ctx) => {
      try {
        const userId = ctx.from.id.toString();
        this.userContext.delete(userId);
        logger.info(`User ${userId} reset their context`);
        ctx.reply('✅ Контекст диалога сброшен. Можете начать новый разговор.');
      } catch (error) {
        logger.error('Error in /reset:', error);
        ctx.reply('❌ Ошибка при сбросе контекста');
      }
    });

    this.bot.start(async (ctx) => {
      try {
        const userId = ctx.from.id.toString();
        logger.info(`Smart Bot: /start from user ${userId}`);

        const userType = await this.getUserType(userId);
        logger.info(`User ${userId} type: ${userType}`);

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
        logger.error('Error in /start handler:', error);
        ctx.reply('Произошла ошибка. Попробуйте позже.');
      }
    });

    this.bot.command('analyze', async (ctx) => {
      try {
        const userId = ctx.from.id.toString();
        logger.info(`Smart Bot: /analyze from user ${userId}`);

        const userType = await this.getUserType(userId);

        if (userType !== 'producer') {
          ctx.reply('У вас нет доступа к этой команде.');
          return;
        }

        const DRY_RUN = process.env.DRY_RUN === 'true';

        if (DRY_RUN) {
          ctx.reply('🧪 Запускаю анализ статусов в режиме DRY RUN...\n(Данные сохраняются в projects_test и custom_block_statuses) ⏳');
        } else {
          ctx.reply('Запускаю анализ статусов... ⏳');
        }

        const updates = await runStatusUpdate();

        if (updates && Object.keys(updates).length > 0) {
          await this.notifyAllProducers(updates);

          if (DRY_RUN) {
            ctx.reply('✅ Анализ завершен!\n🧪 DRY RUN: Данные сохранены в projects_test и custom_block_statuses.\n✉️ Уведомления отправлены!');
          } else {
            ctx.reply('✅ Анализ завершен! Статусы обновлены.\n✉️ Уведомления отправлены!');
          }
        } else {
          ctx.reply('✅ Анализ завершен. Новых обновлений нет.');
        }
      } catch (error) {
        logger.error('Error in /analyze:', error);
        ctx.reply('❌ Ошибка при анализе. Проверьте логи.');
      }
    });

    this.bot.command('status', async (ctx) => {
      try {
        const userId = ctx.from.id.toString();
        logger.info(`Smart Bot: /status from user ${userId}`);

        const TEST_TELEGRAM_ID = process.env.TEST_TELEGRAM_ID || '489599665';
        const isAdmin = userId === TEST_TELEGRAM_ID;

        let projects;

        if (isAdmin) {
          logger.info(`Admin request: showing all projects`);
          projects = await SupabaseClient.getAllProjects();
        } else {
          projects = await this.getUserProjects(userId);
        }

        if (!projects || projects.length === 0) {
          ctx.reply('Нет активных проектов.');
          return;
        }

        const header = isAdmin
          ? `👑 Найдено проектов: ${projects.length}\nОтправляю статусы...`
          : `📊 Найдено проектов: ${projects.length}\nОтправляю статусы...`;

        await ctx.reply(header);

        for (let i = 0; i < projects.length; i++) {
          const project = projects[i];
          const statusMessage = await this.formatProjectStatusDynamic(project);

          if (statusMessage.length <= 4000) {
            await ctx.reply(statusMessage);
          } else {
            const parts = this.splitMessage(statusMessage, 4000);
            for (let j = 0; j < parts.length; j++) {
              await ctx.reply(parts[j]);
              if (j < parts.length - 1) {
                await new Promise(resolve => setTimeout(resolve, 300));
              }
            }
          }

          if (i < projects.length - 1) {
            await new Promise(resolve => setTimeout(resolve, 800));
          }
        }

      } catch (error) {
        logger.error('Error in /status:', error);
        const errorMsg = error instanceof Error ? error.message : String(error);
        logger.error('Error details:', errorMsg);
        ctx.reply(`Произошла ошибка при получении статусов:\n${errorMsg}`);
      }
    });

    this.bot.command('admin_projects', async (ctx) => {
      try {
        const userId = ctx.from.id.toString();
        const TEST_TELEGRAM_ID = process.env.TEST_TELEGRAM_ID || '489599665';

        if (userId !== TEST_TELEGRAM_ID) {
          ctx.reply('⛔ У вас нет доступа к этой команде.');
          return;
        }

        logger.info(`Admin: /admin_projects from ${userId}`);

        const projects = await SupabaseClient.getAllProjects();

        if (!projects || projects.length === 0) {
          ctx.reply('Проектов не найдено.');
          return;
        }

        let message = `📋 Всего проектов: ${projects.length}\n\n`;

        for (const project of projects) {
          const producerName = project.producer?.producer_name || 'Нет продюсера';
          message += `🆔 ${project.project_id} - ${project.project_name}\n`;
          message += `   Продюсер: ${producerName}\n\n`;
        }

        message += '\n💡 Используйте ID для других команд:\n';
        message += '/admin_settings [ID]\n';
        message += '/admin_blocks [ID]\n';
        message += '/admin_status [ID]\n';
        message += '/admin_analyze [ID]\n';
        message += '/admin_analyze_full [ID] - ПОЛНЫЙ анализ\n';
        message += '/admin_send [ID]';

        if (message.length > 4000) {
          const parts = this.splitMessage(message, 4000);
          for (const part of parts) {
            await ctx.reply(part);
            await new Promise(resolve => setTimeout(resolve, 300));
          }
        } else {
          ctx.reply(message);
        }

      } catch (error) {
        logger.error('Error in /admin_projects:', error);
        ctx.reply('❌ Ошибка при получении списка проектов');
      }
    });

    this.bot.command('admin_settings', async (ctx) => {
      try {
        const userId = ctx.from.id.toString();
        const TEST_TELEGRAM_ID = process.env.TEST_TELEGRAM_ID || '489599665';

        if (userId !== TEST_TELEGRAM_ID) {
          ctx.reply('⛔ У вас нет доступа к этой команде.');
          return;
        }

        const args = ctx.message.text.split(' ');
        if (args.length < 2) {
          ctx.reply('⚠️ Укажите ID проекта:\n/admin_settings [project_id]\n\nИспользуйте /admin_projects для списка');
          return;
        }

        const projectId = parseInt(args[1], 10);
        if (isNaN(projectId)) {
          ctx.reply('⚠️ ID проекта должен быть числом');
          return;
        }

        logger.info(`Admin: /admin_settings ${projectId} from ${userId}`);

        const project = await SupabaseClient.getProject(projectId);
        if (!project) {
          ctx.reply(`❌ Проект ${projectId} не найден`);
          return;
        }

        const settings = await SupabaseClient.getClientSettings(projectId);

        let message = `⚙️ Настройки проекта "${project.project_name}"\n\n`;
        message += `🆔 Project ID: ${projectId}\n`;
        message += `📅 Дни отправки: ${settings.status_frequency_day || 'По умолчанию (пн-пт)'}\n`;
        message += `⏰ Время отправки: ${settings.status_frequency_time || '10:00:00+03'}\n`;
        message += `📝 Формат: ${settings.format_status || 'длинный'}\n\n`;

        const nextSend = this.calculateNextSendTime(settings);
        message += `⏭️ Следующая отправка: ${nextSend}\n\n`;

        message += `💡 Статус будет отправлен продюсеру за 1 час до времени отправки`;

        ctx.reply(message);

      } catch (error) {
        logger.error('Error in /admin_settings:', error);
        ctx.reply('❌ Ошибка при получении настроек');
      }
    });

    this.bot.command('admin_status', async (ctx) => {
      try {
        const userId = ctx.from.id.toString();
        const TEST_TELEGRAM_ID = process.env.TEST_TELEGRAM_ID || '489599665';

        if (userId !== TEST_TELEGRAM_ID) {
          ctx.reply('⛔ У вас нет доступа к этой команде.');
          return;
        }

        const args = ctx.message.text.split(' ');
        if (args.length < 2) {
          ctx.reply('⚠️ Укажите ID проекта:\n/admin_status [project_id]\n\nИспользуйте /admin_projects для списка');
          return;
        }

        const projectId = parseInt(args[1], 10);
        if (isNaN(projectId)) {
          ctx.reply('⚠️ ID проекта должен быть числом');
          return;
        }

        logger.info(`Admin: /admin_status ${projectId} from ${userId}`);

        const project = await SupabaseClient.getProject(projectId);
        if (!project) {
          ctx.reply(`❌ Проект ${projectId} не найден`);
          return;
        }

        await ctx.reply(`📊 Формирую готовый статус для клиента проекта "${project.project_name}"...`);

        const clientSettings = await SupabaseClient.getClientSettings(projectId);
        const defaults = getDefaultClientSettings();
        const format = clientSettings.format_status || defaults.format_status;

        const activeBlocks = await DashboardClient.getActiveBlocks(project.project_name);

        if (activeBlocks.length === 0) {
          ctx.reply(`⚠️ Нет активных блоков для проекта "${project.project_name}"`);
          return;
        }

        const messages = await SupabaseClient.getLastMessagesForProject(projectId, 100);

        if (messages.length > 0) {
          const previewMessages = messages.slice(-5);

          await ctx.reply(`📨 ПЕРЕПИСКА ДЛЯ АНАЛИЗА:\nВсего сообщений: ${messages.length}\nПоказываю последние ${previewMessages.length}:\n─────────────────────`);

          for (const msg of previewMessages) {
            const timestamp = new Date(msg.timestamp).toLocaleString('ru-RU', {
              day: '2-digit',
              month: '2-digit',
              hour: '2-digit',
              minute: '2-digit'
            });

            const messageText = msg.message_text.length > 500
              ? msg.message_text.substring(0, 500) + '...'
              : msg.message_text;

            const userRole = await SupabaseClient.getUserRole(msg.sender_id);
            let messagePreview = `[${timestamp}] ${userRole}:\n${messageText}`;

            if (messagePreview.length > 4000) {
              const chunks = this.splitMessage(messagePreview, 4000);
              for (const chunk of chunks) {
                await ctx.reply(chunk);
              }
            } else {
              await ctx.reply(messagePreview);
            }
          }

          if (messages.length > 5) {
            await ctx.reply(`... и еще ${messages.length - 5} сообщений выше`);
          }

          await ctx.reply(`─────────────────────`);
        } else {
          await ctx.reply('⚠️ Нет сообщений для анализа в чатах проекта');
        }

        // Ручные статусы из дашборда (приоритет)
        const manualStatuses = await DashboardClient.getManualStatuses(project.project_name);

        // AI-статусы из custom_block_statuses
        const allStatuses = await SupabaseClient.getCustomBlockStatuses(projectId);

        const statusMap: Record<string, string> = {};
        for (const block of activeBlocks) {
          const blockKey = block.id || block.name;

          // Ручной статус — приоритет
          const manual = manualStatuses.get(blockKey);
          if (manual) {
            statusMap[blockKey] = manual.status;
            continue;
          }

          const status = allStatuses.find((s: any) => s.block_id === blockKey);
          if (status && status.status_analysis) {
            statusMap[blockKey] = status.status_analysis;
          }
        }

        const statusText = formatStatusForClient(activeBlocks, statusMap, format);

        let finalMessage = `📋 Проект: ${project.project_name}\n`;
        finalMessage += `📊 Формат: ${format}\n\n`;
        finalMessage += `─────────────────────\n`;
        finalMessage += `ГОТОВЫЙ СТАТУС ДЛЯ КЛИЕНТА:\n`;
        finalMessage += `─────────────────────\n\n`;
        finalMessage += statusText;

        ctx.reply(finalMessage);

      } catch (error) {
        logger.error('Error in /admin_status:', error);
        ctx.reply('❌ Ошибка при получении статуса');
      }
    });

    this.bot.command('admin_blocks', async (ctx) => {
      try {
        const userId = ctx.from.id.toString();
        const TEST_TELEGRAM_ID = process.env.TEST_TELEGRAM_ID || '489599665';

        if (userId !== TEST_TELEGRAM_ID) {
          ctx.reply('⛔ У вас нет доступа к этой команде.');
          return;
        }

        const args = ctx.message.text.split(' ');
        if (args.length < 2) {
          ctx.reply('⚠️ Укажите ID проекта:\n/admin_blocks [project_id]\n\nИспользуйте /admin_projects для списка');
          return;
        }

        const projectId = parseInt(args[1], 10);
        if (isNaN(projectId)) {
          ctx.reply('⚠️ ID проекта должен быть числом');
          return;
        }

        logger.info(`Admin: /admin_blocks ${projectId} from ${userId}`);

        const project = await SupabaseClient.getProject(projectId);
        if (!project) {
          ctx.reply(`❌ Проект ${projectId} не найден`);
          return;
        }

        await ctx.reply(`📊 Получаю активные блоки для проекта "${project.project_name}"...`);

        const { DashboardClient } = await import('../database/dashboard-supabase');
        const activeBlocks = await DashboardClient.getActiveBlocks(project.project_name);

        let message = `📋 Активные блоки для "${project.project_name}":\n\n`;
        message += `Всего блоков: ${activeBlocks.length}\n\n`;

        const standardBlocks = activeBlocks.filter(b => b.type === 'standard');
        const customPre = activeBlocks.filter(b => b.type === 'custom_pre');
        const customPost = activeBlocks.filter(b => b.type === 'custom_post');

        if (standardBlocks.length > 0) {
          message += `✅ Стандартные блоки (${standardBlocks.length}):\n`;
          standardBlocks.forEach(b => {
            message += `  • ${b.name}\n`;
          });
          message += '\n';
        }

        if (customPre.length > 0) {
          message += `🔧 Кастомные препродакшн (${customPre.length}):\n`;
          customPre.forEach(b => {
            message += `  • ${b.name} (ID: ${b.id})\n`;
          });
          message += '\n';
        }

        if (customPost.length > 0) {
          message += `🎨 Кастомные постпродакшн (${customPost.length}):\n`;
          customPost.forEach(b => {
            message += `  • ${b.name} (ID: ${b.id})\n`;
          });
          message += '\n';
        }

        if (activeBlocks.length === 0) {
          message += '❌ Нет активных блоков';
        }

        ctx.reply(message);

      } catch (error) {
        logger.error('Error in /admin_blocks:', error);
        ctx.reply(`❌ Ошибка: ${error}`);
      }
    });

    this.bot.command('admin_analyze', async (ctx) => {
      try {
        const userId = ctx.from.id.toString();
        const TEST_TELEGRAM_ID = process.env.TEST_TELEGRAM_ID || '489599665';

        if (userId !== TEST_TELEGRAM_ID) {
          ctx.reply('⛔ У вас нет доступа к этой команде.');
          return;
        }

        const args = ctx.message.text.split(' ');
        let projects: any[] = [];

        if (args.length >= 2) {
          const projectId = parseInt(args[1], 10);
          if (isNaN(projectId)) {
            ctx.reply('⚠️ ID проекта должен быть числом');
            return;
          }

          const project = await SupabaseClient.getProject(projectId);
          if (!project) {
            ctx.reply(`❌ Проект ${projectId} не найден`);
            return;
          }

          projects = [project];
          logger.info(`Admin: /admin_analyze ${projectId} from ${userId}`);
        } else {
          const allProjects = await SupabaseClient.getAllProjects();
          if (!allProjects || allProjects.length === 0) {
            ctx.reply('❌ Проектов не найдено');
            return;
          }
          projects = allProjects;
          logger.info(`Admin: /admin_analyze ALL (${projects.length} projects) from ${userId}`);
        }

        await ctx.reply(`🔄 Начинаю анализ ${projects.length === 1 ? 'проекта' : `${projects.length} проектов`}...\n\n⏳ Это может занять некоторое время...`);

        let successCount = 0;
        let errorCount = 0;

        for (const project of projects) {
          try {
            logger.info(`Analyzing project: ${project.project_name} (ID: ${project.project_id})`);

            await SupabaseClient.ensureProjectTestExists(project.project_id);

            const messages = await SupabaseClient.getLastMessagesForProject(project.project_id, 100);

            if (messages.length === 0) {
              logger.warn(`No messages for project ${project.project_id}`);
              continue;
            }

            const activeBlocks = await DashboardClient.getActiveBlocks(project.project_name);

            if (activeBlocks.length === 0) {
              logger.warn(`No active blocks for project ${project.project_id}`);
              continue;
            }

            const conversationText = await SupabaseClient.formatConversationWithRoles(messages);

            const analysisResults = await AIServiceClient.analyzeDynamicBlocks({
              projectId: project.project_id,
              projectName: project.project_name,
              blocks: activeBlocks,
              conversation: conversationText
            });

            let savedCount = 0;

            for (const block of activeBlocks) {
              const blockKey = block.id || block.name;
              const newStatus = analysisResults[blockKey];

              if (!newStatus) {
                logger.warn(`No analysis result for block: ${block.name}`);
                continue;
              }

              // Все блоки пишем в custom_block_statuses
              await SupabaseClient.upsertCustomBlockStatus({
                project_id: project.project_id,
                block_id: block.id || block.name,
                block_name: block.name,
                block_type: block.type,
                status_analysis: newStatus
              });

              // Стандартные блоки дополнительно в projects_test (dual-write)
              if (block.type === 'standard') {
                const fieldName = getStandardFieldMapping(block.name);
                if (fieldName) {
                  await SupabaseClient.updateProjectTestField(project.project_id, fieldName, newStatus);
                }
              }

              savedCount++;
            }

            logger.info(`Project ${project.project_name}: ${savedCount} blocks saved`);
            successCount++;

          } catch (error) {
            logger.error(`Error analyzing project ${project.project_id}:`, error);
            errorCount++;
          }
        }

        let summary = `✅ Анализ завершен!\n\n`;
        summary += `📊 Проектов обработано: ${successCount}\n`;
        if (errorCount > 0) {
          summary += `⚠️ Ошибок: ${errorCount}\n`;
        }
        summary += `\n💡 Статусы обновлены в БД. Используйте /admin_send для отправки клиентам.`;

        ctx.reply(summary);

      } catch (error) {
        logger.error('Error in /admin_analyze:', error);
        const errorMsg = error instanceof Error ? error.message : String(error);
        ctx.reply(`❌ Ошибка при анализе: ${errorMsg}`);
      }
    });

    this.bot.command('admin_analyze_full', async (ctx) => {
      try {
        const userId = ctx.from.id.toString();
        const TEST_TELEGRAM_ID = process.env.TEST_TELEGRAM_ID || '489599665';

        if (userId !== TEST_TELEGRAM_ID) {
          ctx.reply('⛔ У вас нет доступа к этой команде.');
          return;
        }

        const args = ctx.message.text.split(' ');
        let projects: any[] = [];

        if (args.length >= 2) {
          const projectId = parseInt(args[1], 10);
          if (isNaN(projectId)) {
            ctx.reply('⚠️ ID проекта должен быть числом');
            return;
          }

          const project = await SupabaseClient.getProject(projectId);
          if (!project) {
            ctx.reply(`❌ Проект ${projectId} не найден`);
            return;
          }

          projects = [project];
          logger.info(`Admin: /admin_analyze_full ${projectId} from ${userId}`);
        } else {
          const allProjects = await SupabaseClient.getAllProjects();
          if (!allProjects || allProjects.length === 0) {
            ctx.reply('❌ Проектов не найдено');
            return;
          }
          projects = allProjects;
          logger.info(`Admin: /admin_analyze_full ALL (${projects.length} projects) from ${userId}`);
        }

        await ctx.reply(`🔄 Начинаю ПОЛНЫЙ анализ ${projects.length === 1 ? 'проекта' : `${projects.length} проектов`}...\n\n📊 Будут проанализированы ВСЕ сообщения каждого проекта\n⏳ Это может занять несколько минут...`);

        let successCount = 0;
        let errorCount = 0;
        let totalMessages = 0;

        for (const project of projects) {
          try {
            logger.info(`[FULL ANALYSIS] Analyzing project: ${project.project_name} (ID: ${project.project_id})`);

            await SupabaseClient.ensureProjectTestExists(project.project_id);

            const messages = await SupabaseClient.getLastMessagesForProject(project.project_id, 10000);

            if (messages.length === 0) {
              logger.warn(`No messages for project ${project.project_id}`);
              await ctx.reply(`⚠️ Проект "${project.project_name}": нет сообщений`);
              continue;
            }

            totalMessages += messages.length;
            logger.info(`Retrieved ${messages.length} messages for full analysis`);

            const activeBlocks = await DashboardClient.getActiveBlocks(project.project_name);

            if (activeBlocks.length === 0) {
              logger.warn(`No active blocks for project ${project.project_id}`);
              await ctx.reply(`⚠️ Проект "${project.project_name}": нет активных блоков`);
              continue;
            }

            await ctx.reply(`📊 Анализирую "${project.project_name}"...\n📨 Сообщений: ${messages.length}\n🔲 Блоков: ${activeBlocks.length}`);

            const conversationText = await SupabaseClient.formatConversationWithRoles(messages);

            const analysisResults = await AIServiceClient.analyzeDynamicBlocks({
              projectId: project.project_id,
              projectName: project.project_name,
              blocks: activeBlocks,
              conversation: conversationText
            });

            let savedCount = 0;

            for (const block of activeBlocks) {
              const blockKey = block.id || block.name;
              const newStatus = analysisResults[blockKey];

              if (!newStatus) {
                logger.warn(`No analysis result for block: ${block.name}`);
                continue;
              }

              // Все блоки пишем в custom_block_statuses
              await SupabaseClient.upsertCustomBlockStatus({
                project_id: project.project_id,
                block_id: block.id || block.name,
                block_name: block.name,
                block_type: block.type,
                status_analysis: newStatus
              });

              // Стандартные блоки дополнительно в projects_test (dual-write)
              if (block.type === 'standard') {
                const fieldName = getStandardFieldMapping(block.name);
                if (fieldName) {
                  await SupabaseClient.updateProjectTestField(project.project_id, fieldName, newStatus);
                }
              }

              savedCount++;
              logger.info(`  ${block.name}: ${newStatus.substring(0, 50)}...`);
            }

            logger.info(`Project ${project.project_name}: ${savedCount} blocks saved`);
            await ctx.reply(`✅ "${project.project_name}": ${savedCount} блоков обновлено`);
            successCount++;

          } catch (error) {
            logger.error(`Error analyzing project ${project.project_id}:`, error);
            const errorMsg = error instanceof Error ? error.message : String(error);
            await ctx.reply(`❌ Ошибка в проекте "${project.project_name}": ${errorMsg}`);
            errorCount++;
          }
        }

        let summary = `\n🎉 ПОЛНЫЙ АНАЛИЗ ЗАВЕРШЕН!\n\n`;
        summary += `📊 Проектов обработано: ${successCount}/${projects.length}\n`;
        summary += `📨 Всего проанализировано сообщений: ${totalMessages}\n`;
        if (errorCount > 0) {
          summary += `⚠️ Ошибок: ${errorCount}\n`;
        }
        summary += `\n💾 Данные сохранены в custom_block_statuses\n`;
        summary += `\n💡 Используйте /admin_send для отправки статусов продюсерам.`;

        ctx.reply(summary);

      } catch (error) {
        logger.error('Error in /admin_analyze_full:', error);
        const errorMsg = error instanceof Error ? error.message : String(error);
        ctx.reply(`❌ Критическая ошибка при анализе: ${errorMsg}`);
      }
    });

    this.bot.command('admin_send', async (ctx) => {
      try {
        const userId = ctx.from.id.toString();
        const TEST_TELEGRAM_ID = process.env.TEST_TELEGRAM_ID || '489599665';

        if (userId !== TEST_TELEGRAM_ID) {
          ctx.reply('⛔ У вас нет доступа к этой команде.');
          return;
        }

        const args = ctx.message.text.split(' ');
        let projects: any[] = [];

        if (args.length >= 2) {
          const projectId = parseInt(args[1], 10);
          if (isNaN(projectId)) {
            ctx.reply('⚠️ ID проекта должен быть числом');
            return;
          }

          const project = await SupabaseClient.getProject(projectId);
          if (!project) {
            ctx.reply(`❌ Проект ${projectId} не найден`);
            return;
          }

          projects = [project];
          logger.info(`Admin: /admin_send ${projectId} from ${userId}`);
        } else {
          const allProjects = await SupabaseClient.getAllProjects();
          if (!allProjects || allProjects.length === 0) {
            ctx.reply('❌ Проектов не найдено');
            return;
          }
          projects = allProjects;
          logger.info(`Admin: /admin_send ALL (${projects.length} projects) from ${userId}`);
        }

        await ctx.reply(`📤 Отправляю статусы ${projects.length === 1 ? 'проекта' : `${projects.length} проектов`}...`);

        const { sendStatusToProducerAdmin } = await import('../workflows/status-scheduler');

        let successCount = 0;
        let errorCount = 0;

        for (const project of projects) {
          try {
            logger.info(`Sending status for project: ${project.project_name} (ID: ${project.project_id})`);
            await sendStatusToProducerAdmin(project);
            successCount++;

            if (projects.length > 1) {
              await new Promise(resolve => setTimeout(resolve, 1000));
            }
          } catch (error) {
            logger.error(`Error sending status for project ${project.project_id}:`, error);
            errorCount++;
          }
        }

        if (projects.length === 1) {
          this.userContext.set(userId, {
            projectId: projects[0].project_id,
            timestamp: Date.now()
          });
        }

        let summary = `✅ Отправка завершена!\n\n`;
        summary += `📤 Отправлено: ${successCount}\n`;
        if (errorCount > 0) {
          summary += `⚠️ Ошибок: ${errorCount}\n`;
        }

        if (projects.length === 1) {
          summary += `\n💡 Если нужно что-то поправить - просто напишите мне что изменить.`;
        }

        ctx.reply(summary);

      } catch (error) {
        logger.error('Error in /admin_send:', error);
        const errorMsg = error instanceof Error ? error.message : String(error);
        ctx.reply(`❌ Ошибка при отправке: ${errorMsg}`);
      }
    });

    this.bot.on('text', async (ctx: Context) => {
      if (!ctx.message || !('text' in ctx.message)) return;
      if (!ctx.from) return;

      try {
        const userId = ctx.from.id.toString();
        const userMessage = ctx.message.text;

        if (userMessage.startsWith('/')) return;

        logger.info(`Smart Bot: User ${userId} sent: ${userMessage}`);

        let context = this.userContext.get(userId);
        const TEN_MINUTES = 10 * 60 * 1000;

        if ('reply_to_message' in ctx.message && ctx.message.reply_to_message) {
          const replyToMsg = ctx.message.reply_to_message;

          if ('text' in replyToMsg && replyToMsg.text) {
            const replyText = replyToMsg.text;

            const projectMatch = replyText.match(/Статус на сегодня по проекту "(.+?)"/);

            if (projectMatch && projectMatch[1]) {
              const projectName = projectMatch[1];
              logger.info(`User replying to status of project: ${projectName}`);

              try {
                const allProjects = await SupabaseClient.getAllProjects();
                const project = allProjects.find((p: any) => p.project_name === projectName);

                if (project) {
                  context = {
                    projectId: project.project_id,
                    timestamp: Date.now()
                  };
                  this.userContext.set(userId, context);
                  logger.info(`Context set from reply: project ${project.project_id} (${projectName})`);
                }
              } catch (error) {
                logger.error('Error finding project from reply:', error);
              }
            }
          }
        }

        const numberedQuestionMatch = userMessage.match(/^\d+\.\s+(.+)/);
        const isNumberedQuestion = numberedQuestionMatch !== null;

        if (context && (Date.now() - context.timestamp) < TEN_MINUTES) {
          logger.info(`User ${userId} has recent context for project ${context.projectId}, checking message type...`);

          const questionIndicators = [
            '?', 'когда', 'где', 'как', 'почему', 'зачем', 'что ', 'какой', 'какая', 'какое', 'какие',
            'можно ли', 'есть ли', 'был ли', 'было ли', 'были ли', 'будет ли', 'скажи', 'расскажи', 'покажи', 'отправь'
          ];
          const isQuestion = isNumberedQuestion || questionIndicators.some(indicator =>
            userMessage.toLowerCase().includes(indicator)
          );

          if (isQuestion) {
            logger.info(`User asking question about project ${context.projectId}`);

            try {
              await ctx.sendChatAction('typing');
              const progressMsg = await ctx.reply('🔍 Анализирую переписку проекта...');

              const project = await SupabaseClient.getProject(context.projectId);
              if (!project) {
                await ctx.telegram.deleteMessage(ctx.chat!.id, progressMsg.message_id);
                await ctx.reply('❌ Проект не найден');
                return;
              }

              const questionText = numberedQuestionMatch ? numberedQuestionMatch[1] : userMessage;

              const answer = await this.answerQuestionIteratively(
                context.projectId,
                project.project_name,
                questionText,
                progressMsg.message_id,
                ctx
              );

              try {
                await ctx.telegram.deleteMessage(ctx.chat!.id, progressMsg.message_id);
              } catch (e) {
              }

              await ctx.reply(answer);

              this.userContext.set(userId, {
                projectId: context.projectId,
                timestamp: Date.now()
              });

              return;
            } catch (error: any) {
              logger.error('Error handling question:', error);
              await ctx.reply('❌ Не удалось проанализировать переписку. Попробуйте позже или обратитесь к команде проекта.');
              return;
            }
          }

          const correctionKeywords = [
            'поправ', 'исправ', 'на самом деле', 'верно', 'неверно', 'ошибка', 'не так',
            'должно быть', 'изменить', 'согласован', 'утвержд', 'одобрен', 'готов',
            'завершен', 'окнул', 'будет', 'делаем', 'делали', 'сделал', 'отправ',
            'начин', 'заверш', 'тут ', 'здесь', 'это ', 'работе', 'процесс'
          ];
          const isLikelyCorrection = correctionKeywords.some(keyword =>
            userMessage.toLowerCase().includes(keyword)
          );

          const isReplyToStatus = 'reply_to_message' in ctx.message &&
                                  ctx.message.reply_to_message &&
                                  'text' in ctx.message.reply_to_message &&
                                  ctx.message.reply_to_message.text.includes('Статус на сегодня по проекту');

          if ((isLikelyCorrection || isReplyToStatus) && !isQuestion) {
            await ctx.sendChatAction('typing');
            await ctx.reply('📝 Понял, обновляю статусы...');

            try {
              await this.handleStatusCorrection(ctx, context.projectId, userMessage);
              this.userContext.set(userId, {
                projectId: context.projectId,
                timestamp: Date.now()
              });
              return;
            } catch (error) {
              logger.error('Error handling correction:', error);
              await ctx.reply('❌ Произошла ошибка при обновлении статусов');
            }
          }
        }

        const userType = await this.getUserType(userId);
        await ctx.sendChatAction('typing');
        const userProjects = await this.getUserProjects(userId);

        const linkKeywords = ['ссылк', 'материал', 'статик', 'файл', 'где найти', 'где посмотреть', 'покаж'];
        const isAskingForLinks = linkKeywords.some(keyword =>
          userMessage.toLowerCase().includes(keyword)
        );

        let enhancedMessage = userMessage;
        let foundLinks: string[] = [];

        if (context && isAskingForLinks) {
          logger.info(`User asking for links, searching project ${context.projectId} messages...`);
          foundLinks = await this.searchProjectMessages(context.projectId, userMessage);

          if (foundLinks.length > 0) {
            logger.info(`Found ${foundLinks.length} links in project messages`);
            enhancedMessage = `${userMessage}\n\n[НАЙДЕННЫЕ ССЫЛКИ В ПЕРЕПИСКЕ ПРОЕКТА]:\n${foundLinks.join('\n')}`;
          } else {
            logger.info(`No links found in project messages`);
          }
        }

        const response = await AIServiceClient.chatWithContext({
          userId,
          message: enhancedMessage,
          userType,
          projects: userProjects
        });

        await ctx.reply(response.answer);

      } catch (error) {
        logger.error('Smart Bot error:', error);
        await ctx.reply('Извините, произошла ошибка. Попробуйте позже.');
      }
    });

    this.bot.on('voice', async (ctx) => {
      await ctx.reply('Обработка голосовых сообщений скоро будет доступна.');
    });
  }

  private async getUserType(telegramId: string): Promise<'producer' | 'client' | 'unknown'> {
    try {
      const producer = await SupabaseClient.getProducer(telegramId);
      if (producer) return 'producer';

      const client = await SupabaseClient.getClient(telegramId);
      if (client) return 'client';

      return 'unknown';
    } catch (error) {
      logger.error('Error determining user type:', error);
      return 'unknown';
    }
  }

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

  private addToHistory(userId: string, role: 'user' | 'assistant', content: string) {
    if (!this.conversationHistory.has(userId)) {
      this.conversationHistory.set(userId, []);
    }

    const history = this.conversationHistory.get(userId)!;
    history.push({
      role,
      content,
      timestamp: Date.now()
    });

    if (history.length > 20) {
      history.shift();
    }
  }

  private getHistory(userId: string): ConversationMessage[] {
    return this.conversationHistory.get(userId) || [];
  }

  private async answerQuestionIteratively(
    projectId: number,
    projectName: string,
    question: string,
    progressMsgId: number,
    ctx: any
  ): Promise<string> {
    const BATCH_SIZE = 50;
    const MAX_MESSAGES = 500;
    let currentLimit = BATCH_SIZE;

    while (currentLimit <= MAX_MESSAGES) {
      try {
        logger.info(`Loading ${currentLimit} messages for question answering...`);

        try {
          await ctx.telegram.editMessageText(
            ctx.chat!.id,
            progressMsgId,
            undefined,
            `🔍 Анализирую переписку проекта...\n📊 Загружено сообщений: ${currentLimit}`
          );
        } catch (e) {
        }

        const messages = await SupabaseClient.getLastMessagesForProject(projectId, currentLimit);

        if (messages.length === 0) {
          return '📭 В переписке проекта пока нет сообщений для анализа.';
        }

        const conversationText = await SupabaseClient.formatConversationWithRoles(messages);

        const result = await AIServiceClient.answerQuestion({
          projectName,
          question,
          conversation: conversationText,
          messageCount: messages.length
        });

        if (!result.needsMore) {
          logger.info(`Found answer using ${messages.length} messages`);
          return result.answer;
        }

        if (messages.length < currentLimit) {
          logger.info(`No more messages available (${messages.length} total)`);
          return result.answer;
        }

        logger.info(`Need more context, loading more messages (current: ${currentLimit} → next: ${currentLimit + BATCH_SIZE})`);
        currentLimit += BATCH_SIZE;

      } catch (error) {
        logger.error(`Error in iterative question answering at ${currentLimit} messages:`, error);
        throw error;
      }
    }

    logger.warn(`Reached max limit of ${MAX_MESSAGES} messages, returning best answer`);
    return '🤔 Не нашел точного ответа в доступной переписке. Попробуйте уточнить вопрос или обратитесь к команде проекта.';
  }

  private async searchProjectMessages(projectId: number, searchQuery: string): Promise<string[]> {
    try {
      const messages = await SupabaseClient.getLastMessagesForProject(projectId, 100);

      const linkPatterns = [
        /https?:\/\/[^\s]+/g,
        /figma\.com[^\s]*/gi,
        /drive\.google\.com[^\s]*/gi,
        /dropbox\.com[^\s]*/gi,
        /yandex\.ru\/d\/[^\s]*/gi,
        /disk\.yandex[^\s]*/gi,
        /miro\.com[^\s]*/gi,
        /notion\.so[^\s]*/gi,
      ];

      const foundLinks: string[] = [];
      const searchLower = searchQuery.toLowerCase();

      const searchKeywords = searchLower
        .replace(/ссылк[аиу]/g, '')
        .replace(/материал[ыа]/g, '')
        .replace(/отправ[иь]/g, '')
        .replace(/скинь/g, '')
        .replace(/можешь/g, '')
        .replace(/на все/g, '')
        .trim()
        .split(/\s+/)
        .filter(word => word.length > 2);

      logger.debug(`Search keywords extracted: ${searchKeywords.join(', ')}`);

      for (const msg of messages) {
        const text = msg.message_text;
        const textLower = text.toLowerCase();

        const hasSearchKeywords = searchKeywords.length === 0 ||
          searchKeywords.some(keyword => textLower.includes(keyword));

        const hasLinkIndicators =
          textLower.includes('статика') ||
          textLower.includes('ссылка') ||
          textLower.includes('материал') ||
          textLower.includes('можно смотреть') ||
          textLower.includes('готово') ||
          textLower.includes('тут') ||
          textLower.includes('вот') ||
          textLower.includes('кадры') ||
          textLower.includes('https');

        if (hasSearchKeywords && hasLinkIndicators) {
          for (const pattern of linkPatterns) {
            const matches = text.match(pattern);
            if (matches) {
              foundLinks.push(...matches);
            }
          }
        }
      }

      logger.debug(`Found ${foundLinks.length} links`);
      return [...new Set(foundLinks)];
    } catch (error) {
      logger.error('Error searching project messages:', error);
      return [];
    }
  }

  private async handleStatusCorrection(ctx: any, projectId: number, correctionText: string) {
    try {
      logger.info(`Handling status correction for project ${projectId}: "${correctionText}"`);

      const DRY_RUN = process.env.DRY_RUN === 'true';
      const project = DRY_RUN
        ? await SupabaseClient.getProjectTest(projectId)
        : await SupabaseClient.getProject(projectId);

      if (!project) {
        await ctx.reply('❌ Проект не найден');
        return;
      }

      const activeBlocks = await DashboardClient.getActiveBlocks(project.project_name);
      if (activeBlocks.length === 0) {
        await ctx.reply('❌ Нет активных блоков для этого проекта');
        return;
      }

      const allStatuses = await SupabaseClient.getCustomBlockStatuses(projectId);

      await ctx.reply('🤖 Анализирую вашу корректировку...');

      const allBlocks = activeBlocks;
      let currentStatusContext = 'ТЕКУЩИЕ СТАТУСЫ:\n\n';

      for (const block of allBlocks) {
        const blockKey = block.id || block.name;
        const status = allStatuses.find((s: any) => s.block_id === blockKey);
        currentStatusContext += `${block.name}: ${status?.status_analysis || 'информация отсутствует'}\n`;
      }

      const parsePrompt = `Ты - ассистент для парсинга корректировок статусов проекта.

${currentStatusContext}

КОРРЕКТИРОВКА ОТ ПРОДЮСЕРА:
"${correctionText}"

Твоя задача: распарсить корректировку и вернуть ТОЛЬКО JSON с изменениями.

Формат ответа - валидный JSON массив:
[
  {
    "blockName": "название блока",
    "newStatus": "новый статус"
  }
]

ВАЖНО:
- Включай в массив ТОЛЬКО те блоки, которые нужно изменить
- Если блок не упоминается в корректировке - НЕ включай его
- blockName должно точно совпадать с названием из списка выше
- newStatus - краткий новый статус (1-2 предложения)
- Если продюсер говорит "это согласовано/утверждено/одобрено/готово" про блоки со статусом "информация отсутствует" - установи статус "Согласовано"
- Если продюсер перечисляет блоки через дефис/точку/запятую - это список блоков для обновления
- ⚡ ВАЖНО: Если продюсер говорит "все согласовано/готово/утверждено" БЕЗ перечисления блоков - обнови ВСЕ блоки со статусом "информация отсутствует"

Примеры:

ПРИМЕР 1:
Корректировка: "Генерация статики - верно, остальное в работе с 12 января"
Ответ:
[
  {
    "blockName": "Генерация статики для роликов",
    "newStatus": "В работе с 12 января"
  },
  {
    "blockName": "Анимация кадров",
    "newStatus": "В работе с 12 января"
  }
]

ПРИМЕР 2:
Корректировка: "- Граф. пакет\n- Монтаж Sensana Pack 1\n- Монтаж Sensana Pack 2\nэто все согласовано"
Ответ:
[
  {
    "blockName": "Граф. пакет",
    "newStatus": "Согласовано"
  },
  {
    "blockName": "Монтаж Sensana Pack 1",
    "newStatus": "Согласовано"
  },
  {
    "blockName": "Монтаж Sensana Pack 2",
    "newStatus": "Согласовано"
  }
]

ПРИМЕР 3 - ОБОБЩАЮЩАЯ ФРАЗА:
Текущие статусы:
Документы: информация отсутствует
Кастинг: информация отсутствует
Локация: информация отсутствует
Реквизит: информация отсутствует

Корректировка: "все в этом проекте уже согласовано"
Ответ:
[
  {
    "blockName": "Документы",
    "newStatus": "Согласовано"
  },
  {
    "blockName": "Кастинг",
    "newStatus": "Согласовано"
  },
  {
    "blockName": "Локация",
    "newStatus": "Согласовано"
  },
  {
    "blockName": "Реквизит",
    "newStatus": "Согласовано"
  }
]

Верни ТОЛЬКО JSON, без дополнительного текста.`;

      const { chatWithContext } = AIServiceClient;
      const parseResponse = await chatWithContext({
        userId: ctx.from.id.toString(),
        message: parsePrompt,
        userType: 'producer',
        projects: []
      });

      logger.info(`AI parse response: ${parseResponse.answer}`);

      let updates: Array<{ blockName: string; newStatus: string }> = [];
      try {
        const jsonMatch = parseResponse.answer.match(/\[[\s\S]*\]/);
        if (jsonMatch) {
          updates = JSON.parse(jsonMatch[0]);
        } else {
          throw new Error('No JSON found in AI response');
        }
      } catch (parseError) {
        logger.error('Failed to parse AI response as JSON:', parseError);
        await ctx.reply('❌ Не удалось распарсить корректировку. Попробуйте переформулировать.');
        return;
      }

      if (updates.length === 0) {
        await ctx.reply('🤔 Не нашел изменений в вашей корректировке. Попробуйте уточнить что именно нужно изменить.');
        return;
      }

      let updatedCount = 0;
      for (const update of updates) {
        const block = allBlocks.find(b => b.name === update.blockName);
        if (!block) {
          logger.warn(`Block not found: ${update.blockName}`);
          continue;
        }

        // Все блоки пишем в custom_block_statuses
        await SupabaseClient.upsertCustomBlockStatus({
          project_id: projectId,
          block_id: block.id || block.name,
          block_name: block.name,
          block_type: block.type,
          status_analysis: update.newStatus
        });

        // Стандартные блоки дополнительно в projects/projects_test (dual-write)
        if (block.type === 'standard') {
          const fieldName = getStandardFieldMapping(block.name);
          if (fieldName) {
            if (DRY_RUN) {
              await SupabaseClient.ensureProjectTestExists(projectId);
              await SupabaseClient.updateProjectTestField(projectId, fieldName, update.newStatus);
            } else {
              await SupabaseClient.updateProjectField(projectId, fieldName, update.newStatus);
            }
          }
        }

        updatedCount++;
        logger.info(`Updated block: ${block.name} → ${update.newStatus}`);
      }

      logger.info(`Updated ${updatedCount} block statuses from correction`);

      await ctx.reply(`✅ Обновлено ${updatedCount} блоков. Отправляю обновленный статус...`);

      const { sendStatusToProducerAdmin } = await import('../workflows/status-scheduler');
      await sendStatusToProducerAdmin(project);

      await ctx.reply(`✅ Обновленный статус отправлен!\n\n💡 Если нужно ещё что-то поправить - напишите.`);

    } catch (error) {
      logger.error('Error handling status correction:', error);
      throw error;
    }
  }

  async notifyProducer(producerTgChatId: string, projectName: string, updates: string) {
    try {
      const header = `Статус на сегодня по проекту "${projectName}":\n\n`;
      const fullMessage = header + updates;

      const MAX_LENGTH = 4000;

      if (fullMessage.length <= MAX_LENGTH) {
        await this.bot.telegram.sendMessage(producerTgChatId, fullMessage);
      } else {
        const parts = this.splitMessage(updates, MAX_LENGTH - header.length);

        for (let i = 0; i < parts.length; i++) {
          const partHeader = i === 0
            ? header
            : `Статус на сегодня по проекту "${projectName}" (часть ${i + 1}):\n\n`;

          await this.bot.telegram.sendMessage(
            producerTgChatId,
            partHeader + parts[i]
          );

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

  private async formatProjectStatusDynamic(project: any): Promise<string> {
    const noInfo = 'информация отсутствует';

    try {
      const activeBlocks = await DashboardClient.getActiveBlocks(project.project_name);

      const allStatuses = await SupabaseClient.getCustomBlockStatuses(project.project_id);

      let msg = `Название проекта:\n${project.project_name}\n\n`;
      msg += `Информация о статусе проекта в структурированном виде:\n`;
      msg += `"${project.project_name}" - ежедневный статус\n\n`;

      if (activeBlocks.length === 0) {
        msg += `⚠️ Нет активных блоков для этого проекта\n`;
        return msg;
      }

      for (const block of activeBlocks) {
        const emoji = getBlockEmoji(block.name);
        const displayName = getBlockDisplayName(block.name);
        const blockKey = block.id || block.name;
        const statusRecord = allStatuses.find((s: any) => s.block_id === blockKey);
        const status = statusRecord?.status_analysis || noInfo;

        msg += `${emoji} ${displayName}\n`;
        msg += `- ${status}\n\n`;
      }

      msg += `Все ли верно? Если какая-то информация неточная, пожалуйста, укажи, что нужно подправить`;

      return msg;

    } catch (error) {
      logger.error(`Error formatting project status for ${project.project_name}:`, error);
      return `Ошибка при получении статусов проекта ${project.project_name}`;
    }
  }


  private truncate(text: string, maxLength: number): string {
    if (!text) return '';
    if (text.length <= maxLength) return text;
    return text.substring(0, maxLength) + '...';
  }

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

  async notifyAllProducers(updates: Record<number, string>) {
    try {
      const TEST_MODE = process.env.TEST_MODE === 'true';
      const TEST_TELEGRAM_ID = process.env.TEST_TELEGRAM_ID || '489599665';

      if (TEST_MODE) {
        logger.info(`TEST MODE: Sending all notifications only to ${TEST_TELEGRAM_ID}`);

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

      for (const [projectId, updateText] of Object.entries(updates)) {
        const project = await SupabaseClient.getProject(Number(projectId));

        if (project && project.producer && project.producer.producer_tg_chat_id) {
          const producerTgId = project.producer.producer_tg_chat_id.toString();

          await this.notifyProducer(
            producerTgId,
            project.project_name,
            updateText
          );
        }

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

  private calculateNextSendTime(settings: any): string {
    try {
      const frequencyDays = settings.status_frequency_day || 'Mon,Tue,Wed,Thu,Fri';
      const frequencyTime = settings.status_frequency_time || '10:00:00+03';

      const allowedDays = frequencyDays.split(',').map((d: string) => d.trim());

      const timeMatch = frequencyTime.match(/^(\d{1,2}):(\d{2})/);
      if (!timeMatch) {
        return 'Неверный формат времени';
      }

      const deadlineHour = parseInt(timeMatch[1], 10);
      const sendHour = deadlineHour - 1;

      const now = new Date();
      const currentDay = this.getDayOfWeek(now);

      let daysUntilNext = 0;
      let nextDay = currentDay;

      for (let i = 0; i < 7; i++) {
        const checkDate = new Date(now);
        checkDate.setDate(now.getDate() + i);
        const checkDay = this.getDayOfWeek(checkDate);

        if (allowedDays.includes(checkDay)) {
          if (i === 0 && now.getHours() < sendHour) {
            daysUntilNext = 0;
            nextDay = checkDay;
            break;
          } else if (i > 0) {
            daysUntilNext = i;
            nextDay = checkDay;
            break;
          }
        }
      }

      const nextDate = new Date(now);
      nextDate.setDate(now.getDate() + daysUntilNext);
      nextDate.setHours(sendHour, 0, 0, 0);

      const dayNames: Record<string, string> = {
        'Mon': 'Пн',
        'Tue': 'Вт',
        'Wed': 'Ср',
        'Thu': 'Чт',
        'Fri': 'Пт',
        'Sat': 'Сб',
        'Sun': 'Вс'
      };

      const formattedDate = `${dayNames[nextDay] || nextDay}, ${nextDate.getDate()}.${nextDate.getMonth() + 1} в ${sendHour}:00`;

      return formattedDate;

    } catch (error) {
      logger.error('Error calculating next send time:', error);
      return 'Не удалось рассчитать';
    }
  }

  private getDayOfWeek(date: Date): string {
    const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    return days[date.getDay()];
  }

  async launch() {
    await this.bot.launch();
    logger.info('Smart Bot launched');

    process.once('SIGINT', () => this.bot.stop('SIGINT'));
    process.once('SIGTERM', () => this.bot.stop('SIGTERM'));
  }

  getBot() {
    return this.bot;
  }
}

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
