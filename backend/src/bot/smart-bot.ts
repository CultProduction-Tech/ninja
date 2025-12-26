import { Telegraf, Context } from 'telegraf';
import { logger } from '../utils/logger';
import { AIServiceClient } from '../services/ai-client';
import { SupabaseClient, getDefaultClientSettings } from '../database/supabase';
import { DashboardClient } from '../database/dashboard-supabase';
import { runStatusUpdate } from '../workflows/orchestrator';
import { formatStatusForClient, getStandardFieldMapping } from '../workflows/status-scheduler';

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
  // Store last project context for each user (for status corrections)
  private userContext: Map<string, { projectId: number; timestamp: number }> = new Map();

  constructor(token: string) {
    this.bot = new Telegraf(token);
    this.setupHandlers();
  }

  private setupHandlers() {
    // Help command
    this.bot.command('help', async (ctx) => {
      try {
        const userId = ctx.from.id.toString();
        const TEST_TELEGRAM_ID = process.env.TEST_TELEGRAM_ID || '489599665';
        const isAdmin = userId === TEST_TELEGRAM_ID;

        let message = '📖 Доступные команды:\n\n';

        // Common commands
        message += '🔹 /start - приветствие и описание бота\n';
        message += '🔹 /status - показать статусы всех проектов\n';
        message += '🔹 /analyze - запустить анализ вручную (продюсеры)\n';
        message += '🔹 /help - показать эту справку\n';

        if (isAdmin) {
          message += '\n👑 АДМИНСКИЕ КОМАНДЫ:\n';
          message += '🔸 /admin_projects - список всех проектов с ID\n';
          message += '🔸 /admin_settings [ID] - настройки клиента для проекта\n';
          message += '🔸 /admin_blocks [ID] - активные блоки проекта\n';
          message += '🔸 /admin_status [ID] - текущий статус проекта из БД\n';
          message += '🔸 /admin_send_now [ID] - отправить статус прямо сейчас\n';
          message += '🔸 /admin_reanalyze [ID] - перезапустить анализ с новыми промптами\n';
          message += '\n💡 Админские команды доступны только для тестирования';
        }

        ctx.reply(message);

      } catch (error) {
        logger.error('❌ Error in /help:', error);
        ctx.reply('❌ Ошибка при получении справки');
      }
    });

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
          const statusMessage = await this.formatProjectStatusDynamic(project);

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

    // ========================================
    // ADMIN COMMANDS (for testing & debugging)
    // ========================================

    // /admin_projects - List all projects with IDs
    this.bot.command('admin_projects', async (ctx) => {
      try {
        const userId = ctx.from.id.toString();
        const TEST_TELEGRAM_ID = process.env.TEST_TELEGRAM_ID || '489599665';

        if (userId !== TEST_TELEGRAM_ID) {
          ctx.reply('⛔ У вас нет доступа к этой команде.');
          return;
        }

        logger.info(`👑 Admin: /admin_projects from ${userId}`);

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
        message += '/admin_send_now [ID]\n';
        message += '/admin_reanalyze [ID]';

        // Split if too long
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
        logger.error('❌ Error in /admin_projects:', error);
        ctx.reply('❌ Ошибка при получении списка проектов');
      }
    });

    // /admin_settings [project_id] - Show client settings
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

        logger.info(`👑 Admin: /admin_settings ${projectId} from ${userId}`);

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

        // Calculate next send time
        const nextSend = this.calculateNextSendTime(settings);
        message += `⏭️ Следующая отправка: ${nextSend}\n\n`;

        message += `💡 Статус будет отправлен продюсеру за 1 час до времени отправки`;

        ctx.reply(message);

      } catch (error) {
        logger.error('❌ Error in /admin_settings:', error);
        ctx.reply('❌ Ошибка при получении настроек');
      }
    });

    // /admin_status [project_id] - Show current status from DB
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

        logger.info(`👑 Admin: /admin_status ${projectId} from ${userId}`);

        const project = await SupabaseClient.getProject(projectId);
        if (!project) {
          ctx.reply(`❌ Проект ${projectId} не найден`);
          return;
        }

        await ctx.reply(`📊 Формирую готовый статус для клиента проекта "${project.project_name}"...`);

        // Get client settings to determine format
        const clientSettings = await SupabaseClient.getClientSettings(projectId);
        const defaults = getDefaultClientSettings();
        const format = clientSettings.format_status || defaults.format_status;

        // Get active blocks from Dashboard
        const activeBlocks = await DashboardClient.getActiveBlocks(project.project_name);

        if (activeBlocks.length === 0) {
          ctx.reply(`⚠️ Нет активных блоков для проекта "${project.project_name}"`);
          return;
        }

        // Get last 50 messages from ALL chats of this project (to show what was analyzed)
        const messages = await SupabaseClient.getLastMessagesForProject(projectId, 100);

        // Show conversation used for analysis
        if (messages.length > 0) {
          // Show last 5 messages as preview (to avoid Telegram 4096 char limit)
          const previewMessages = messages.slice(-5);

          await ctx.reply(`📨 ПЕРЕПИСКА ДЛЯ АНАЛИЗА:\nВсего сообщений: ${messages.length}\nПоказываю последние ${previewMessages.length}:\n─────────────────────`);

          for (const msg of previewMessages) {
            const timestamp = new Date(msg.timestamp).toLocaleString('ru-RU', {
              day: '2-digit',
              month: '2-digit',
              hour: '2-digit',
              minute: '2-digit'
            });

            // Truncate very long messages to avoid hitting Telegram limit
            const messageText = msg.message_text.length > 500
              ? msg.message_text.substring(0, 500) + '...'
              : msg.message_text;

            // Get user role instead of showing just sender_id
            const userRole = await SupabaseClient.getUserRole(msg.sender_id);
            let messagePreview = `[${timestamp}] ${userRole}:\n${messageText}`;

            // Split if still too long (Telegram limit is 4096 chars)
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

        // Get project data from Status Ninja (for standard blocks)
        const projectData = await SupabaseClient.getProject(projectId);

        // Get custom block statuses from Status Ninja (for custom blocks)
        const customStatuses = await SupabaseClient.getCustomBlockStatuses(projectId);

        // Build status map
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

        // Format the status message using the same logic as scheduler
        const statusText = formatStatusForClient(activeBlocks, statusMap, format);

        // Add header with project info and format indicator
        let finalMessage = `📋 Проект: ${project.project_name}\n`;
        finalMessage += `📊 Формат: ${format}\n\n`;
        finalMessage += `─────────────────────\n`;
        finalMessage += `ГОТОВЫЙ СТАТУС ДЛЯ КЛИЕНТА:\n`;
        finalMessage += `─────────────────────\n\n`;
        finalMessage += statusText;

        ctx.reply(finalMessage);

      } catch (error) {
        logger.error('❌ Error in /admin_status:', error);
        ctx.reply('❌ Ошибка при получении статуса');
      }
    });

    // /admin_blocks [project_id] - Show active blocks for project
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

        logger.info(`👑 Admin: /admin_blocks ${projectId} from ${userId}`);

        const project = await SupabaseClient.getProject(projectId);
        if (!project) {
          ctx.reply(`❌ Проект ${projectId} не найден`);
          return;
        }

        await ctx.reply(`📊 Получаю активные блоки для проекта "${project.project_name}"...`);

        // Get active blocks from Dashboard
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
        logger.error('❌ Error in /admin_blocks:', error);
        ctx.reply(`❌ Ошибка: ${error}`);
      }
    });

    // /admin_send_now [project_id] - Force send status now
    this.bot.command('admin_send_now', async (ctx) => {
      try {
        const userId = ctx.from.id.toString();
        const TEST_TELEGRAM_ID = process.env.TEST_TELEGRAM_ID || '489599665';

        if (userId !== TEST_TELEGRAM_ID) {
          ctx.reply('⛔ У вас нет доступа к этой команде.');
          return;
        }

        const args = ctx.message.text.split(' ');
        if (args.length < 2) {
          ctx.reply('⚠️ Укажите ID проекта:\n/admin_send_now [project_id]\n\nИспользуйте /admin_projects для списка');
          return;
        }

        const projectId = parseInt(args[1], 10);
        if (isNaN(projectId)) {
          ctx.reply('⚠️ ID проекта должен быть числом');
          return;
        }

        logger.info(`👑 Admin: /admin_send_now ${projectId} from ${userId}`);

        const project = await SupabaseClient.getProject(projectId);
        if (!project) {
          ctx.reply(`❌ Проект ${projectId} не найден`);
          return;
        }

        await ctx.reply(`📤 Отправляю статус проекта "${project.project_name}"...`);

        // Import the send function
        const { sendStatusToProducerAdmin } = await import('../workflows/status-scheduler');
        await sendStatusToProducerAdmin(project);

        // Save context for potential corrections
        this.userContext.set(userId, {
          projectId,
          timestamp: Date.now()
        });

        ctx.reply(`✅ Статус отправлен продюсеру!\n\n💡 Если нужно что-то поправить - просто напишите мне что изменить.`);

      } catch (error) {
        logger.error('❌ Error in /admin_send_now:', error);
        ctx.reply(`❌ Ошибка при отправке статуса: ${error}`);
      }
    });

    // /admin_reanalyze [project_id] - Reanalyze project with new prompts (saves to projects_test)
    this.bot.command('admin_reanalyze', async (ctx) => {
      try {
        const userId = ctx.from.id.toString();
        const TEST_TELEGRAM_ID = process.env.TEST_TELEGRAM_ID || '489599665';

        if (userId !== TEST_TELEGRAM_ID) {
          ctx.reply('⛔ У вас нет доступа к этой команде.');
          return;
        }

        const args = ctx.message.text.split(' ');
        if (args.length < 2) {
          ctx.reply('⚠️ Укажите ID проекта:\n/admin_reanalyze [project_id]\n\nИспользуйте /admin_projects для списка');
          return;
        }

        const projectId = parseInt(args[1], 10);
        if (isNaN(projectId)) {
          ctx.reply('⚠️ ID проекта должен быть числом');
          return;
        }

        logger.info(`👑 Admin: /admin_reanalyze ${projectId} from ${userId}`);

        // Get project
        const project = await SupabaseClient.getProject(projectId);
        if (!project) {
          ctx.reply(`❌ Проект ${projectId} не найден`);
          return;
        }

        await ctx.reply(`🔄 Начинаю повторный анализ проекта "${project.project_name}" с новыми промптами...\n\n⏳ Это может занять некоторое время...`);

        // Step 1: Ensure projects_test exists (copy from projects if needed)
        await SupabaseClient.ensureProjectTestExists(projectId);
        logger.info(`✅ Project_test entry ensured for project ${projectId}`);

        // Step 2: Get last 100 messages from ALL chats of this project (increased from 50)
        const messages = await SupabaseClient.getLastMessagesForProject(projectId, 100);

        if (messages.length === 0) {
          ctx.reply(`⚠️ Нет сообщений в чатах проекта для анализа`);
          return;
        }

        logger.info(`Found ${messages.length} messages from all project chats for analysis`);

        // Step 4: Get active blocks from Dashboard
        const activeBlocks = await DashboardClient.getActiveBlocks(project.project_name);

        if (activeBlocks.length === 0) {
          ctx.reply(`⚠️ Нет активных блоков для проекта "${project.project_name}"`);
          return;
        }

        logger.info(`Found ${activeBlocks.length} active blocks`);

        // Step 5: Prepare conversation text with user roles (NEW: Продюсер/Клиент/Команда)
        logger.info(`🔄 Formatting ${messages.length} messages with user roles...`);
        const conversationText = await SupabaseClient.formatConversationWithRoles(messages);

        // Step 6: Call AI service to analyze ALL blocks
        await ctx.reply(`🤖 Анализирую ${activeBlocks.length} блоков с новыми промптами...`);

        const analysisResults = await AIServiceClient.analyzeDynamicBlocks({
          projectId: project.project_id,
          projectName: project.project_name,
          blocks: activeBlocks,
          conversation: conversationText
        });

        logger.info(`✅ AI analysis completed for ${activeBlocks.length} blocks`);

        // Step 7: Save results
        let standardCount = 0;
        let customCount = 0;

        for (const block of activeBlocks) {
          const blockKey = block.id || block.name;
          const newStatus = analysisResults[blockKey];

          if (!newStatus) {
            logger.warn(`No analysis result for block: ${block.name}`);
            continue;
          }

          if (block.type === 'standard') {
            // Save to projects_test table
            const fieldName = this.getStandardFieldMapping(block.name);
            if (fieldName) {
              await SupabaseClient.updateProjectTestField(projectId, fieldName, newStatus);
              standardCount++;
              logger.info(`✅ Saved to projects_test.${fieldName}`);
            }
          } else {
            // Save to custom_block_statuses table
            await SupabaseClient.upsertCustomBlockStatus({
              project_id: projectId,
              block_id: block.id!,
              block_name: block.name,
              block_type: block.type,
              status_analysis: newStatus
            });
            customCount++;
            logger.info(`✅ Saved custom block status: ${block.name}`);
          }
        }

        // Step 8: Send confirmation
        let summary = `✅ Повторный анализ завершен!\n\n`;
        summary += `📊 Проанализировано блоков: ${activeBlocks.length}\n`;
        summary += `📝 Стандартных: ${standardCount} (сохранено в projects_test)\n`;
        summary += `⭐ Кастомных: ${customCount} (сохранено в custom_block_statuses)\n\n`;
        summary += `💡 Данные сохранены в тестовую таблицу и НЕ влияют на продакшн (n8n).\n\n`;
        summary += `Используйте /admin_status ${projectId} чтобы увидеть результаты.`;

        ctx.reply(summary);

      } catch (error) {
        logger.error('❌ Error in /admin_reanalyze:', error);
        const errorMsg = error instanceof Error ? error.message : String(error);
        ctx.reply(`❌ Ошибка при повторном анализе: ${errorMsg}`);
      }
    });

    // Handle text messages (chat)
    this.bot.on('text', async (ctx: Context) => {
      if (!ctx.message || !('text' in ctx.message)) return;
      if (!ctx.from) return;

      try {
        const userId = ctx.from.id.toString();
        const userMessage = ctx.message.text;

        // Skip if it's a command (already handled)
        if (userMessage.startsWith('/')) return;

        logger.info(`💬 Smart Bot: User ${userId} sent: ${userMessage}`);

        // Check if user has recent context (status was shown in last 10 minutes)
        const context = this.userContext.get(userId);
        const TEN_MINUTES = 10 * 60 * 1000;

        if (context && (Date.now() - context.timestamp) < TEN_MINUTES) {
          // User has recent project context - this might be a status correction
          logger.info(`📝 User ${userId} has recent context for project ${context.projectId}, checking if this is a correction...`);

          // Check if message contains correction keywords
          const correctionKeywords = ['поправ', 'исправ', 'на самом деле', 'верно', 'неверно', 'ошибка', 'не так', 'должно быть', 'изменить'];
          const isLikelyCorrection = correctionKeywords.some(keyword =>
            userMessage.toLowerCase().includes(keyword)
          );

          if (isLikelyCorrection) {
            await ctx.sendChatAction('typing');
            await ctx.reply('📝 Понял, обновляю статусы...');

            try {
              await this.handleStatusCorrection(ctx, context.projectId, userMessage);
              // Keep context for potential additional corrections
              this.userContext.set(userId, {
                projectId: context.projectId,
                timestamp: Date.now()
              });
              return;
            } catch (error) {
              logger.error('Error handling correction:', error);
              await ctx.reply('❌ Произошла ошибка при обновлении статусов');
              // Fall through to normal chat
            }
          }
        }

        // Normal chat flow
        const userType = await this.getUserType(userId);
        await ctx.sendChatAction('typing');
        const userProjects = await this.getUserProjects(userId);

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
   * Handle status correction from producer
   * Parses correction, updates DB, and resends status
   */
  private async handleStatusCorrection(ctx: any, projectId: number, correctionText: string) {
    try {
      logger.info(`📝 Handling status correction for project ${projectId}: "${correctionText}"`);

      // Get project
      const project = await SupabaseClient.getProject(projectId);
      if (!project) {
        await ctx.reply('❌ Проект не найден');
        return;
      }

      // Get active blocks from Dashboard
      const activeBlocks = await DashboardClient.getActiveBlocks(project.project_name);
      if (activeBlocks.length === 0) {
        await ctx.reply('❌ Нет активных блоков для этого проекта');
        return;
      }

      // Get current custom block statuses
      const customStatuses = await SupabaseClient.getCustomBlockStatuses(projectId);

      // Use AI to parse correction (ONE API call instead of re-analyzing all blocks)
      await ctx.reply('🤖 Анализирую вашу корректировку...');

      // Build current status context for all blocks
      const allBlocks = activeBlocks;
      let currentStatusContext = 'ТЕКУЩИЕ СТАТУСЫ:\n\n';

      for (const block of allBlocks) {
        if (block.type === 'standard') {
          // Standard block - read from projects table
          const fieldName = this.getStandardFieldMapping(block.name);
          const status = fieldName && project ? (project[fieldName] || 'информация отсутствует') : 'информация отсутствует';
          currentStatusContext += `${block.name}: ${status}\n`;
        } else {
          // Custom block
          const status = customStatuses.find(s => s.block_id === block.id);
          currentStatusContext += `${block.name}: ${status?.status_analysis || 'информация отсутствует'}\n`;
        }
      }

      // Ask AI to parse the correction into structured updates
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

Примеры:
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

Верни ТОЛЬКО JSON, без дополнительного текста.`;

      // Call AI to parse correction
      const { chatWithContext } = AIServiceClient;
      const parseResponse = await chatWithContext({
        userId: ctx.from.id.toString(),
        message: parsePrompt,
        userType: 'producer',
        projects: []
      });

      logger.info(`AI parse response: ${parseResponse.answer}`);

      // Parse JSON from AI response
      let updates: Array<{ blockName: string; newStatus: string }> = [];
      try {
        // Extract JSON from response (AI might add extra text)
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

      // Update statuses in DB
      let updatedCount = 0;
      for (const update of updates) {
        // Find block by name
        const block = allBlocks.find(b => b.name === update.blockName);
        if (!block) {
          logger.warn(`Block not found: ${update.blockName}`);
          continue;
        }

        if (block.type === 'standard') {
          // Update standard block in projects table
          const fieldName = this.getStandardFieldMapping(block.name);
          if (fieldName) {
            await SupabaseClient.updateProjectField(projectId, fieldName, update.newStatus);
            updatedCount++;
            logger.info(`✅ Updated standard block: ${block.name} → ${update.newStatus}`);
          }
        } else {
          // Update custom block
          await SupabaseClient.upsertCustomBlockStatus({
            project_id: projectId,
            block_id: block.id!,
            block_name: block.name,
            block_type: block.type,
            status_analysis: update.newStatus
          });
          updatedCount++;
          logger.info(`✅ Updated custom block: ${block.name} → ${update.newStatus}`);
        }
      }

      logger.info(`✅ Updated ${updatedCount} block statuses from correction`);

      // Resend updated status
      await ctx.reply(`✅ Обновлено ${updatedCount} блоков. Отправляю обновленный статус...`);

      const { sendStatusToProducerAdmin } = await import('../workflows/status-scheduler');
      await sendStatusToProducerAdmin(project);

      await ctx.reply(`✅ Обновленный статус отправлен!\n\n💡 Если нужно ещё что-то поправить - напишите.`);

    } catch (error) {
      logger.error('Error handling status correction:', error);
      throw error;
    }
  }

  /**
   * Send status update to producer
   * Called after analysis completes
   */
  async notifyProducer(producerTgChatId: string, projectName: string, updates: string) {
    try {
      const header = `Статус на сегодня по проекту "${projectName}":\n\n`;
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
            : `Статус на сегодня по проекту "${projectName}" (часть ${i + 1}):\n\n`;

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
   * 🆕 Format project status dynamically from Dashboard blocks
   */
  private async formatProjectStatusDynamic(project: any): Promise<string> {
    const noInfo = 'информация отсутствует';

    try {
      // Get active blocks from Dashboard
      const activeBlocks = await DashboardClient.getActiveBlocks(project.project_name);

      // Get custom block statuses from Status Ninja
      const customStatuses = await SupabaseClient.getCustomBlockStatuses(project.project_id);

      // Get full project data to read standard block fields
      const projectData = await SupabaseClient.getProject(project.project_id);

      let msg = `Название проекта:\n${project.project_name}\n\n`;
      msg += `Информация о статусе проекта в структурированном виде:\n`;
      msg += `"${project.project_name}" - ежедневный статус\n\n`;

      if (activeBlocks.length === 0) {
        msg += `⚠️ Нет активных блоков для этого проекта\n`;
        return msg;
      }

      // Emoji mapping for standard blocks
      const blockEmojis: Record<string, string> = {
        'documents': '📋',
        'storyboard': '🎨',
        'casting': '🎭',
        'location': '📍',
        'props': '🎪',
        'wardrobe': '👕',
        'editing': '✂️',
        'voice': '🎤',
        'music': '🎵',
        'color': '🌈',
        'photos': '📷',
        'cg': '💫',
        'animatic': '🎬',
        'modelling': '🏗️',
        'styleshots': '📸',
        'animation': '🎞️'
      };

      // Format each active block
      for (const block of activeBlocks) {
        if (block.type === 'standard') {
          // Standard block - read from projects table fields
          const emoji = blockEmojis[block.name] || '▫️';
          const blockNameRu = this.getStandardBlockNameRu(block.name);

          // Map block name to field name in projects table
          const fieldName = this.getStandardFieldMapping(block.name);
          const status = fieldName && projectData ? (projectData[fieldName] || noInfo) : noInfo;

          msg += `${emoji} ${blockNameRu}\n`;
          msg += `- ${status}\n\n`;

        } else {
          // Custom block (pre/post) - read from custom_block_statuses
          const customStatus = customStatuses.find(cs => cs.block_id === block.id);
          const status = customStatus?.status_analysis || noInfo;

          msg += `⭐ ${block.name}\n`;
          msg += `- ${status}\n\n`;
        }
      }

      msg += `Все ли верно? Если какая-то информация неточная, пожалуйста, укажи, что нужно подправить`;

      return msg;

    } catch (error) {
      logger.error(`Error formatting project status for ${project.project_name}:`, error);
      return `Ошибка при получении статусов проекта ${project.project_name}`;
    }
  }

  /**
   * Get Russian name for standard block
   */
  private getStandardBlockNameRu(blockName: string): string {
    const names: Record<string, string> = {
      'documents': 'Документы',
      'storyboard': 'Сториборд',
      'casting': 'Кастинг',
      'location': 'Локации / Декорации',
      'props': 'Эскизы и реквизит',
      'wardrobe': 'Костюм',
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
   * Map standard block names from Dashboard to Status Ninja field names
   */
  private getStandardFieldMapping(dashboardBlockName: string): string | null {
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
   * Format project status in structured way (OLD - for fallback)
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
   * Calculate next send time for status based on client settings
   */
  private calculateNextSendTime(settings: any): string {
    try {
      const frequencyDays = settings.status_frequency_day || 'Mon,Tue,Wed,Thu,Fri';
      const frequencyTime = settings.status_frequency_time || '10:00:00+03';

      // Parse days
      const allowedDays = frequencyDays.split(',').map((d: string) => d.trim());

      // Parse time (format: "10:00:00+03")
      const timeMatch = frequencyTime.match(/^(\d{1,2}):(\d{2})/);
      if (!timeMatch) {
        return 'Неверный формат времени';
      }

      const deadlineHour = parseInt(timeMatch[1], 10);
      const sendHour = deadlineHour - 1; // Send 1 hour before

      // Get current time
      const now = new Date();
      const currentDay = this.getDayOfWeek(now);

      // Find next allowed day
      let daysUntilNext = 0;
      let nextDay = currentDay;

      for (let i = 0; i < 7; i++) {
        const checkDate = new Date(now);
        checkDate.setDate(now.getDate() + i);
        const checkDay = this.getDayOfWeek(checkDate);

        if (allowedDays.includes(checkDay)) {
          // Check if it's today and we haven't passed the send time
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

  /**
   * Get day of week in format "Mon", "Tue", etc.
   */
  private getDayOfWeek(date: Date): string {
    const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    return days[date.getDay()];
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
