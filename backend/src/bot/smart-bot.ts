import { Telegraf, Context, Markup } from 'telegraf';
import { logger } from '../utils/logger';
import { AIServiceClient } from '../services/ai-client';
import { SupabaseClient, getDefaultClientSettings } from '../database/supabase';
import { DashboardClient } from '../database/dashboard-supabase';
import { runStatusUpdate } from '../workflows/orchestrator';
import { formatStatusForClient, resolveMessageLinksHtml } from '../workflows/status-scheduler';
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
  private pendingClientStatuses: Map<string, { clientTgId: string; projectName: string; clientText: string }> = new Map();

  constructor(token: string) {
    this.bot = new Telegraf(token, {
      handlerTimeout: 300000
    });
    this.setupHandlers();
  }

  private setupHandlers() {
    // Команды работают только в личке — в группах бот молчит
    this.bot.use(async (ctx, next) => {
      if (ctx.chat?.type !== 'private' && ctx.message && 'text' in ctx.message && ctx.message.text.startsWith('/')) {
        return; // Игнорируем команды в группах
      }
      return next();
    });

    this.bot.command('help', async (ctx) => {
      try {
        const userId = ctx.from.id.toString();
        const TEST_TELEGRAM_ID = process.env.TEST_TELEGRAM_ID || '489599665';
        const isAdmin = userId === TEST_TELEGRAM_ID;

        let message = '📖 Доступные команды:\n\n';

        message += '🔹 /start - приветствие и описание бота\n';
        message += '🔹 /status - статусы всех проектов\n';
        message += '🔹 /status <название> - статус конкретного проекта\n';
        message += '🔹 /analyze - запустить анализ вручную (продюсеры)\n';
        message += '🔹 /help - показать эту справку\n';

        message += '🔹 /reset - сбросить контекст диалога\n';

        if (isAdmin) {
          message += '\n👑 АДМИНСКИЕ КОМАНДЫ:\n';
          message += '🔸 /admin_projects - список всех проектов с ID\n';
          message += '🔸 /admin_settings [ID] - настройки клиента для проекта\n';
          message += '🔸 /admin_settings_set [ID] [поле] [значение] - изменить настройку\n';
          message += '🔸 /admin_blocks [ID] - активные блоки проекта\n';
          message += '🔸 /admin_status [ID] - текущий статус проекта из БД\n';
          message += '🔸 /admin_analyze [ID] - анализ последних 100 сообщений\n';
          message += '🔸 /admin_analyze_full [ID] - ПОЛНЫЙ анализ ВСЕХ сообщений ⚡\n';
          message += '🔸 /admin_send [ID] - отправка статусов (один проект или все)\n';
          message += '\n📚 ГЛОССАРИЙ:\n';
          message += '🔸 /admin_glossary - статистика + pending термины\n';
          message += '🔸 /admin_glossary_discover [ID] - найти новые термины из переписки\n';
          message += '🔸 /admin_glossary_approve <термин> - одобрить термин\n';
          message += '🔸 /admin_glossary_reject <термин> - отклонить термин\n';
          message += '🔸 /admin_glossary_edit <термин> | <описание> - изменить описание\n';
          message += '🔸 /admin_glossary_approve_all - одобрить все pending\n';
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

        const TEST_TELEGRAM_ID = process.env.TEST_TELEGRAM_ID || '489599665';
        const isAdmin = userId === TEST_TELEGRAM_ID;

        if (userType === 'producer' || isAdmin) {
          const projects = await this.getUserProjects(userId);
          const projectList = projects.length > 0
            ? projects.map((p: any) => `• ${p.project_name}`).join('\n')
            : 'Пока нет привязанных проектов.';

          await ctx.reply(
            'Привет! Я — Статус Ниндзя 🥷\n\n' +
            'Читаю рабочие чаты и собираю статусы автоматически.\n\n' +
            `Ваши проекты:\n${projectList}\n\n` +
            'Просто напишите мне:\n' +
            '• «статус» — покажу статусы ваших проектов\n' +
            '• Любой вопрос — отвечу по вашим проектам\n' +
            '• /help — все команды'
          );
        } else if (userType === 'client') {
          await ctx.reply(
            'Здравствуйте! Я — бот для отслеживания статусов проектов.\n\n' +
            'Просто напишите «статус» или задайте вопрос по проекту.'
          );
        } else {
          await ctx.reply(
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
        const searchQuery = ctx.message.text.split(' ').slice(1).join(' ').trim();
        logger.info(`Smart Bot: /status ${searchQuery ? `"${searchQuery}"` : '(all)'} from user ${userId}`);

        const TEST_TELEGRAM_ID = process.env.TEST_TELEGRAM_ID || '489599665';
        const isAdmin = userId === TEST_TELEGRAM_ID;

        let projects;

        if (isAdmin) {
          projects = await SupabaseClient.getAllProjects();
        } else {
          projects = await this.getUserProjects(userId);
        }

        if (!projects || projects.length === 0) {
          ctx.reply('Нет активных проектов.');
          return;
        }

        // Фильтр по имени проекта (если указано)
        if (searchQuery) {
          const query = searchQuery.toLowerCase();
          const filtered = projects.filter((p: any) =>
            p.project_name?.toLowerCase().includes(query)
          );

          if (filtered.length === 0) {
            let msg = `❌ Проект "${searchQuery}" не найден.\n\nВаши проекты:\n`;
            for (const p of projects) {
              msg += `• ${p.project_name}\n`;
            }
            msg += `\nИспользуйте: /status название проекта`;
            ctx.reply(msg);
            return;
          }

          projects = filtered;
        }

        if (projects.length > 1) {
          await ctx.reply(`📊 Найдено проектов: ${projects.length}\nОтправляю статусы...`);
        }

        await this.sendStatusForProjects(ctx, projects);

      } catch (error) {
        logger.error('Error in /status:', error);
        const errorMsg = error instanceof Error ? error.message : String(error);
        logger.error('Error details:', errorMsg);
        ctx.reply(`Произошла ошибка при получении статусов:\n${errorMsg}`);
      }
    });

    // === /settings — для продюсеров: просмотр и изменение настроек ===
    this.bot.command('settings', async (ctx) => {
      try {
        const userId = ctx.from.id.toString();
        const TEST_TELEGRAM_ID = process.env.TEST_TELEGRAM_ID || '489599665';
        const isAdmin = userId === TEST_TELEGRAM_ID;
        logger.info(`/settings from user ${userId}`);

        let projects;
        if (isAdmin) {
          projects = await SupabaseClient.getAllProjects();
        } else {
          projects = await this.getUserProjects(userId);
        }

        if (!projects || projects.length === 0) {
          ctx.reply('Нет активных проектов.');
          return;
        }

        const args = ctx.message.text.split(' ').slice(1);

        // Без аргументов — показать настройки всех проектов
        if (args.length === 0) {
          let msg = '⚙️ Настройки ваших проектов:\n';

          for (const project of projects) {
            const settings = await SupabaseClient.getClientSettings(project.project_id);
            const defaults = getDefaultClientSettings();

            msg += `\n📋 ${project.project_name}\n`;
            msg += `  📅 Дни: ${settings.status_frequency_day || defaults.status_frequency_day}\n`;
            msg += `  ⏰ Время: ${settings.status_frequency_time || defaults.status_frequency_time}\n`;
            msg += `  📝 Формат: ${settings.format_status || defaults.format_status}\n`;

            if (settings.quiet_from) {
              msg += `  🔇 Тихие часы: ${settings.quiet_from} — ${settings.quiet_to || '?'}\n`;
            }

            if (settings.weekend) {
              const wl = settings.weekend === 'no' ? 'не отправлять' : settings.weekend === 'urgent' ? 'только срочное' : settings.weekend;
              msg += `  📅 Выходные: ${wl}\n`;
            }

            msg += `  👤 Клиенту: ${settings.send_to_client ? 'да' : 'нет'}\n`;
          }

          msg += '\n💡 Изменить: /settings название_проекта поле значение';
          msg += '\nПоля: format, days, time, quiet_from, quiet_to, weekend, send_to_client';
          ctx.reply(msg);
          return;
        }

        // С аргументами — найти проект и изменить настройку
        // Нужно определить, где заканчивается имя проекта и начинается поле
        const settingsFields = ['format', 'days', 'time', 'quiet_from', 'quiet_to', 'weekend', 'send_to_client'];

        let projectName = '';
        let fieldIndex = -1;

        for (let i = 0; i < args.length; i++) {
          if (settingsFields.includes(args[i].toLowerCase())) {
            fieldIndex = i;
            break;
          }
        }

        if (fieldIndex <= 0) {
          // Нет поля — просто показать настройки одного проекта
          const query = args.join(' ').toLowerCase();
          const project = projects.find((p: any) => p.project_name?.toLowerCase().includes(query));

          if (!project) {
            let msg = `❌ Проект "${args.join(' ')}" не найден.\n\nВаши проекты:\n`;
            for (const p of projects) {
              msg += `• ${p.project_name}\n`;
            }
            ctx.reply(msg);
            return;
          }

          const settings = await SupabaseClient.getClientSettings(project.project_id);
          const defaults = getDefaultClientSettings();

          let msg = `⚙️ Настройки проекта "${project.project_name}":\n\n`;
          msg += `📅 Дни: ${settings.status_frequency_day || defaults.status_frequency_day}\n`;
          msg += `⏰ Время: ${settings.status_frequency_time || defaults.status_frequency_time}\n`;
          msg += `📝 Формат: ${settings.format_status || defaults.format_status}\n`;

          if (settings.quiet_from || settings.quiet_to) {
            msg += `🔇 Тихие часы: ${settings.quiet_from || '?'} — ${settings.quiet_to || '?'}\n`;
          }

          if (settings.weekend) {
            const wl = settings.weekend === 'no' ? 'не отправлять' : settings.weekend === 'urgent' ? 'только срочное' : settings.weekend;
            msg += `📅 Выходные: ${wl}\n`;
          }

          msg += `👤 Клиенту: ${settings.send_to_client ? 'да' : 'нет'}\n`;
          msg += `\n💡 Изменить: /settings ${project.project_name} format короткий`;
          ctx.reply(msg);
          return;
        }

        // Есть поле — изменяем настройку
        projectName = args.slice(0, fieldIndex).join(' ');
        const field = args[fieldIndex].toLowerCase();
        const value = args.slice(fieldIndex + 1).join(' ');

        if (!value) {
          ctx.reply(`⚠️ Укажите значение: /settings ${projectName} ${field} значение`);
          return;
        }

        const query = projectName.toLowerCase();
        const project = projects.find((p: any) => p.project_name?.toLowerCase().includes(query));

        if (!project) {
          ctx.reply(`❌ Проект "${projectName}" не найден`);
          return;
        }

        // Валидация и маппинг (та же логика что в admin_settings_set)
        const fieldMap: Record<string, { dbField: string; validate: (v: string) => string | null }> = {
          'format': {
            dbField: 'format_status',
            validate: (v) => ['короткий', 'длинный'].includes(v) ? null : 'Значения: короткий, длинный'
          },
          'days': {
            dbField: 'status_frequency_day',
            validate: (v) => {
              const valid = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
              const days = v.split(',').map(d => d.trim());
              const invalid = days.filter(d => !valid.includes(d));
              return invalid.length ? `Неизвестные дни: ${invalid.join(', ')}` : null;
            }
          },
          'time': {
            dbField: 'status_frequency_time',
            validate: (v) => /^\d{1,2}:\d{2}(:\d{2})?(\+\d{2})?$/.test(v) ? null : 'Формат: 10:00:00+03'
          },
          'quiet_from': {
            dbField: 'quiet_from',
            validate: (v) => v === 'off' || /^\d{1,2}:\d{2}/.test(v) ? null : 'Формат: 22:00:00+03 или off'
          },
          'quiet_to': {
            dbField: 'quiet_to',
            validate: (v) => v === 'off' || /^\d{1,2}:\d{2}/.test(v) ? null : 'Формат: 08:00:00+03 или off'
          },
          'weekend': {
            dbField: 'weekend',
            validate: (v) => ['no', 'urgent', 'normal'].includes(v) ? null : 'Значения: no, urgent, normal'
          },
          'send_to_client': {
            dbField: 'send_to_client',
            validate: (v) => ['on', 'off'].includes(v) ? null : 'Значения: on, off'
          },
        };

        const mapping = fieldMap[field];
        if (!mapping) {
          ctx.reply(`❌ Неизвестное поле: ${field}\nДоступные: ${Object.keys(fieldMap).join(', ')}`);
          return;
        }

        const validationError = mapping.validate(value);
        if (validationError) {
          ctx.reply(`⚠️ ${validationError}`);
          return;
        }

        let dbValue: any = value;
        if (field === 'quiet_from' || field === 'quiet_to') {
          dbValue = value === 'off' ? null : value;
        } else if (field === 'weekend') {
          dbValue = value === 'normal' ? null : value;
        } else if (field === 'send_to_client') {
          dbValue = value === 'on';
        }

        await SupabaseClient.upsertClientSettings(project.project_id, mapping.dbField, dbValue);

        const displayValue = dbValue === null ? 'выключено' : dbValue === true ? 'включено' : dbValue === false ? 'выключено' : dbValue;
        ctx.reply(`✅ Настройка обновлена:\n📋 ${project.project_name}\n⚙️ ${field} → ${displayValue}`);

      } catch (error) {
        logger.error('Error in /settings:', error);
        ctx.reply('❌ Ошибка при работе с настройками');
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
        message += `📝 Формат: ${settings.format_status || 'длинный'}\n`;

        if (settings.quiet_from || settings.quiet_to) {
          message += `🔇 Тихие часы: ${settings.quiet_from || '?'} — ${settings.quiet_to || '?'}\n`;
        }

        if (settings.weekend) {
          const weekendLabel = settings.weekend === 'no' ? 'не отправлять' : settings.weekend === 'urgent' ? 'только срочное' : settings.weekend;
          message += `📅 Выходные: ${weekendLabel}\n`;
        }

        message += `👤 Отправка клиенту: ${settings.send_to_client ? 'включена (короткий формат)' : 'выключена'}\n\n`;

        const nextSend = this.calculateNextSendTime(settings);
        message += `⏭️ Следующая отправка: ${nextSend}\n\n`;

        message += `💡 Изменить: /admin_settings_set ${projectId} [поле] [значение]`;

        ctx.reply(message);

      } catch (error) {
        logger.error('Error in /admin_settings:', error);
        ctx.reply('❌ Ошибка при получении настроек');
      }
    });

    this.bot.command('admin_settings_set', async (ctx) => {
      try {
        const userId = ctx.from.id.toString();
        const TEST_TELEGRAM_ID = process.env.TEST_TELEGRAM_ID || '489599665';

        if (userId !== TEST_TELEGRAM_ID) {
          ctx.reply('⛔ У вас нет доступа к этой команде.');
          return;
        }

        const args = ctx.message.text.split(' ');
        if (args.length < 4) {
          let help = '⚙️ Изменение настроек проекта:\n\n';
          help += '/admin_settings_set [ID] [поле] [значение]\n\n';
          help += 'Доступные поля:\n';
          help += '• format — формат статуса (короткий / длинный)\n';
          help += '• days — дни отправки (Mon,Tue,Wed,Thu,Fri)\n';
          help += '• time — время отправки (10:00:00+03)\n';
          help += '• quiet_from — начало тихих часов (22:00:00+03)\n';
          help += '• quiet_to — конец тихих часов (08:00:00+03)\n';
          help += '• weekend — выходные (no / urgent / normal)\n';
          help += '• send_to_client — отправка клиенту (on / off)\n';
          help += '\nПримеры:\n';
          help += '/admin_settings_set 38 format короткий\n';
          help += '/admin_settings_set 38 days Mon,Wed,Fri\n';
          help += '/admin_settings_set 38 weekend urgent\n';
          help += '/admin_settings_set 38 send_to_client on';
          ctx.reply(help);
          return;
        }

        const projectId = parseInt(args[1], 10);
        if (isNaN(projectId)) {
          ctx.reply('⚠️ ID проекта должен быть числом');
          return;
        }

        const field = args[2].toLowerCase();
        const value = args.slice(3).join(' ');

        // Маппинг коротких имен на поля в БД
        const fieldMap: Record<string, { dbField: string; validate: (v: string) => string | null }> = {
          'format': {
            dbField: 'format_status',
            validate: (v) => ['короткий', 'длинный'].includes(v) ? null : 'Допустимые значения: короткий, длинный'
          },
          'days': {
            dbField: 'status_frequency_day',
            validate: (v) => {
              const valid = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
              const days = v.split(',').map(d => d.trim());
              const invalid = days.filter(d => !valid.includes(d));
              return invalid.length ? `Неизвестные дни: ${invalid.join(', ')}. Используйте: ${valid.join(', ')}` : null;
            }
          },
          'time': {
            dbField: 'status_frequency_time',
            validate: (v) => /^\d{1,2}:\d{2}(:\d{2})?(\+\d{2})?$/.test(v) ? null : 'Формат: HH:MM:SS+TZ (напр. 10:00:00+03)'
          },
          'quiet_from': {
            dbField: 'quiet_from',
            validate: (v) => v === 'off' || /^\d{1,2}:\d{2}/.test(v) ? null : 'Формат: HH:MM:SS+TZ или off'
          },
          'quiet_to': {
            dbField: 'quiet_to',
            validate: (v) => v === 'off' || /^\d{1,2}:\d{2}/.test(v) ? null : 'Формат: HH:MM:SS+TZ или off'
          },
          'weekend': {
            dbField: 'weekend',
            validate: (v) => ['no', 'urgent', 'normal'].includes(v) ? null : 'Допустимые значения: no, urgent, normal'
          },
          'send_to_client': {
            dbField: 'send_to_client',
            validate: (v) => ['on', 'off'].includes(v) ? null : 'Допустимые значения: on, off'
          },
        };

        const mapping = fieldMap[field];
        if (!mapping) {
          ctx.reply(`❌ Неизвестное поле: ${field}\nДоступные: ${Object.keys(fieldMap).join(', ')}`);
          return;
        }

        const validationError = mapping.validate(value);
        if (validationError) {
          ctx.reply(`⚠️ ${validationError}`);
          return;
        }

        // Преобразование значений
        let dbValue: any = value;
        if (field === 'quiet_from' || field === 'quiet_to') {
          dbValue = value === 'off' ? null : value;
        } else if (field === 'weekend') {
          dbValue = value === 'normal' ? null : value;
        } else if (field === 'send_to_client') {
          dbValue = value === 'on';
        }

        logger.info(`Admin: /admin_settings_set ${projectId} ${field}=${value} from ${userId}`);

        await SupabaseClient.upsertClientSettings(projectId, mapping.dbField, dbValue);

        const displayValue = dbValue === null ? 'выключено' : dbValue === true ? 'включено' : dbValue === false ? 'выключено' : dbValue;
        ctx.reply(`✅ Настройка обновлена:\n📋 Проект: ${projectId}\n⚙️ ${field} → ${displayValue}`);

      } catch (error) {
        logger.error('Error in /admin_settings_set:', error);
        ctx.reply('❌ Ошибка при обновлении настроек');
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

        // Ручные статусы из дашборда (приоритет)
        const manualStatuses = await DashboardClient.getManualStatuses(project.project_name);

        // AI-статусы из custom_block_statuses
        const allStatuses = await SupabaseClient.getCustomBlockStatuses(projectId);

        const statusMap: Record<string, string> = {};
        for (const block of activeBlocks) {
          const blockKey = block.id || block.name;

          // Ручной статус — приоритет (кроме "Не определён")
          const manual = manualStatuses.get(blockKey);
          if (manual && manual.status !== 'Не определён') {
            statusMap[blockKey] = manual.status;
            continue;
          }

          // AI-статус
          const status = allStatuses.find((s: any) => s.block_id === blockKey);
          if (status && status.status_analysis) {
            statusMap[blockKey] = status.status_analysis;
          }
        }

        const statusText = formatStatusForClient(activeBlocks, statusMap, format);

        let finalMessage = `📋 ${project.project_name}\n\n`;
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

              // Пропускаем "информация отсутствует" — не перезаписываем старый статус
              if (newStatus.toLowerCase().includes('информация отсутствует')) {
                logger.info(`Block ${block.name}: no new info, keeping existing status`);
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

              // Синхронизируем в дашборд (OCTOPUS)
              try {
                await DashboardClient.syncStatusToDashboard(
                  project.project_name, block.id || block.name, block.name, block.type, newStatus
                );
              } catch (dashError) {
                logger.warn(`Dashboard sync failed for ${block.name} (non-critical):`, dashError);
              }

              // Стандартные блоки дополнительно в projects_test (dual-write, не критично)
              if (block.type === 'standard') {
                const fieldName = getStandardFieldMapping(block.name);
                if (fieldName) {
                  try {
                    await SupabaseClient.updateProjectTestField(project.project_id, fieldName, newStatus);
                  } catch (dualWriteError) {
                    logger.warn(`Dual-write to projects_test failed for ${block.name} (non-critical)`);
                  }
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

              // Пропускаем "информация отсутствует" — не перезаписываем старый статус
              if (newStatus.toLowerCase().includes('информация отсутствует')) {
                logger.info(`Block ${block.name}: no new info, keeping existing status`);
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

              // Синхронизируем в дашборд (OCTOPUS)
              try {
                await DashboardClient.syncStatusToDashboard(
                  project.project_name, block.id || block.name, block.name, block.type, newStatus
                );
              } catch (dashError) {
                logger.warn(`Dashboard sync failed for ${block.name} (non-critical):`, dashError);
              }

              // Стандартные блоки дополнительно в projects_test (dual-write, не критично)
              if (block.type === 'standard') {
                const fieldName = getStandardFieldMapping(block.name);
                if (fieldName) {
                  try {
                    await SupabaseClient.updateProjectTestField(project.project_id, fieldName, newStatus);
                  } catch (dualWriteError) {
                    logger.warn(`Dual-write to projects_test failed for ${block.name} (non-critical)`);
                  }
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

    // === GLOSSARY COMMANDS ===

    this.bot.command('admin_glossary', async (ctx) => {
      try {
        const userId = ctx.from.id.toString();
        const TEST_TELEGRAM_ID = process.env.TEST_TELEGRAM_ID || '489599665';

        if (userId !== TEST_TELEGRAM_ID) {
          ctx.reply('⛔ У вас нет доступа к этой команде.');
          return;
        }

        logger.info(`Admin: /admin_glossary from ${userId}`);

        const glossary = await AIServiceClient.getGlossary();
        const { stats } = glossary;

        let message = '📚 ГЛОССАРИЙ ВИДЕОПРОДАКШНА\n\n';
        message += `📊 Статистика:\n`;
        message += `• Базовых терминов: ${stats.base_count}\n`;
        message += `• Авто-обнаруженных: ${stats.discovered_total}\n`;
        message += `  - ✅ Одобренных: ${stats.approved}\n`;
        message += `  - ⏳ Ожидающих: ${stats.pending}\n`;
        message += `  - ❌ Отклонённых: ${stats.rejected}\n`;
        message += `• Всего активных: ${stats.active_total}\n`;

        const pendingTerms = Object.entries(glossary.pending);
        if (pendingTerms.length > 0) {
          message += `\n⏳ PENDING ТЕРМИНЫ (${pendingTerms.length}):\n`;
          for (const [term, definition] of pendingTerms) {
            message += `\n• "${term}" — ${definition}\n`;
            message += `  /admin_glossary_approve ${term}\n`;
            message += `  /admin_glossary_reject ${term}\n`;
            message += `  /admin_glossary_edit ${term} | новое описание\n`;
          }
          message += `\n💡 /admin_glossary_approve_all — одобрить все`;
        } else {
          message += '\n✅ Нет pending-терминов.';
        }

        ctx.reply(message);

      } catch (error) {
        logger.error('Error in /admin_glossary:', error);
        const errorMsg = error instanceof Error ? error.message : String(error);
        ctx.reply(`❌ Ошибка: ${errorMsg}`);
      }
    });

    this.bot.command('admin_glossary_discover', async (ctx) => {
      try {
        const userId = ctx.from.id.toString();
        const TEST_TELEGRAM_ID = process.env.TEST_TELEGRAM_ID || '489599665';

        if (userId !== TEST_TELEGRAM_ID) {
          ctx.reply('⛔ У вас нет доступа к этой команде.');
          return;
        }

        const args = ctx.message.text.split(' ');

        if (args.length < 2) {
          ctx.reply('⚠️ Укажите ID проекта: /admin_glossary_discover 42');
          return;
        }

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

        logger.info(`Admin: /admin_glossary_discover ${projectId} from ${userId}`);
        await ctx.reply(`🔍 Ищу новые термины в проекте "${project.project_name}"...`);

        const messages = await SupabaseClient.getLastMessagesForProject(project.project_id, 100);

        if (messages.length === 0) {
          ctx.reply('⚠️ Нет сообщений для анализа');
          return;
        }

        const conversationText = await SupabaseClient.formatConversationWithRoles(messages);

        const result = await AIServiceClient.discoverGlossaryTerms({
          conversation: conversationText,
          projectName: project.project_name
        });

        let message = `📚 Обнаружение терминов для "${project.project_name}":\n\n`;

        if (result.discovered.length === 0) {
          message += '✅ Новых терминов не найдено.';
        } else {
          message += `🔍 Найдено: ${result.discovered.length} терминов\n`;
          message += `➕ Новых добавлено: ${result.newTermsAdded}\n\n`;

          for (const term of result.discovered) {
            const conf = Math.round(term.confidence * 100);
            message += `• "${term.term}" — ${term.definition} (${conf}%)\n`;
          }

          if (result.newTermsAdded > 0) {
            message += `\n💡 /admin_glossary — посмотреть pending термины`;
          }
        }

        ctx.reply(message);

      } catch (error) {
        logger.error('Error in /admin_glossary_discover:', error);
        const errorMsg = error instanceof Error ? error.message : String(error);
        ctx.reply(`❌ Ошибка: ${errorMsg}`);
      }
    });

    this.bot.command('admin_glossary_approve_all', async (ctx) => {
      try {
        const userId = ctx.from.id.toString();
        const TEST_TELEGRAM_ID = process.env.TEST_TELEGRAM_ID || '489599665';

        if (userId !== TEST_TELEGRAM_ID) {
          ctx.reply('⛔ У вас нет доступа к этой команде.');
          return;
        }

        logger.info(`Admin: /admin_glossary_approve_all from ${userId}`);

        // Get pending terms first, then approve each one
        const glossary = await AIServiceClient.getGlossary();
        const pendingTerms = Object.keys(glossary.pending);

        if (pendingTerms.length === 0) {
          ctx.reply('✅ Нет pending-терминов для одобрения.');
          return;
        }

        let approved = 0;
        for (const term of pendingTerms) {
          try {
            await AIServiceClient.approveGlossaryTerm(term);
            approved++;
          } catch {
            logger.warn(`Failed to approve term: ${term}`);
          }
        }

        ctx.reply(`✅ Одобрено ${approved} из ${pendingTerms.length} терминов.\n\n💡 Теперь AI будет использовать их при анализе.`);

      } catch (error) {
        logger.error('Error in /admin_glossary_approve_all:', error);
        const errorMsg = error instanceof Error ? error.message : String(error);
        ctx.reply(`❌ Ошибка: ${errorMsg}`);
      }
    });

    this.bot.command('admin_glossary_approve', async (ctx) => {
      try {
        const userId = ctx.from.id.toString();
        const TEST_TELEGRAM_ID = process.env.TEST_TELEGRAM_ID || '489599665';

        if (userId !== TEST_TELEGRAM_ID) {
          ctx.reply('⛔ У вас нет доступа к этой команде.');
          return;
        }

        const args = ctx.message.text.split(' ').slice(1).join(' ').trim();

        if (!args) {
          ctx.reply('⚠️ Укажите термин: /admin_glossary_approve ОС');
          return;
        }

        logger.info(`Admin: /admin_glossary_approve "${args}" from ${userId}`);

        const result = await AIServiceClient.approveGlossaryTerm(args);
        ctx.reply(`✅ Термин "${result.term}" одобрен.\n\n💡 AI будет использовать его при следующем анализе.`);

      } catch (error: any) {
        logger.error('Error in /admin_glossary_approve:', error);
        if (error?.response?.status === 404) {
          ctx.reply('❌ Термин не найден в списке обнаруженных.');
        } else {
          const errorMsg = error instanceof Error ? error.message : String(error);
          ctx.reply(`❌ Ошибка: ${errorMsg}`);
        }
      }
    });

    this.bot.command('admin_glossary_reject', async (ctx) => {
      try {
        const userId = ctx.from.id.toString();
        const TEST_TELEGRAM_ID = process.env.TEST_TELEGRAM_ID || '489599665';

        if (userId !== TEST_TELEGRAM_ID) {
          ctx.reply('⛔ У вас нет доступа к этой команде.');
          return;
        }

        const args = ctx.message.text.split(' ').slice(1).join(' ').trim();

        if (!args) {
          ctx.reply('⚠️ Укажите термин: /admin_glossary_reject термин');
          return;
        }

        logger.info(`Admin: /admin_glossary_reject "${args}" from ${userId}`);

        const result = await AIServiceClient.rejectGlossaryTerm(args);
        ctx.reply(`❌ Термин "${result.term}" отклонён.`);

      } catch (error: any) {
        logger.error('Error in /admin_glossary_reject:', error);
        if (error?.response?.status === 404) {
          ctx.reply('❌ Термин не найден в списке обнаруженных.');
        } else {
          const errorMsg = error instanceof Error ? error.message : String(error);
          ctx.reply(`❌ Ошибка: ${errorMsg}`);
        }
      }
    });

    this.bot.command('admin_glossary_edit', async (ctx) => {
      try {
        const userId = ctx.from.id.toString();
        const TEST_TELEGRAM_ID = process.env.TEST_TELEGRAM_ID || '489599665';

        if (userId !== TEST_TELEGRAM_ID) {
          ctx.reply('⛔ У вас нет доступа к этой команде.');
          return;
        }

        const args = ctx.message.text.split(' ').slice(1).join(' ').trim();
        const separatorIndex = args.indexOf('|');

        if (!args || separatorIndex === -1) {
          ctx.reply('⚠️ Формат: /admin_glossary_edit термин | новое описание\nПример: /admin_glossary_edit окнуть | Одобрить, утвердить');
          return;
        }

        const term = args.substring(0, separatorIndex).trim();
        const definition = args.substring(separatorIndex + 1).trim();

        if (!term || !definition) {
          ctx.reply('⚠️ Укажите и термин, и описание: /admin_glossary_edit термин | новое описание');
          return;
        }

        logger.info(`Admin: /admin_glossary_edit "${term}" -> "${definition}" from ${userId}`);

        const result = await AIServiceClient.editGlossaryTerm(term, definition);
        ctx.reply(`✏️ Термин "${result.term}" обновлён.\nНовое описание: ${result.definition}`);

      } catch (error: any) {
        logger.error('Error in /admin_glossary_edit:', error);
        if (error?.response?.status === 404) {
          ctx.reply('❌ Термин не найден в списке обнаруженных.');
        } else {
          const errorMsg = error instanceof Error ? error.message : String(error);
          ctx.reply(`❌ Ошибка: ${errorMsg}`);
        }
      }
    });

    // === CALLBACK: Навигация по кнопкам ===

    // Главное меню → Статусы: показать список проектов
    this.bot.action('menu:statuses', async (ctx) => {
      try {
        await ctx.answerCbQuery();
        const userId = ctx.from!.id.toString();
        const TEST_TELEGRAM_ID = process.env.TEST_TELEGRAM_ID || '489599665';
        const isAdmin = userId === TEST_TELEGRAM_ID;

        let projects;
        if (isAdmin) {
          projects = await SupabaseClient.getAllProjects();
        } else {
          projects = await this.getUserProjects(userId);
        }

        if (!projects || projects.length === 0) {
          await ctx.editMessageText('Нет активных проектов.', Markup.inlineKeyboard([
            [Markup.button.callback('◀️ Назад', 'menu:main')]
          ]));
          return;
        }

        // Кнопки проектов (по 1 в строке)
        const buttons = projects.map((p: any) =>
          [Markup.button.callback(`📋 ${this.truncate(p.project_name, 45)}`, `status:${p.project_id}`)]
        );
        buttons.push([Markup.button.callback('◀️ Назад', 'menu:main')]);

        await ctx.editMessageText(
          `📊 Выберите проект (${projects.length}):`,
          Markup.inlineKeyboard(buttons)
        );
      } catch (error) {
        logger.error('Error in menu:statuses callback:', error);
      }
    });

    // Главное меню → Настройки: показать список проектов для настроек
    this.bot.action('menu:settings', async (ctx) => {
      try {
        await ctx.answerCbQuery();
        const userId = ctx.from!.id.toString();
        const TEST_TELEGRAM_ID = process.env.TEST_TELEGRAM_ID || '489599665';
        const isAdmin = userId === TEST_TELEGRAM_ID;

        let projects;
        if (isAdmin) {
          projects = await SupabaseClient.getAllProjects();
        } else {
          projects = await this.getUserProjects(userId);
        }

        if (!projects || projects.length === 0) {
          await ctx.editMessageText('Нет активных проектов.', Markup.inlineKeyboard([
            [Markup.button.callback('◀️ Назад', 'menu:main')]
          ]));
          return;
        }

        const buttons = projects.map((p: any) =>
          [Markup.button.callback(`⚙️ ${this.truncate(p.project_name, 45)}`, `settings:${p.project_id}`)]
        );
        buttons.push([Markup.button.callback('◀️ Назад', 'menu:main')]);

        await ctx.editMessageText(
          '⚙️ Выберите проект для настройки:',
          Markup.inlineKeyboard(buttons)
        );
      } catch (error) {
        logger.error('Error in menu:settings callback:', error);
      }
    });

    // Назад в главное меню
    this.bot.action('menu:main', async (ctx) => {
      try {
        await ctx.answerCbQuery();
        await ctx.editMessageText(
          '🥷 Статус Ниндзя\n\nЧитаю рабочие чаты проектов и собираю статусы автоматически.\n\nПросто напишите вопрос или «статус».'
        );
      } catch (error) {
        logger.error('Error in menu:main callback:', error);
      }
    });

    // Показать статус конкретного проекта
    this.bot.action(/^status:(\d+)$/, async (ctx) => {
      try {
        await ctx.answerCbQuery('Загружаю статус...');
        const projectId = parseInt((ctx.match as RegExpMatchArray)[1], 10);

        const project = await SupabaseClient.getProject(projectId);
        if (!project) {
          await ctx.editMessageText('❌ Проект не найден');
          return;
        }

        const clientSettings = await SupabaseClient.getClientSettings(projectId);
        const defaults = getDefaultClientSettings();
        const format = clientSettings.format_status || defaults.format_status;
        logger.info(`[status button] project=${projectId} format_status="${clientSettings.format_status}" default="${defaults.format_status}" resolved="${format}" raw_settings=${JSON.stringify(clientSettings)}`);

        const activeBlocks = await DashboardClient.getActiveBlocks(project.project_name);

        if (activeBlocks.length === 0) {
          await ctx.editMessageText(
            `📋 ${project.project_name}\n\n⚠️ Нет активных блоков`,
            Markup.inlineKeyboard([[Markup.button.callback('◀️ К проектам', 'menu:statuses')]])
          );
          return;
        }

        const manualStatuses = await DashboardClient.getManualStatuses(project.project_name);
        const allStatuses = await SupabaseClient.getCustomBlockStatuses(projectId);

        const statusMap: Record<string, string> = {};
        for (const block of activeBlocks) {
          const blockKey = block.id || block.name;
          const manual = manualStatuses.get(blockKey);
          if (manual && manual.status !== 'Не определён') {
            statusMap[blockKey] = manual.status;
            continue;
          }
          const status = allStatuses.find((s: any) => s.block_id === blockKey);
          if (status?.status_analysis) {
            statusMap[blockKey] = status.status_analysis;
          }
        }

        let statusText = formatStatusForClient(activeBlocks, statusMap, format);

        // Резолвим [#id] теги в ссылки на сообщения
        const messages = await SupabaseClient.getLastMessagesForProject(projectId, 200);
        const linkMap = SupabaseClient.buildMessageLinkMap(messages);
        statusText = resolveMessageLinksHtml(statusText, linkMap);

        const formatLabel = format === 'короткий' ? '📝 Короткий формат' : '📝 Длинный формат';
        const fullMessage = `📋 ${project.project_name}\n${formatLabel}\n\n${statusText}`;

        const buttons = Markup.inlineKeyboard([
          [Markup.button.callback('⚙️ Настройки', `settings:${projectId}`)],
          [Markup.button.callback('◀️ К проектам', 'menu:statuses')],
        ]);

        if (fullMessage.length <= 4000) {
          await ctx.editMessageText(fullMessage, { ...buttons, parse_mode: 'HTML' });
        } else {
          await ctx.editMessageText('📋 ' + project.project_name, buttons);
          const parts = this.splitMessage(statusText, 4000);
          for (const part of parts) {
            await ctx.reply(part, { parse_mode: 'HTML' });
          }
        }
      } catch (error) {
        logger.error('Error in status callback:', error);
      }
    });

    // Показать настройки конкретного проекта
    this.bot.action(/^settings:(\d+)$/, async (ctx) => {
      try {
        await ctx.answerCbQuery();
        const projectId = parseInt((ctx.match as RegExpMatchArray)[1], 10);

        const project = await SupabaseClient.getProject(projectId);
        if (!project) {
          await ctx.editMessageText('❌ Проект не найден');
          return;
        }

        const settings = await SupabaseClient.getClientSettings(projectId);
        const defaults = getDefaultClientSettings();

        let msg = `⚙️ ${project.project_name}\n\n`;
        msg += `📅 Дни: ${settings.status_frequency_day || defaults.status_frequency_day}\n`;
        msg += `⏰ Время: ${settings.status_frequency_time || defaults.status_frequency_time}\n`;
        msg += `📝 Формат: ${settings.format_status || defaults.format_status}\n`;

        if (settings.quiet_from || settings.quiet_to) {
          msg += `🔇 Тихие часы: ${settings.quiet_from || '?'} — ${settings.quiet_to || '?'}\n`;
        }

        if (settings.weekend) {
          const wl = settings.weekend === 'no' ? 'не отправлять' : settings.weekend === 'urgent' ? 'только срочное' : settings.weekend;
          msg += `📅 Выходные: ${wl}\n`;
        }

        msg += `👤 Клиенту: ${settings.send_to_client ? 'да' : 'нет'}\n`;

        const currentFormat = settings.format_status || defaults.format_status;
        const formatLabel = currentFormat === 'короткий' ? 'Сменить на длинный' : 'Сменить на короткий';
        const formatValue = currentFormat === 'короткий' ? 'длинный' : 'короткий';

        const currentClient = settings.send_to_client ? 'Выключить' : 'Включить';
        const clientValue = settings.send_to_client ? 'false' : 'true';

        await ctx.editMessageText(msg, Markup.inlineKeyboard([
          [Markup.button.callback(`📝 ${formatLabel}`, `set:${projectId}:format_status:${formatValue}`)],
          [Markup.button.callback(`👤 Клиенту: ${currentClient}`, `set:${projectId}:send_to_client:${clientValue}`)],
          [Markup.button.callback('📊 Статус проекта', `status:${projectId}`)],
          [Markup.button.callback('◀️ К проектам', 'menu:settings')],
        ]));
      } catch (error) {
        logger.error('Error in settings callback:', error);
      }
    });

    // Изменить конкретную настройку
    this.bot.action(/^set:(\d+):(\w+):(.+)$/, async (ctx) => {
      try {
        const match = ctx.match as RegExpMatchArray;
        const projectId = parseInt(match[1], 10);
        const field = match[2];
        const value = match[3];

        let dbValue: any = value;
        if (field === 'send_to_client') {
          dbValue = value === 'true';
        }

        await SupabaseClient.upsertClientSettings(projectId, field, dbValue);
        logger.info(`[set button] wrote project=${projectId} field=${field} value=${JSON.stringify(dbValue)}`);
        await ctx.answerCbQuery('✅ Сохранено');

        const project = await SupabaseClient.getProject(projectId);
        const settings = await SupabaseClient.getClientSettings(projectId);
        logger.info(`[set button] read-back project=${projectId} format_status="${settings.format_status}" raw=${JSON.stringify(settings)}`);
        const defaults = getDefaultClientSettings();

        // Если сменили формат — сразу показать статус в новом формате
        if (field === 'format_status') {
          const newFormat = settings.format_status || defaults.format_status;

          const activeBlocks = await DashboardClient.getActiveBlocks(project.project_name);
          if (activeBlocks.length === 0) {
            await ctx.editMessageText(`📋 ${project.project_name}\n📝 Формат: ${newFormat}\n\n⚠️ Нет активных блоков`, Markup.inlineKeyboard([
              [Markup.button.callback('⚙️ Настройки', `settings:${projectId}`)],
              [Markup.button.callback('◀️ К проектам', 'menu:statuses')],
            ]));
            return;
          }

          const manualStatuses = await DashboardClient.getManualStatuses(project.project_name);
          const allStatuses = await SupabaseClient.getCustomBlockStatuses(projectId);
          const statusMap: Record<string, string> = {};
          for (const block of activeBlocks) {
            const blockKey = block.id || block.name;
            const manual = manualStatuses.get(blockKey);
            if (manual && manual.status !== 'Не определён') {
              statusMap[blockKey] = manual.status;
              continue;
            }
            const status = allStatuses.find((s: any) => s.block_id === blockKey);
            if (status?.status_analysis) {
              statusMap[blockKey] = status.status_analysis;
            }
          }

          let statusText = formatStatusForClient(activeBlocks, statusMap, newFormat);

          // Резолвим [#id] в ссылки
          const msgs = await SupabaseClient.getLastMessagesForProject(projectId, 200);
          const linkMap = SupabaseClient.buildMessageLinkMap(msgs);
          statusText = resolveMessageLinksHtml(statusText, linkMap);

          const formatLabel2 = newFormat === 'короткий' ? '📝 Короткий формат' : '📝 Длинный формат';
          const fullMessage = `📋 ${project.project_name}\n${formatLabel2} (изменён ✅)\n\n${statusText}`;

          const buttons = Markup.inlineKeyboard([
            [Markup.button.callback('⚙️ Настройки', `settings:${projectId}`)],
            [Markup.button.callback('◀️ К проектам', 'menu:statuses')],
          ]);

          if (fullMessage.length <= 4000) {
            await ctx.editMessageText(fullMessage, { ...buttons, parse_mode: 'HTML' });
          } else {
            await ctx.editMessageText(`📋 ${project.project_name}\n${formatLabel2} (изменён ✅)`, buttons);
            const parts = this.splitMessage(statusText, 4000);
            for (const part of parts) {
              await ctx.reply(part, { parse_mode: 'HTML' });
            }
          }
          return;
        }

        // Для остальных настроек — показать панель настроек
        let msg = `⚙️ ${project.project_name}\n\n`;
        msg += `📅 Дни: ${settings.status_frequency_day || defaults.status_frequency_day}\n`;
        msg += `⏰ Время: ${settings.status_frequency_time || defaults.status_frequency_time}\n`;
        msg += `📝 Формат: ${settings.format_status || defaults.format_status}\n`;

        if (settings.quiet_from || settings.quiet_to) {
          msg += `🔇 Тихие часы: ${settings.quiet_from || '?'} — ${settings.quiet_to || '?'}\n`;
        }

        if (settings.weekend) {
          const wl = settings.weekend === 'no' ? 'не отправлять' : settings.weekend === 'urgent' ? 'только срочное' : settings.weekend;
          msg += `📅 Выходные: ${wl}\n`;
        }

        msg += `👤 Клиенту: ${settings.send_to_client ? 'да' : 'нет'}\n`;

        const currentFormat = settings.format_status || defaults.format_status;
        const formatLabel = currentFormat === 'короткий' ? 'Сменить на длинный' : 'Сменить на короткий';
        const formatValue2 = currentFormat === 'короткий' ? 'длинный' : 'короткий';

        const currentClient = settings.send_to_client ? 'Выключить' : 'Включить';
        const clientValue2 = settings.send_to_client ? 'false' : 'true';

        await ctx.editMessageText(msg, Markup.inlineKeyboard([
          [Markup.button.callback(`📝 ${formatLabel}`, `set:${projectId}:format_status:${formatValue2}`)],
          [Markup.button.callback(`👤 Клиенту: ${currentClient}`, `set:${projectId}:send_to_client:${clientValue2}`)],
          [Markup.button.callback('📊 Статус проекта', `status:${projectId}`)],
          [Markup.button.callback('◀️ К проектам', 'menu:settings')],
        ]));
      } catch (error) {
        logger.error('Error in set callback:', error);
        await ctx.answerCbQuery('❌ Ошибка');
      }
    });

    // Кнопка "Ок, всё норм" — просто убрать кнопки
    this.bot.action('dismiss', async (ctx) => {
      try {
        await ctx.answerCbQuery('👍');
        await ctx.editMessageReplyMarkup(undefined);
      } catch (error) {
        logger.error('Error in dismiss callback:', error);
      }
    });

    // === CALLBACK: одобрение отправки статуса клиенту ===
    this.bot.action(/^send_to_client:(.+)$/, async (ctx) => {
      try {
        const dataKey = (ctx.match as RegExpMatchArray)[1];
        const pending = this.pendingClientStatuses.get(dataKey);

        if (!pending) {
          await ctx.answerCbQuery('⏰ Время действия кнопки истекло');
          await ctx.editMessageReplyMarkup(undefined);
          return;
        }

        this.pendingClientStatuses.delete(dataKey);

        await this.bot.telegram.sendMessage(
          pending.clientTgId,
          `Статус на сегодня по проекту "${pending.projectName}":\n\n${pending.clientText}`
        );

        await ctx.answerCbQuery('✅ Отправлено клиенту');
        await ctx.editMessageReplyMarkup(undefined);
        // Добавляем пометку к сообщению
        const originalText = (ctx.callbackQuery.message as any)?.text || '';
        await ctx.editMessageText(originalText + '\n\n✅ Статус отправлен клиенту');

        logger.info(`Producer approved client status for ${pending.projectName}, sent to ${pending.clientTgId}`);
      } catch (error) {
        logger.error('Error in send_to_client callback:', error);
        await ctx.answerCbQuery('❌ Ошибка отправки');
      }
    });

    this.bot.action(/^skip_client:(.+)$/, async (ctx) => {
      try {
        const dataKey = (ctx.match as RegExpMatchArray)[1];
        this.pendingClientStatuses.delete(dataKey);

        await ctx.answerCbQuery('⏭️ Пропущено');
        await ctx.editMessageReplyMarkup(undefined);

        logger.info(`Producer skipped client status send`);
      } catch (error) {
        logger.error('Error in skip_client callback:', error);
      }
    });

    // === CALLBACK: Копировать статус (plain text без HTML) ===
    this.bot.action(/^copy_status:(\d+)$/, async (ctx) => {
      try {
        await ctx.answerCbQuery();
        const projectId = parseInt((ctx.match as RegExpMatchArray)[1], 10);

        const project = await SupabaseClient.getProject(projectId);
        if (!project) {
          await ctx.reply('❌ Проект не найден');
          return;
        }

        const activeBlocks = await DashboardClient.getActiveBlocks(project.project_name);
        const manualStatuses = await DashboardClient.getManualStatuses(project.project_name);
        const allStatuses = await SupabaseClient.getCustomBlockStatuses(projectId);

        const statusMap: Record<string, string> = {};
        for (const block of activeBlocks) {
          const blockKey = block.id || block.name;
          const manual = manualStatuses.get(blockKey);
          if (manual && manual.status !== 'Не определён') {
            statusMap[blockKey] = manual.status;
            continue;
          }
          const status = allStatuses.find((s: any) => s.block_id === blockKey);
          if (status?.status_analysis) {
            statusMap[blockKey] = status.status_analysis;
          }
        }

        // Формируем plain text (без HTML, без ссылок)
        let plainText = `Статус: ${project.project_name}\n\n`;
        for (const block of activeBlocks) {
          const blockKey = block.id || block.name;
          const displayName = getBlockDisplayName(block.name);
          const statusVal = statusMap[blockKey] || 'Нет данных';
          // Убираем [#id] теги из текста
          const cleanStatus = statusVal.replace(/\s*\[#\d+\]/g, '');
          plainText += `${displayName}: ${cleanStatus}\n`;
        }

        // Отправляем как monospace чтобы было удобно копировать
        const escaped = plainText.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
        await ctx.reply(`<pre>${escaped}</pre>`, { parse_mode: 'HTML' });
      } catch (error) {
        logger.error('Error in copy_status callback:', error);
        await ctx.reply('❌ Ошибка при копировании статуса');
      }
    });

    // === CALLBACK: Отправить статус клиенту ===
    this.bot.action(/^client_status:(\d+)$/, async (ctx) => {
      try {
        await ctx.answerCbQuery();
        const projectId = parseInt((ctx.match as RegExpMatchArray)[1], 10);

        const project = await SupabaseClient.getProject(projectId);
        if (!project) {
          await ctx.reply('❌ Проект не найден');
          return;
        }

        // Ищем клиента проекта (приходит из join в getProject)
        const projectClient = project.client;

        if (!projectClient || !projectClient.client_chat_id) {
          await ctx.reply(`❌ У проекта "${project.project_name}" нет привязанного клиента.`);
          return;
        }

        const activeBlocks = await DashboardClient.getActiveBlocks(project.project_name);
        const manualStatuses = await DashboardClient.getManualStatuses(project.project_name);
        const allStatuses = await SupabaseClient.getCustomBlockStatuses(projectId);

        const statusMap: Record<string, string> = {};
        for (const block of activeBlocks) {
          const blockKey = block.id || block.name;
          const manual = manualStatuses.get(blockKey);
          if (manual && manual.status !== 'Не определён') {
            statusMap[blockKey] = manual.status;
            continue;
          }
          const status = allStatuses.find((s: any) => s.block_id === blockKey);
          if (status?.status_analysis) {
            statusMap[blockKey] = status.status_analysis;
          }
        }

        const clientText = formatStatusForClient(activeBlocks, statusMap, 'короткий');
        // Убираем [#id] теги для клиента
        const cleanClientText = clientText.replace(/\s*\[#\d+\]/g, '');

        const clientTgId = projectClient.client_chat_id?.toString();
        if (!clientTgId) {
          await ctx.reply(`❌ У клиента нет Telegram ID.`);
          return;
        }

        const dataKey = `${projectId}_${Date.now()}`;
        this.pendingClientStatuses.set(dataKey, {
          clientTgId,
          projectName: project.project_name,
          clientText: cleanClientText
        });

        // Показываем превью и кнопки подтверждения
        await ctx.reply(
          `📤 Отправить клиенту (${projectClient.client_name || 'клиент'})?\n\n` +
          `Превью:\n${cleanClientText}`,
          Markup.inlineKeyboard([
            [
              Markup.button.callback('✅ Отправить', `send_to_client:${dataKey}`),
              Markup.button.callback('❌ Отмена', `skip_client:${dataKey}`),
            ],
          ])
        );
      } catch (error) {
        logger.error('Error in client_status callback:', error);
        await ctx.reply('❌ Ошибка при подготовке отправки клиенту');
      }
    });

    // Сбор сообщений из групповых чатов (бывший Silent Bot)
    this.bot.on('new_chat_members', async (ctx) => {
      try {
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
        logger.info(`Bot added to/new members in chat ${ctx.chat.id}, sent welcome message`);

        // Уведомить продюсера в личку о подключении
        try {
          const chatId = ctx.chat.id.toString();
          const chat = await SupabaseClient.getChatByTelegramId(chatId);

          if (chat?.project_id) {
            const project = await SupabaseClient.getProject(chat.project_id);

            if (project?.producer?.producer_tg_chat_id) {
              const producerTgId = project.producer.producer_tg_chat_id.toString();
              const defaults = getDefaultClientSettings();
              const settings = await SupabaseClient.getClientSettings(project.project_id);

              const days = settings.status_frequency_day || defaults.status_frequency_day;
              const time = settings.status_frequency_time || defaults.status_frequency_time;

              await this.bot.telegram.sendMessage(
                producerTgId,
                `🥷 Я подключён к проекту "${project.project_name}"\n\n` +
                `Буду читать переписку и отправлять тебе статус по расписанию:\n` +
                `📅 ${days}\n⏰ ${time}\n\n` +
                `Хочешь изменить?`,
                Markup.inlineKeyboard([
                  [Markup.button.callback('⚙️ Изменить расписание', `settings:${project.project_id}`)],
                  [Markup.button.callback('✅ Ок, всё норм', 'dismiss')],
                ])
              );

              logger.info(`Sent onboarding DM to producer ${producerTgId} for project ${project.project_name}`);
            }
          }
        } catch (dmError) {
          logger.warn('Failed to send onboarding DM to producer (non-critical):', dmError);
        }
      } catch (error) {
        logger.error('Error in new_chat_members handler:', error);
      }
    });

    this.bot.on('message', async (ctx) => {
      // В личке — пропускаем, обработается в on('text') ниже
      if (ctx.chat?.type === 'private') return;

      // Группа/супергруппа — молча собираем сообщения
      try {
        if (!ctx.message || !('text' in ctx.message)) return;

        const message = ctx.message;
        const chatId = message.chat.id.toString();
        const senderId = message.from!.id.toString();
        const messageText = this.extractMessageWithLinks(message);
        const chatName = 'title' in message.chat ? message.chat.title : '';

        await SupabaseClient.saveMessage({
          telegram_chat_id: chatId,
          sender_id: senderId,
          message_text: messageText,
          chat_name_tg: chatName || '',
          is_analyzed: false,
          telegram_message_id: message.message_id
        });

        logger.info(`Message collected from chat ${chatId}`);
      } catch (error) {
        logger.error('Error collecting message:', error);
      }
    });

    this.bot.on('text', async (ctx: Context) => {
      if (!ctx.message || !('text' in ctx.message)) return;
      if (!ctx.from) return;
      if (ctx.chat?.type !== 'private') return; // AI-чат только в личке

      try {
        const userId = ctx.from.id.toString();
        const userMessage = ctx.message.text;

        if (userMessage.startsWith('/')) return;

        logger.info(`Smart Bot: User ${userId} sent: ${userMessage}`);

        const TEST_TELEGRAM_ID = process.env.TEST_TELEGRAM_ID || '489599665';
        const isAdmin = userId === TEST_TELEGRAM_ID;
        const userType = await this.getUserType(userId);
        const userProjects = isAdmin
          ? await SupabaseClient.getAllProjects()
          : await this.getUserProjects(userId);

        // === 1. Проверяем, не просит ли пользователь статус ===
        const statusKeywords = ['статус', 'status', 'как дела', 'что по проект'];
        const isAskingForStatus = statusKeywords.some(kw =>
          userMessage.toLowerCase().includes(kw)
        );

        if (isAskingForStatus) {
          await ctx.sendChatAction('typing');

          if (!userProjects || userProjects.length === 0) {
            await ctx.reply('У вас пока нет привязанных проектов.');
            return;
          }

          // Проверяем, упомянут ли конкретный проект в сообщении
          const msgLower = userMessage.toLowerCase();
          let projectsToShow = userProjects;

          const mentionedProject = userProjects.find((p: any) =>
            msgLower.includes(p.project_name?.toLowerCase())
          );
          if (mentionedProject) {
            projectsToShow = [mentionedProject];
          }

          if (projectsToShow.length > 1) {
            await ctx.reply(`📊 Статусы ваших проектов (${projectsToShow.length}):`);
          }

          await this.sendStatusForProjects(ctx, projectsToShow);
          return;
        }

        // === 2. Определяем контекст проекта ===
        let context = this.userContext.get(userId);
        const TEN_MINUTES = 10 * 60 * 1000;

        // Из reply на статус
        if ('reply_to_message' in ctx.message && ctx.message.reply_to_message) {
          const replyToMsg = ctx.message.reply_to_message;
          if ('text' in replyToMsg && replyToMsg.text) {
            const projectMatch = replyToMsg.text.match(/📋 (.+?)[\n]/);
            if (projectMatch && projectMatch[1]) {
              const projectName = projectMatch[1].trim();
              const project = userProjects.find((p: any) => p.project_name === projectName);
              if (project) {
                context = { projectId: project.project_id, timestamp: Date.now() };
                this.userContext.set(userId, context);
                logger.info(`Context set from reply: project ${project.project_id} (${projectName})`);
              }
            }
          }
        }

        // Из упоминания проекта в тексте
        if (!context || (Date.now() - context.timestamp) >= TEN_MINUTES) {
          const mentionedProject = userProjects.find((p: any) =>
            userMessage.toLowerCase().includes(p.project_name?.toLowerCase())
          );
          if (mentionedProject) {
            context = { projectId: mentionedProject.project_id, timestamp: Date.now() };
            this.userContext.set(userId, context);
            logger.info(`Context set from mention: project ${mentionedProject.project_id} (${mentionedProject.project_name})`);
          }
          // Если у продюсера один проект — автоматически используем его
          else if (userProjects.length === 1) {
            context = { projectId: userProjects[0].project_id, timestamp: Date.now() };
            this.userContext.set(userId, context);
            logger.info(`Context auto-set: single project ${userProjects[0].project_id}`);
          }
        }

        // === 3. Вопрос по проекту — ищем ответ в переписке ===
        if (context && (Date.now() - context.timestamp) < TEN_MINUTES) {
          // Обновляем timestamp при каждом обращении
          this.userContext.set(userId, { projectId: context.projectId, timestamp: Date.now() });

          await ctx.sendChatAction('typing');
          const progressMsg = await ctx.reply('🔍 Анализирую переписку проекта...');

          try {
            const project = await SupabaseClient.getProject(context.projectId);
            if (!project) {
              await ctx.telegram.deleteMessage(ctx.chat!.id, progressMsg.message_id);
              await ctx.reply('❌ Проект не найден');
              return;
            }

            const answer = await this.answerQuestionIteratively(
              context.projectId,
              project.project_name,
              userMessage,
              progressMsg.message_id,
              ctx
            );

            try {
              await ctx.telegram.deleteMessage(ctx.chat!.id, progressMsg.message_id);
            } catch (e) {}

            await ctx.reply(answer);
            return;
          } catch (error: any) {
            logger.error('Error answering question from conversation:', error);
            try {
              await ctx.telegram.deleteMessage(ctx.chat!.id, progressMsg.message_id);
            } catch (e) {}
            // Fallthrough to general AI chat
          }
        }

        // === 4. Общий AI-чат (без контекста проекта) ===
        await ctx.sendChatAction('typing');

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

  private async sendStatusForProjects(ctx: any, projects: any[]) {
    for (let i = 0; i < projects.length; i++) {
      const project = projects[i];

      try {
        const clientSettings = await SupabaseClient.getClientSettings(project.project_id);
        const defaults = getDefaultClientSettings();
        const format = clientSettings.format_status || defaults.format_status;

        const activeBlocks = await DashboardClient.getActiveBlocks(project.project_name);

        if (activeBlocks.length === 0) {
          await ctx.reply(`📋 ${project.project_name}\n\n⚠️ Нет активных блоков для этого проекта`);
          continue;
        }

        const manualStatuses = await DashboardClient.getManualStatuses(project.project_name);
        const allStatuses = await SupabaseClient.getCustomBlockStatuses(project.project_id);

        const statusMap: Record<string, string> = {};
        for (const block of activeBlocks) {
          const blockKey = block.id || block.name;
          const manual = manualStatuses.get(blockKey);
          if (manual && manual.status !== 'Не определён') {
            statusMap[blockKey] = manual.status;
            continue;
          }
          const status = allStatuses.find((s: any) => s.block_id === blockKey);
          if (status?.status_analysis) {
            statusMap[blockKey] = status.status_analysis;
          }
        }

        let statusText = formatStatusForClient(activeBlocks, statusMap, format);

        const refIds = [...statusText.matchAll(/\[#(\d+)/g)].map(m => parseInt(m[1], 10));
        const linkMap = await SupabaseClient.buildLinkMapByIds(refIds);
        statusText = resolveMessageLinksHtml(statusText, linkMap);

        const statusMessage = `📋 ${project.project_name}\n\n${statusText}`;

        // Кнопки "Копировать" и "Отправить клиенту"
        const buttons = Markup.inlineKeyboard([
          [
            Markup.button.callback('📋 Копировать', `copy_status:${project.project_id}`),
            Markup.button.callback('📤 Отправить клиенту', `client_status:${project.project_id}`),
          ],
        ]);

        if (statusMessage.length <= 4000) {
          await ctx.reply(statusMessage, { parse_mode: 'HTML', ...buttons });
        } else {
          const parts = this.splitMessage(statusMessage, 4000);
          for (let j = 0; j < parts.length; j++) {
            const isLast = j === parts.length - 1;
            await ctx.reply(parts[j], { parse_mode: 'HTML', ...(isLast ? buttons : {}) });
            if (!isLast) {
              await new Promise(resolve => setTimeout(resolve, 300));
            }
          }
        }
      } catch (projError) {
        logger.error(`Error formatting status for ${project.project_name}:`, projError);
        await ctx.reply(`📋 ${project.project_name}\n\n❌ Ошибка при получении статуса`);
      }

      if (i < projects.length - 1) {
        await new Promise(resolve => setTimeout(resolve, 800));
      }
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

        // Синхронизируем в дашборд (OCTOPUS)
        try {
          await DashboardClient.syncStatusToDashboard(
            project.project_name, block.id || block.name, block.name, block.type, update.newStatus
          );
        } catch (dashError) {
          logger.warn(`Dashboard sync failed for ${block.name} (non-critical):`, dashError);
        }

        // Стандартные блоки дополнительно в projects/projects_test (dual-write, не критично)
        if (block.type === 'standard') {
          const fieldName = getStandardFieldMapping(block.name);
          if (fieldName) {
            try {
              if (DRY_RUN) {
                await SupabaseClient.ensureProjectTestExists(projectId);
                await SupabaseClient.updateProjectTestField(projectId, fieldName, update.newStatus);
              } else {
                await SupabaseClient.updateProjectField(projectId, fieldName, update.newStatus);
              }
            } catch (dualWriteError) {
              logger.warn(`Dual-write failed for ${block.name} (non-critical)`);
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

  async notifyProducerWithClientApproval(
    producerTgChatId: string,
    projectName: string,
    updates: string,
    clientTgId: string | null,
    clientStatusText: string | null
  ) {
    // Если нет клиента — обычная отправка без кнопок
    if (!clientTgId || !clientStatusText) {
      return this.notifyProducer(producerTgChatId, projectName, updates);
    }

    try {
      const header = `Статус на сегодня по проекту "${projectName}":\n\n`;
      const fullMessage = header + updates;

      // Генерируем уникальный ключ для callback
      const dataKey = `${Date.now()}_${projectName.replace(/[^a-zA-Z0-9а-яА-Я]/g, '').slice(0, 20)}`;

      // Сохраняем данные для отправки клиенту
      this.pendingClientStatuses.set(dataKey, {
        clientTgId,
        projectName,
        clientText: clientStatusText
      });

      // Автоочистка через 24 часа
      setTimeout(() => this.pendingClientStatuses.delete(dataKey), 24 * 60 * 60 * 1000);

      const keyboard = Markup.inlineKeyboard([
        Markup.button.callback('✅ Отправить клиенту', `send_to_client:${dataKey}`),
        Markup.button.callback('⏭️ Не отправлять', `skip_client:${dataKey}`)
      ]);

      const MAX_LENGTH = 4000;

      if (fullMessage.length <= MAX_LENGTH) {
        await this.bot.telegram.sendMessage(producerTgChatId, fullMessage, keyboard);
      } else {
        // Для длинных сообщений — отправляем частями, кнопки на последнем
        const parts = this.splitMessage(updates, MAX_LENGTH - header.length);

        for (let i = 0; i < parts.length; i++) {
          const partHeader = i === 0
            ? header
            : `Статус на сегодня по проекту "${projectName}" (часть ${i + 1}):\n\n`;

          const isLast = i === parts.length - 1;
          await this.bot.telegram.sendMessage(
            producerTgChatId,
            partHeader + parts[i],
            isLast ? keyboard : undefined
          );

          if (!isLast) {
            await new Promise(resolve => setTimeout(resolve, 500));
          }
        }
      }

      logger.info(`Notified producer ${producerTgChatId} about ${projectName} with client approval button`);
    } catch (error) {
      logger.error(`Error notifying producer with client approval ${producerTgChatId}:`, error);
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
        const statusText = status.startsWith('- ') ? status : `- ${status}`;
        msg += `${statusText}\n\n`;
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

  async sendDirectMessage(telegramId: string, text: string) {
    try {
      await this.bot.telegram.sendMessage(telegramId, text);
    } catch (error) {
      logger.error(`Failed to send DM to ${telegramId}:`, error);
    }
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

  private extractMessageWithLinks(message: any): string {
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

  async launch() {
    await this.bot.launch();
    logger.info('Bot launched');
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
