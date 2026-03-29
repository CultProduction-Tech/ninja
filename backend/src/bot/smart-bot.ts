import { Telegraf, Context, Markup } from 'telegraf';
import axios from 'axios';
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

const MANUAL_STATUS_MAX_AGE_DAYS = 3;
const CACHE_MAX_AGE_HOURS = 4;

// Получить статусы блоков — из кеша или запустить AI-анализ
async function getOrAnalyzeStatuses(projectId: number, projectName: string, activeBlocks: any[]): Promise<any[]> {
  let allStatuses = await SupabaseClient.getCustomBlockStatuses(projectId);

  // Проверяем: блоки без статуса ИЛИ со старым кэшем (> 4 часов)
  const now = Date.now();
  const blocksToAnalyze = activeBlocks.filter(block => {
    const blockKey = block.id || block.name;
    const cached = allStatuses.find((s: any) => s.block_id === blockKey && s.status_analysis);
    if (!cached) return true; // нет в кэше
    const ageHours = (now - new Date(cached.updated_at).getTime()) / 3600000;
    return ageHours >= CACHE_MAX_AGE_HOURS; // кэш устарел
  });

  if (blocksToAnalyze.length > 0) {
    const reason = blocksToAnalyze.length === activeBlocks.length ? 'all missing/stale' : `${blocksToAnalyze.length}/${activeBlocks.length} missing/stale`;
    logger.info(`On-demand analysis: ${reason} for project ${projectId}`);
    try {
      const messages = await SupabaseClient.getLastMessagesForProject(projectId, 200);
      if (messages.length > 0) {
        const conversationText = await SupabaseClient.formatConversationWithRoles(messages);
        const analysisResults = await AIServiceClient.analyzeDynamicBlocks({
          projectId,
          projectName,
          blocks: blocksToAnalyze,
          conversation: conversationText
        });

        // Save results to cache
        for (const block of blocksToAnalyze) {
          const blockKey = block.id || block.name;
          const newStatus = analysisResults[blockKey];
          if (newStatus) {
            await SupabaseClient.upsertCustomBlockStatus({
              project_id: projectId,
              block_id: block.id!,
              block_name: block.name,
              block_type: block.type,
              status_analysis: newStatus
            });
          }
        }

        // Reload statuses from cache
        allStatuses = await SupabaseClient.getCustomBlockStatuses(projectId);
        logger.info(`On-demand analysis complete: ${Object.keys(analysisResults).length} blocks analyzed`);
      }
    } catch (error) {
      logger.error(`On-demand analysis failed for project ${projectId}:`, error);
    }
  }

  return allStatuses;
}

// Конвертация markdown из AI-ответа в Telegram HTML
function markdownToHtml(text: string): string {
  let result = text;
  // **bold** → <b>bold</b>
  result = result.replace(/\*\*(.+?)\*\*/g, '<b>$1</b>');
  // *italic* → <i>italic</i>
  result = result.replace(/(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)/g, '<i>$1</i>');
  // Убираем оставшиеся [#ID] ссылки на сообщения (одиночные и списки через запятую)
  result = result.replace(/\s*\[#\d+(?:,\s*#?\d+)*\]/g, '');
  // Экранируем HTML-спецсимволы, кроме наших тегов
  // (не нужно — Telegram парсит только известные теги, остальное игнорирует)
  return result;
}

// Двусторонняя транслитерация для fuzzy-поиска проектов
const LAT_TO_CYR: Record<string, string> = {
  a: 'а', b: 'б', v: 'в', g: 'г', d: 'д', e: 'е', z: 'з', i: 'и',
  k: 'к', l: 'л', m: 'м', n: 'н', o: 'о', p: 'п', r: 'р', s: 'с',
  t: 'т', u: 'у', f: 'ф', h: 'х', c: 'ц', y: 'й', w: 'в', j: 'дж', x: 'кс',
};
const CYR_TO_LAT: Record<string, string> = {
  а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'yo', ж: 'zh',
  з: 'z', и: 'i', й: 'y', к: 'k', л: 'l', м: 'm', н: 'n', о: 'o',
  п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f', х: 'h', ц: 'ts',
  ч: 'ch', ш: 'sh', щ: 'sch', ъ: '', ы: 'y', ь: '', э: 'e', ю: 'yu', я: 'ya',
};

function toCyrillic(s: string): string {
  return s.replace(/sh|sch|ch|zh|yu|ya|yo|ts/gi, (m) => {
    const map: Record<string, string> = {
      sh: 'ш', sch: 'щ', ch: 'ч', zh: 'ж', yu: 'ю', ya: 'я', yo: 'ё', ts: 'ц',
    };
    return map[m.toLowerCase()] || m;
  }).split('').map(c => LAT_TO_CYR[c] || c).join('');
}

function toLatin(s: string): string {
  return s.split('').map(c => CYR_TO_LAT[c] || c).join('');
}

function splitWords(s: string): string[] {
  return s.replace(/[\s\/\-\|,x×:;()]+/g, ' ').trim().split(/\s+/).filter(w => w.length > 1);
}

// Расстояние Левенштейна для fuzzy-сравнения
function levenshtein(a: string, b: string): number {
  const m = a.length, n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, (_, i) =>
    Array.from({ length: n + 1 }, (_, j) => i === 0 ? j : j === 0 ? i : 0)
  );
  for (let i = 1; i <= m; i++)
    for (let j = 1; j <= n; j++)
      dp[i][j] = a[i-1] === b[j-1]
        ? dp[i-1][j-1]
        : 1 + Math.min(dp[i-1][j], dp[i][j-1], dp[i-1][j-1]);
  return dp[m][n];
}

function cleanForCompare(s: string): string {
  return s.replace(/[ьъ]/g, '');
}

function isSimilar(a: string, b: string): boolean {
  if (a === b) return true;
  const minLen = Math.min(a.length, b.length);
  const maxLen = Math.max(a.length, b.length);
  // Substring match: короткое слово должно быть хотя бы 50% длины длинного
  if (minLen >= 2 && minLen / maxLen >= 0.5 && (a.includes(b) || b.includes(a))) return true;
  if (maxLen <= 2) return a === b;
  const ac = cleanForCompare(a), bc = cleanForCompare(b);
  if (ac === bc) return true;
  const minC = Math.min(ac.length, bc.length);
  const maxC = Math.max(ac.length, bc.length);
  if (minC >= 2 && minC / maxC >= 0.5 && (ac.includes(bc) || bc.includes(ac))) return true;
  if (maxC > 2 && levenshtein(ac, bc) / maxC <= 0.45) return true;
  return false;
}

// Проверяет похожесть слова запроса на слово из названия проекта (все комбинации транслитераций)
function isWordMatch(query: string, nameWord: string): boolean {
  const variants = [
    [query, nameWord],
    [toCyrillic(query), toCyrillic(nameWord)],
    [toLatin(query), toLatin(nameWord)],
    [toCyrillic(query), nameWord],
    [query, toCyrillic(nameWord)],
    [toLatin(query), nameWord],
    [query, toLatin(nameWord)],
  ];
  return variants.some(([a, b]) => isSimilar(a, b));
}

// Слова-команды, которые не являются частью названия проекта
const STOP_WORDS = new Set([
  'статус', 'покажи', 'дай', 'скинь', 'проект', 'проекта', 'проекту', 'проектом', 'проекте', 'проекты', 'проектов',
  'по', 'для', 'мне', 'пожалуйста', 'плиз', 'status',
  'на', 'не', 'ну', 'да', 'нет', 'как', 'что', 'кто', 'где', 'когда', 'зачем', 'почему',
  'давай', 'обсудим', 'расскажи', 'подробнее', 'есть', 'нету', 'ещё', 'еще', 'сейчас',
  'утверден', 'утверждён', 'утверждены', 'утвержден', 'кастинге', 'кастинг',
  'какой', 'какая', 'какие', 'какого', 'вот', 'это', 'там', 'тут', 'вообще',
  'говорю', 'про', 'тоже', 'типа', 'блин', 'ладно',
]);

function extractQuery(message: string): string[] {
  return splitWords(message.toLowerCase()).filter(w => !STOP_WORDS.has(w));
}

function findProjectByFuzzy(message: string, projects: any[]): any | undefined {
  const msg = message.toLowerCase();
  const queryWords = extractQuery(msg);
  if (queryWords.length === 0) return undefined;

  let bestMatch: any = undefined;
  let bestScore = 0;

  for (const p of projects) {
    const name = p.project_name?.toLowerCase() || '';

    // Точное вхождение полного имени
    if (msg.includes(name)) return p;

    const nameWords = splitWords(name);
    if (nameWords.length === 0) continue;

    // Считаем сколько слов названия проекта нашлось в запросе
    let nameMatchCount = 0;
    for (const nw of nameWords) {
      if (queryWords.some(q => isWordMatch(q, nw))) nameMatchCount++;
    }

    // Хотя бы одно значимое слово названия совпало
    const score = nameMatchCount;
    if (score > 0 && score > bestScore) {
      bestScore = score;
      bestMatch = p;
    }
  }

  return bestMatch;
}

// Мета-вопросы о текущем проекте: "это из какого проекта?", "по какому проекту?", "какой это проект?"
// Не путать с переключением проекта или запросом списка проектов
function isMetaProjectQuestion(message: string): boolean {
  const msg = message.toLowerCase().replace(/[?!.]+/g, '').trim();
  const metaPatterns = [
    /(?:это\s+)?(?:из\s+)?какого\s+проект/,
    /(?:это\s+)?(?:по\s+)?каком[уы]\s+проект/,
    /какой\s+(?:это\s+)?проект/,
    /(?:это\s+)?(?:что\s+за|что\s+это\s+за)\s+проект/,
    /(?:из|по|для|про)\s+какого\s+(?:это\s+)?проект/,
    /(?:а\s+)?(?:это\s+)?(?:чей|чьи|чья)\s+проект/,
    /(?:а\s+)?(?:это\s+)?(?:к\s+какому|к\s+чьему)\s+проект/,
  ];
  return metaPatterns.some(p => p.test(msg));
}

function isManualStatusFresh(manual: { status: string; changedAt: string } | undefined): boolean {
  if (!manual || manual.status === 'Не определён') return false;
  const ageDays = (Date.now() - new Date(manual.changedAt).getTime()) / 86400000;
  return ageDays < MANUAL_STATUS_MAX_AGE_DAYS;
}

interface ConversationMessage {
  role: 'user' | 'assistant';
  content: string;
  timestamp: number;
}

const ADMIN_IDS: Set<string> = new Set(
  (process.env.ADMIN_IDS || process.env.TEST_TELEGRAM_ID || '489599665')
    .split(',')
    .map(id => id.trim())
    .filter(Boolean)
);

function isAdminUser(userId: string): boolean {
  return ADMIN_IDS.has(userId);
}

// Парсинг порядковых числительных: "первый" → 1, "второму" → 2, etc.
const ORDINALS: Record<string, number> = {
  'перв': 1, 'втор': 2, 'трет': 3, 'четверт': 4, 'четвёрт': 4,
  'пят': 5, 'шест': 6, 'седьм': 7, 'восьм': 8, 'девят': 9, 'десят': 10,
};

function parseOrdinalNumber(text: string): number | null {
  const lower = text.toLowerCase();

  // 1. Цифровой номер: "проект 3", "номер 3", "#3", "3 проект"
  const numMatch = lower.match(/(?:проект|номер|#)\s*(?:номер\s*)?(\d+)/) || lower.match(/(\d+)\s*(?:проект|номер)/);
  if (numMatch) return parseInt(numMatch[1], 10);

  // 2. Прямое указание цифры: "по 1", "1", "а по 2", "ну по 3", "давай по 2"
  const directMatch = lower.match(/^(?:(?:а|и|ну|ок|да|ладно|давай|хорошо|а\s+что)\s+)*(?:по\s+)?(\d+)$/);
  if (directMatch) return parseInt(directMatch[1], 10);

  // 3. Порядковые словами: "по первому", "давай второй", "третий проект"
  for (const [stem, num] of Object.entries(ORDINALS)) {
    if (lower.includes(stem)) return num;
  }

  return null;
}

// Очистка ответа AI: убираем "(источник) (t.me/...)" и лишний мусор
function cleanAIAnswer(text: string): string {
  return text
    // Убираем "(источник) (https://t.me/...)" — ссылки на исходные сообщения
    .replace(/\s*\(источник\)\s*\(https?:\/\/t\.me\/[^)]*\)/gi, '')
    // Убираем одиночные "(источник)"
    .replace(/\s*\(источник\)/gi, '')
    // Убираем ссылки на t.me/c/... (внутренние ссылки на сообщения чата)
    .replace(/\s*https?:\/\/t\.me\/c\/\d+\/\d+/g, '')
    // Убираем нерезолвленные теги [#123]
    .replace(/\s*\[#\d+\]/g, '');
}

// Попытка найти проект по номеру из сохранённого списка
function resolveProjectByNumber(text: string, savedList: any[] | undefined): any | null {
  if (!savedList) return null;
  const num = parseOrdinalNumber(text);
  if (num === null) return null;
  const idx = num - 1;
  if (idx >= 0 && idx < savedList.length) return savedList[idx];
  return null;
}

export class SmartBot {
  private bot: Telegraf;
  private userContext: Map<string, { projectId: number; timestamp: number }> = new Map();
  private conversationHistory: Map<string, ConversationMessage[]> = new Map();
  private pendingClientStatuses: Map<string, { clientTgId: string; projectName: string; clientText: string }> = new Map();
  private userProjectMap: Map<string, any[]> = new Map(); // userId → ordered project list for number references
  private lastQA: Map<string, { question: string; answer: string; timestamp: number }> = new Map(); // последний Q&A для follow-up

  constructor(token: string) {
    this.bot = new Telegraf(token, {
      handlerTimeout: 300000
    });
    try {
      this.setupHandlers();
      logger.info('All handlers registered successfully');
    } catch (error) {
      logger.error('ERROR registering handlers:', error);
    }
  }

  private setupHandlers() {
    // Команды работают только в личке — в группах бот молчит
    // DEBUG: логируем каждое входящее обновление
    this.bot.use(async (ctx, next) => {
      logger.info(`DEBUG incoming update: type=${ctx.updateType}, chat=${ctx.chat?.id}, from=${ctx.from?.id}`);
      if (ctx.chat?.type !== 'private' && ctx.message && 'text' in ctx.message && ctx.message.text.startsWith('/')) {
        return; // Игнорируем команды в группах
      }
      return next();
    });

    this.bot.command('help', async (ctx) => {
      try {
        const userId = ctx.from.id.toString();
        const isAdmin = isAdminUser(userId);

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

        const isAdmin = isAdminUser(userId);

        if (userType === 'producer' || isAdmin) {
          const projects = isAdmin ? await SupabaseClient.getAllProjects() : await this.getUserProjects(userId);
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
          const projectCount = Object.keys(updates).length;

          if (DRY_RUN) {
            ctx.reply(`Анализ завершен! Обработано проектов: ${projectCount}\nDRY RUN: Данные сохранены в projects_test и custom_block_statuses.\nУведомления продюсерам НЕ отправлены.`);
          } else {
            ctx.reply(`Анализ завершен! Статусы обновлены. Обработано проектов: ${projectCount}\nУведомления продюсерам НЕ отправлены (только анализ).`);
          }
        } else {
          ctx.reply('Анализ завершен. Новых обновлений нет.');
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

        const isAdmin = isAdminUser(userId);

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
        const isAdmin = isAdminUser(userId);
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
        if (!isAdminUser(userId)) {
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
        if (!isAdminUser(userId)) {
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
        if (!isAdminUser(userId)) {
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
        if (!isAdminUser(userId)) {
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

        // AI-статусы из custom_block_statuses (с on-demand анализом)
        const allStatuses = await getOrAnalyzeStatuses(projectId, project.project_name, activeBlocks);

        const statusMap: Record<string, string> = {};
        for (const block of activeBlocks) {
          const blockKey = block.id || block.name;

          // Ручной статус — приоритет только если свежий (< 5 дней)
          const manual = manualStatuses.get(blockKey);
          if (isManualStatusFresh(manual)) {
            statusMap[blockKey] = manual!.status;
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
        if (!isAdminUser(userId)) {
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
        if (!isAdminUser(userId)) {
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
        if (!isAdminUser(userId)) {
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
        if (!isAdminUser(userId)) {
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
    const GLOSSARY_APPROVERS = new Set([
      process.env.TEST_TELEGRAM_ID || '489599665',
      '121335318', // Денис
    ]);

    this.bot.command('admin_glossary', async (ctx) => {
      try {
        const userId = ctx.from.id.toString();

        if (!isAdminUser(userId)) {
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


        if (!isAdminUser(userId)) {
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


        if (!isAdminUser(userId)) {
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

    // === /admin_emoji — отправь кастомный эмодзи, бот покажет его ID ===
    this.bot.command('admin_emoji', async (ctx) => {
      try {
        const userId = ctx.from.id.toString();
        if (!isAdminUser(userId)) {
          ctx.reply('⛔ У вас нет доступа к этой команде.');
          return;
        }

        await ctx.reply(
          '🔍 Отправьте мне сообщение с кастомным эмодзи Cult.\n' +
          'Я покажу custom_emoji_id для каждого.\n\n' +
          'Можете отправить сразу несколько в одном сообщении.'
        );
      } catch (error) {
        logger.error('Error in /admin_emoji:', error);
      }
    });

    this.bot.command('admin_glossary_approve', async (ctx) => {
      try {
        const userId = ctx.from.id.toString();


        if (!isAdminUser(userId)) {
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


        if (!isAdminUser(userId)) {
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


        if (!isAdminUser(userId)) {
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
        const isAdmin = isAdminUser(userId);

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
        const isAdmin = isAdminUser(userId);

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
        const allStatuses = await getOrAnalyzeStatuses(projectId, project.project_name, activeBlocks);

        const statusMap: Record<string, string> = {};
        for (const block of activeBlocks) {
          const blockKey = block.id || block.name;
          const manual = manualStatuses.get(blockKey);
          if (isManualStatusFresh(manual)) {
            statusMap[blockKey] = manual!.status;
            continue;
          }
          const status = allStatuses.find((s: any) => s.block_id === blockKey);
          if (status?.status_analysis) {
            statusMap[blockKey] = status.status_analysis;
          }
        }

        let statusText = formatStatusForClient(activeBlocks, statusMap, format);

        // Убираем теги [#id] из статуса — ссылки на сообщения здесь не нужны
        statusText = statusText.replace(/\s*\[#\d+(?:,\s*#?\d+)*\]/g, '');

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
          const allStatuses = await getOrAnalyzeStatuses(projectId, project.project_name, activeBlocks);
          const statusMap: Record<string, string> = {};
          for (const block of activeBlocks) {
            const blockKey = block.id || block.name;
            const manual = manualStatuses.get(blockKey);
            if (isManualStatusFresh(manual)) {
              statusMap[blockKey] = manual!.status;
              continue;
            }
            const status = allStatuses.find((s: any) => s.block_id === blockKey);
            if (status?.status_analysis) {
              statusMap[blockKey] = status.status_analysis;
            }
          }

          let statusText = formatStatusForClient(activeBlocks, statusMap, newFormat);

          // Убираем теги [#id] из статуса
          statusText = statusText.replace(/\s*\[#\d+(?:,\s*#?\d+)*\]/g, '');

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
          `Статус на сегодня по проекту "${pending.projectName}":\n\n${pending.clientText}`,
          { parse_mode: 'HTML' }
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
        const allStatuses = await getOrAnalyzeStatuses(projectId, project.project_name, activeBlocks);

        const statusMap: Record<string, string> = {};
        for (const block of activeBlocks) {
          const blockKey = block.id || block.name;
          const manual = manualStatuses.get(blockKey);
          if (isManualStatusFresh(manual)) {
            statusMap[blockKey] = manual!.status;
            continue;
          }
          const status = allStatuses.find((s: any) => s.block_id === blockKey);
          if (status?.status_analysis) {
            statusMap[blockKey] = status.status_analysis;
          }
        }

        // Формируем HTML с эмодзи (то же, что основной статус, но без [#ID])
        const clientSettings = await SupabaseClient.getClientSettings(projectId);
        const defaults = getDefaultClientSettings();
        const format = clientSettings.format_status || defaults.format_status;
        let statusText = formatStatusForClient(activeBlocks, statusMap, format);
        statusText = statusText.replace(/\s*\[#\d+(?:,\s*#?\d+)*\]/g, '');

        const copyMessage = `📋 ${project.project_name}\n\n${statusText}`;

        if (copyMessage.length <= 4000) {
          await ctx.reply(copyMessage, { parse_mode: 'HTML' });
        } else {
          const parts = this.splitMessage(copyMessage, 4000);
          for (const part of parts) {
            await ctx.reply(part, { parse_mode: 'HTML' });
          }
        }
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
        const allStatuses = await getOrAnalyzeStatuses(projectId, project.project_name, activeBlocks);

        const statusMap: Record<string, string> = {};
        for (const block of activeBlocks) {
          const blockKey = block.id || block.name;
          const manual = manualStatuses.get(blockKey);
          if (isManualStatusFresh(manual)) {
            statusMap[blockKey] = manual!.status;
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

        // Ищем групповой чат проекта (outer) вместо личного чата клиента
        const outerChat = await SupabaseClient.getOuterChat(projectId);
        const clientTgId = outerChat?.telegram_chat_id?.toString();
        if (!clientTgId) {
          await ctx.reply(`❌ У проекта "${project.project_name}" нет привязанного клиентского чата.`);
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

    this.bot.on('message', async (ctx, next) => {
      // В личке — пропускаем, обработается в on('text') ниже
      if (ctx.chat?.type === 'private') return next();

      // Группа/супергруппа — молча собираем сообщения
      try {
        if (!ctx.message || !('text' in ctx.message)) return;

        const message = ctx.message;
        const chatId = message.chat.id.toString();
        const senderId = message.from!.id.toString();
        const messageText = this.extractMessageWithLinks(message);
        const chatName = 'title' in message.chat ? message.chat.title : '';

        const tgMsgId = message.message_id;
        const senderUsername = message.from?.username || '';
        const senderName = [message.from?.first_name, message.from?.last_name].filter(Boolean).join(' ');
        logger.info(`Saving message from chat ${chatId}, telegram_message_id=${tgMsgId}, sender: @${senderUsername} (${senderName})`);

        await SupabaseClient.saveMessage({
          telegram_chat_id: chatId,
          sender_id: senderId,
          message_text: messageText,
          chat_name_tg: chatName || '',
          is_analyzed: false,
          telegram_message_id: tgMsgId,
          sender_username: senderUsername,
          sender_name: senderName
        });

        logger.info(`Message collected from chat ${chatId}`);
      } catch (error) {
        logger.error('Error collecting message:', error);
      }
    });

    this.bot.on('text', async (ctx: Context) => {
      if (!ctx.message || !('text' in ctx.message)) return;
      if (!ctx.from) return;
      if (ctx.chat?.type !== 'private') return;

      const userId = ctx.from.id.toString();
      const userMessage = ctx.message.text;

      const allEntities = (ctx.message as any).entities || [];
      logger.info(`DEBUG text handler: user=${userId}, text="${userMessage.substring(0, 50)}", entities=${JSON.stringify(allEntities.map((e: any) => ({ type: e.type, custom_emoji_id: e.custom_emoji_id })))}`);

      if (userMessage.startsWith('/')) return;

      const customEmojis = allEntities.filter((e: any) => e.type === 'custom_emoji');
      if (customEmojis.length > 0 && isAdminUser(userId)) {
        logger.info(`Smart Bot: Found ${customEmojis.length} custom emoji from admin`);
        const emojiInfo = customEmojis.map((e: any, i: number) => {
          const emojiText = userMessage.substring(e.offset, e.offset + e.length);
          return `${i + 1}. "${emojiText}" → custom_emoji_id: ${e.custom_emoji_id}`;
        }).join('\n');
        await ctx.reply(
          `🔍 Найдено ${customEmojis.length} кастомных эмодзи:\n\n${emojiInfo}`
        );
        return;
      }

      await this.handleTextMessage(ctx, userMessage);
    });

    this.bot.on('voice', async (ctx) => {
      if (!ctx.from || ctx.chat?.type !== 'private') return;

      const YANDEX_API_KEY = process.env.YANDEX_API_KEY;
      const YANDEX_FOLDER_ID = process.env.YANDEX_FOLDER_ID;
      if (!YANDEX_API_KEY || !YANDEX_FOLDER_ID) {
        logger.warn('YANDEX_API_KEY or YANDEX_FOLDER_ID not set, voice messages disabled');
        await ctx.reply('Голосовые сообщения пока не подключены.');
        return;
      }

      try {
        await ctx.sendChatAction('typing');

        const fileId = ctx.message.voice.file_id;
        const file = await ctx.telegram.getFile(fileId);
        const fileUrl = `https://api.telegram.org/file/bot${this.bot.telegram.token}/${file.file_path}`;

        const audioResponse = await axios.get(fileUrl, { responseType: 'arraybuffer' });
        const audioBuffer = Buffer.from(audioResponse.data);

        const sttResponse = await axios.post(
          'https://stt.api.cloud.yandex.net/speech/v1/stt:recognize',
          audioBuffer,
          {
            params: {
              folderId: YANDEX_FOLDER_ID,
              lang: 'ru-RU',
              format: 'oggopus',
            },
            headers: {
              'Authorization': `Api-Key ${YANDEX_API_KEY}`,
              'Content-Type': 'application/octet-stream',
            },
            timeout: 30000,
          }
        );

        const transcribedText = sttResponse.data?.result?.trim();
        if (!transcribedText) {
          await ctx.reply('Не удалось распознать голосовое сообщение.');
          return;
        }

        logger.info(`Voice transcribed for user ${ctx.from.id}: "${transcribedText}"`);

        await this.handleTextMessage(ctx, transcribedText);
      } catch (error: any) {
        logger.error('Voice transcription error:', error?.response?.data || error.message);
        await ctx.reply('Ошибка при обработке голосового сообщения.');
      }
    });
  }

  private async handleTextMessage(ctx: Context, userMessage: string) {
    const userId = ctx.from!.id.toString();

    const CONTEXT_TTL = 40 * 60 * 1000; // 40 минут

    try {
      logger.info(`Smart Bot: User ${userId} sent: ${userMessage}`);

      const userType = await this.getUserType(userId);
      const isAdmin = isAdminUser(userId);
      const userProjects = isAdmin
        ? await SupabaseClient.getAllProjects()
        : await this.getUserProjects(userId);
      logger.info(`User ${userId}: type=${userType}, isAdmin=${isAdmin}, projects=${userProjects?.length || 0}`);

      let context = this.userContext.get(userId);

      // === 1. Проверяем, не просит ли пользователь статус ===
      const statusKeywords = ['статус', 'status', 'как дела по проект', 'что по проект', 'как там по проект', 'что там по проект', 'че там по проект', 'чё там по проект', 'че по проект', 'чё по проект'];
      const msgLowerCheck = userMessage.toLowerCase();
      // "проект 3", "номер 3", "первый проект", "давай по второму" — тоже запрос статуса
      const hasProjectNumber = parseOrdinalNumber(msgLowerCheck) !== null && this.userProjectMap.has(userId);

      // Если в сообщении есть дополнительный вопрос кроме запроса статуса — это PROJECT_QUESTION, не статус
      const questionIndicators = [
        'сложност', 'проблем', 'вопрос', 'когда', 'кто', 'зачем', 'почему', 'сколько',
        'ссылк', 'материал', 'кастинг', 'монтаж', 'музык', 'графи', 'сценари',
        'согласован', 'утвержд', 'правк', 'дедлайн', 'срок', 'готов',
        '?', // если есть вопросительный знак после statusKeyword — скорее вопрос
      ];
      const hasStatusKeyword = statusKeywords.some(kw => msgLowerCheck.includes(kw));
      const hasQuestionIndicator = questionIndicators.some(qi => msgLowerCheck.includes(qi));
      // Два предложения в сообщении = скорее всего есть и запрос статуса и доп. вопрос
      const hasMultipleSentences = (userMessage.match(/[.!?]\s+[а-яА-Яa-zA-Z]/g) || []).length > 0;
      const isStatusWithQuestion = hasStatusKeyword && (hasQuestionIndicator || hasMultipleSentences);

      // Если есть lastQA с незавершённым вопросом и пользователь просто выбирает проект по номеру —
      // это ответ на предыдущий вопрос, а не запрос статуса
      const pendingQA = this.lastQA.get(userId);
      const hasPendingQuestion = pendingQA && pendingQA.answer === '' && (Date.now() - pendingQA.timestamp < CONTEXT_TTL);
      const isJustProjectSelection = hasProjectNumber && !hasStatusKeyword && hasPendingQuestion;

      // Если есть завершённый Q&A (с ответом) и пользователь пишет "а по 2" без слова "статус" —
      // это follow-up к предыдущему вопросу ("дай ссылки по вк" → "а по 2" = ссылки для проекта 2)
      const hasRecentAnswer = pendingQA && pendingQA.answer !== '' && (Date.now() - pendingQA.timestamp < CONTEXT_TTL);
      const isFollowUpToQuestion = hasProjectNumber && !hasStatusKeyword && hasRecentAnswer;

      const isAskingForStatus = !isStatusWithQuestion && !isJustProjectSelection && !isFollowUpToQuestion && (hasProjectNumber || hasStatusKeyword);

      if (isJustProjectSelection) {
        // Пользователь выбирает проект для предыдущего вопроса ("по первому" после "кинь ссылки")
        const savedList = this.userProjectMap.get(userId);
        let selectedProject = resolveProjectByNumber(userMessage, savedList);
        if (!selectedProject) {
          selectedProject = findProjectByFuzzy(userMessage.toLowerCase(), userProjects);
        }
        if (!selectedProject && savedList) {
          const projectNames = savedList.map((p: any) => p.project_name);
          const aiIndex = await AIServiceClient.resolveProject(userMessage, projectNames);
          if (aiIndex > 0 && aiIndex <= savedList.length) {
            selectedProject = savedList[aiIndex - 1];
          }
        }
        if (selectedProject) {
          this.userContext.set(userId, { projectId: selectedProject.project_id, timestamp: Date.now() });
          logger.info(`Project selected for pending question: ${selectedProject.project_name}, question: "${pendingQA!.question}"`);
          // Подставляем предыдущий вопрос и пускаем дальше по flow
          userMessage = pendingQA!.question;
          context = { projectId: selectedProject.project_id, timestamp: Date.now() };
        }
      }

      if (isAskingForStatus) {
        await ctx.sendChatAction('typing');

        if (!userProjects || userProjects.length === 0) {
          await ctx.reply('У вас пока нет привязанных проектов.');
          return;
        }

        const msgLower = userMessage.toLowerCase();
        let projectsToShow = userProjects;

        // Проверяем номер проекта ("проект 3", "номер 3", "первый", "давай по второму")
        const selectedByNumber = resolveProjectByNumber(msgLower, this.userProjectMap.get(userId));
        if (selectedByNumber) {
          projectsToShow = [selectedByNumber];
          this.userContext.set(userId, { projectId: selectedByNumber.project_id, timestamp: Date.now() });
          logger.info(`Project selected by number: ${selectedByNumber.project_name}`);
        }

        if (projectsToShow.length > 1) {
          // Если номер не сработал — пробуем fuzzy
          const mentionedInStatus = findProjectByFuzzy(msgLower, userProjects);
          if (mentionedInStatus) {
            projectsToShow = [mentionedInStatus];
          } else {
            // AI-fallback: спрашиваем нейронку какой проект имеется в виду
            if (this.userProjectMap.has(userId)) {
              const savedList = this.userProjectMap.get(userId)!;
              const projectNames = savedList.map((p: any) => p.project_name);
              const aiIndex = await AIServiceClient.resolveProject(userMessage, projectNames);
              if (aiIndex > 0 && aiIndex <= savedList.length) {
                projectsToShow = [savedList[aiIndex - 1]];
                logger.info(`Status project resolved by AI: "${userMessage}" → ${savedList[aiIndex - 1].project_name}`);
              }
            }
            // Если AI тоже не помог — контекст
            if (projectsToShow.length > 1) {
              const ctx2 = this.userContext.get(userId);
              if (ctx2 && (Date.now() - ctx2.timestamp < CONTEXT_TTL)) {
                const contextProject = userProjects.find((p: any) => p.project_id === ctx2.projectId);
                if (contextProject) {
                  projectsToShow = [contextProject];
                  logger.info(`Status from context: project ${contextProject.project_id} (${contextProject.project_name})`);
                }
              }
            }
          }
        }

        if (projectsToShow.length > 1) {
          await ctx.reply(`📊 Статусы ваших проектов (${projectsToShow.length}):`);
        }

        await this.sendStatusForProjects(ctx, projectsToShow);

        if (projectsToShow.length === 1) {
          this.userContext.set(userId, { projectId: projectsToShow[0].project_id, timestamp: Date.now() });
          logger.info(`Context set after status: project ${projectsToShow[0].project_id} (${projectsToShow[0].project_name})`);
        }
        // Сбрасываем lastQA после показа статуса — иначе стейл-вопрос ("а рыбы?") может подхватиться
        // при follow-up типа "а по 2" и бот ответит на старый вопрос вместо показа статуса
        this.lastQA.delete(userId);
        return;
      }

      // === 2. Определяем контекст проекта ===
      context = this.userContext.get(userId); // refresh after possible update in section 1

      if (ctx.message && 'reply_to_message' in ctx.message && ctx.message.reply_to_message) {
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

      // Мета-вопрос ("это из какого проекта?") — отвечаем из текущего контекста, не ищем проект
      if (isMetaProjectQuestion(userMessage)) {
        if (context && (Date.now() - context.timestamp) < CONTEXT_TTL) {
          const project = await SupabaseClient.getProject(context.projectId);
          const projectName = project?.project_name || `#${context.projectId}`;
          logger.info(`Meta-question detected: "${userMessage}" → answering with current context: ${projectName}`);
          await ctx.reply(`Это по проекту «${projectName}».`);
          return;
        } else {
          logger.info(`Meta-question detected: "${userMessage}" → no active project context`);
          if (userProjects && userProjects.length > 0) {
            const list = userProjects.map((p: any, i: number) => `${i + 1}. ${p.project_name}`).join('\n');
            this.userProjectMap.set(userId, userProjects);
            await ctx.reply(`Сейчас нет активного контекста проекта. Ваши проекты:\n\n${list}\n\n💡 Напишите название или номер проекта.`);
          } else {
            await ctx.reply('Сейчас нет активного контекста проекта.');
          }
          return;
        }
      }

      // Всегда проверяем, упоминается ли проект в сообщении (для переключения контекста)
      let projectSwitched = false;
      // Сначала пробуем по номеру ("первый", "проект 2"), потом fuzzy по названию, потом AI
      let mentionedProject = resolveProjectByNumber(userMessage, this.userProjectMap.get(userId))
        || findProjectByFuzzy(userMessage.toLowerCase(), userProjects);
      // AI-fallback: если не нашли и есть сохранённый список — спрашиваем нейронку
      if (!mentionedProject && this.userProjectMap.has(userId)) {
        const savedList = this.userProjectMap.get(userId)!;
        const projectNames = savedList.map((p: any) => p.project_name);
        const aiIndex = await AIServiceClient.resolveProject(userMessage, projectNames);
        if (aiIndex > 0 && aiIndex <= savedList.length) {
          mentionedProject = savedList[aiIndex - 1];
          logger.info(`Project resolved by AI: "${userMessage}" → ${mentionedProject.project_name}`);
        }
      }
      if (mentionedProject) {
        const oldProjectId = context?.projectId;
        // Если сообщение — просто название проекта (ответ на "какой проект?"), а в lastQA есть вопрос — повторяем вопрос для нового проекта
        const msgClean = userMessage.toLowerCase().replace(/[^а-яёa-z0-9\s]/g, '').trim();
        const isJustProjectName = msgClean.split(/\s+/).length <= 3;
        const prevQA = this.lastQA.get(userId);
        if (isJustProjectName && prevQA && (Date.now() - prevQA.timestamp < CONTEXT_TTL)) {
          logger.info(`User replied with just project name "${mentionedProject.project_name}", re-using previous question: "${prevQA.question}"`);
          context = { projectId: mentionedProject.project_id, timestamp: Date.now() };
          this.userContext.set(userId, context);
          // Подставляем предыдущий вопрос с новым проектом
          userMessage = prevQA.question;
        } else {
          context = { projectId: mentionedProject.project_id, timestamp: Date.now() };
          this.userContext.set(userId, context);
        }
        // Если проект сменился — не передаём старый Q&A контекст
        if (oldProjectId && oldProjectId !== mentionedProject.project_id) {
          projectSwitched = true;
        }
        logger.info(`Context set from mention: project ${mentionedProject.project_id} (${mentionedProject.project_name})`);
      } else if (!context || (Date.now() - context.timestamp) >= CONTEXT_TTL) {
        if (userProjects.length === 1) {
          context = { projectId: userProjects[0].project_id, timestamp: Date.now() };
          this.userContext.set(userId, context);
          logger.info(`Context auto-set: single project ${userProjects[0].project_id}`);
        }
      }

      // === 3. "Какие проекты?" — показать список всех проектов пользователя ===
      const projectListKeywords = [
        'какие проекты', 'мои проекты', 'список проектов', 'все проекты', 'проекты в работе',
        'другие проекты', 'другой проект', 'ещё проекты', 'еще проекты',
        'что по другим', 'а что еще', 'а что ещё', 'остальные проекты', 'что еще в работе',
        'какие еще', 'какие ещё',
        'у меня проекты', 'покажи проекты', 'мои проекты', 'сколько проектов',
      ];
      if (projectListKeywords.some(kw => userMessage.toLowerCase().includes(kw))) {
        if (userProjects && userProjects.length > 0) {
          const list = userProjects.map((p: any, i: number) => `${i + 1}. ${p.project_name}`).join('\n');
          this.userProjectMap.set(userId, userProjects);
          await ctx.reply(`📂 Ваши проекты (${userProjects.length}):\n\n${list}\n\n💡 Напишите "статус [название]" или "проект 3" для подробной информации.`);
          return;
        } else {
          logger.warn(`User ${userId} asked for projects but none found (userType: ${userType})`);
          await ctx.reply('У вас пока нет активных проектов. Если это ошибка — обратитесь к администратору Cult.');
          return;
        }
      }

      // === 4. Есть контекст проекта → классифицируем CORRECTION / PROJECT_SWITCH / GENERAL (реакции), остальное = вопрос по проекту ===
      if (context && (Date.now() - context.timestamp) < CONTEXT_TTL) {
        const project = await SupabaseClient.getProject(context.projectId);

        // Короткие реакции/благодарности → пропускаем в общий чат, не анализируем переписку
        const chatReactions = [
          'спасибо', 'спс', 'благодарю', 'молодец', 'круто', 'класс', 'супер', 'огонь',
          'ок', 'окей', 'ладно', 'понял', 'поняла', 'понятно', 'ясно', 'хорошо', 'отлично',
          'привет', 'здравствуй', 'добрый', 'пока', 'до свидания', 'ахах', 'хаха', 'лол',
          'да', 'нет', 'угу', 'ага', 'ну', 'ок)', 'ладненько', 'красава', 'имба', 'топ',
        ];
        const msgTrimmed = userMessage.toLowerCase().replace(/[!?.,:;)\s]+$/g, '').trim();
        const isChatReaction = chatReactions.some(r => msgTrimmed === r || msgTrimmed.startsWith(r + ' '));
        if (isChatReaction && msgTrimmed.length < 30) {
          // Пропускаем в общий AI-чат (секция 5)
          logger.info(`Chat reaction detected: "${userMessage}" — skipping project analysis`);
        } else {

        const intent = await AIServiceClient.classifyIntent(userMessage, project?.project_name || '');
        logger.info(`Intent classification: "${userMessage}" → ${intent}`);

        // Переключение на другие проекты
        if (intent === 'PROJECT_SWITCH' && userProjects && userProjects.length > 0) {
          // Если в сообщении упоминается конкретный проект — переключаем контекст и отвечаем как вопрос
          const mentionedInSwitch = findProjectByFuzzy(userMessage.toLowerCase(), userProjects);
          if (mentionedInSwitch) {
            context = { projectId: mentionedInSwitch.project_id, timestamp: Date.now() };
            this.userContext.set(userId, context);
            logger.info(`PROJECT_SWITCH with specific project "${mentionedInSwitch.project_name}" → treating as PROJECT_QUESTION`);
            // Не return — провалится в блок вопроса по проекту ниже
          } else {
            const list = userProjects.map((p: any, i: number) => `${i + 1}. ${p.project_name}`).join('\n');
            this.userProjectMap.set(userId, userProjects);
            await ctx.reply(`📂 Ваши проекты (${userProjects.length}):\n\n${list}\n\n💡 Напишите "статус [название]" или "проект 3" для подробной информации.`);
            return;
          }
        }

        // Коррекция статуса
        if (intent === 'CORRECTION') {
          this.userContext.set(userId, { projectId: context.projectId, timestamp: Date.now() });
          await ctx.sendChatAction('typing');
          await ctx.reply('📝 Понял, обновляю статус для вас...');
          try {
            await this.handleStatusCorrection(ctx, context.projectId, userMessage);
            return;
          } catch (error) {
            logger.error('Error handling correction:', error);
            await ctx.reply('❌ Произошла ошибка при обновлении статусов');
            return;
          }
        }

        // Всё остальное (включая GENERAL) → вопрос по проекту (раз контекст есть)
        {
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

          const prevQA = this.lastQA.get(userId);
          // При переключении проекта не передаём старый Q&A — AI будет искать заново
          const previousQA = (!projectSwitched && prevQA && (Date.now() - prevQA.timestamp < CONTEXT_TTL))
            ? { question: prevQA.question, answer: prevQA.answer }
            : undefined;

          const answer = await this.answerQuestionIteratively(
            context.projectId,
            project.project_name,
            userMessage,
            progressMsg.message_id,
            ctx,
            previousQA
          );

          // Сохраняем Q&A для follow-up вопросов
          this.lastQA.set(userId, { question: userMessage, answer, timestamp: Date.now() });

          try {
            await ctx.telegram.deleteMessage(ctx.chat!.id, progressMsg.message_id);
          } catch (e) {}

          // Убираем ВСЕ HTML-теги, оставляем голые URL — Telegram сам сделает их кликабельными
          const cleanAnswer = answer
            .replace(/<a\s+href="([^"]*)"[^>]*>[^<]*<\/a>/gi, '$1')  // <a href="url">text</a> → url
            .replace(/<a\s+href="?([^">\s]*)"?[^>]*/gi, '$1')  // broken <a> tags → url
            .replace(/<\/?[^>]*>/g, '')  // strip all remaining HTML tags
            .replace(/&amp;/g, '&')
            .replace(/&lt;/g, '<')
            .replace(/&gt;/g, '>');
          // Telegram лимит — 4096 символов. Разбиваем по строкам если не влезает.
          if (cleanAnswer.length <= 4096) {
            await ctx.reply(cleanAnswer);
          } else {
            const lines = cleanAnswer.split('\n');
            let chunk = '';
            for (const line of lines) {
              if ((chunk + '\n' + line).length > 4000) {
                if (chunk) await ctx.reply(chunk.trim());
                chunk = line;
              } else {
                chunk += (chunk ? '\n' : '') + line;
              }
            }
            if (chunk.trim()) await ctx.reply(chunk.trim());
          }
          return;
        } catch (error: any) {
          logger.error('Error answering question from conversation:', error);
          try {
            await ctx.telegram.deleteMessage(ctx.chat!.id, progressMsg.message_id);
          } catch (e) {}
        }
        } // end project question block
      } // end else (not chat reaction)
      }

      if (userProjects && userProjects.length > 0) {
        const mentionedAny = findProjectByFuzzy(userMessage.toLowerCase(), userProjects);
        if (mentionedAny) {
          this.userContext.set(userId, { projectId: mentionedAny.project_id, timestamp: Date.now() });
          logger.info(`Context set from message: project ${mentionedAny.project_id} (${mentionedAny.project_name})`);
        }
      }

      // === 5. Если вопрос явно про работу, но нет контекста проекта — спрашиваем какой проект ===
      const workKeywords = [
        'кастинг', 'монтаж', 'музык', 'сценари', 'графи', 'локаци', 'реквизит', 'костюм',
        'съемк', 'съёмк', 'согласован', 'правк', 'ссылк', 'материал', 'драфт', 'мастер',
        'трейлер', 'выпуск', 'ролик', 'видео', 'фото', 'ретуш', 'цветокоррекц',
        'документ', 'смет', 'акт', 'договор', 'бюджет', 'дедлайн', 'срок',
        'клиент', 'продюсер', 'режиссер', 'оператор', 'эксперт', 'блогер',
        'сложност', 'проблем', 'задерж', 'статус',
      ];
      const msgLowerForWork = userMessage.toLowerCase();
      const looksLikeWorkQuestion = workKeywords.some(kw => msgLowerForWork.includes(kw));
      if (looksLikeWorkQuestion && userProjects && userProjects.length > 1) {
        // Сохраняем вопрос в lastQA чтобы при ответе "вк" подхватился
        this.lastQA.set(userId, { question: userMessage, answer: '', timestamp: Date.now() });
        const list = userProjects.map((p: any, i: number) => `${i + 1}. ${p.project_name}`).join('\n');
        this.userProjectMap.set(userId, userProjects);
        await ctx.reply(`По какому проекту?\n\n${list}\n\n💡 Напишите название или номер проекта.`);
        return;
      }

      // === 6. Общий AI-чат ===
      await ctx.sendChatAction('typing');

      const response = await AIServiceClient.chatWithContext({
        userId,
        message: userMessage,
        userType,
        projects: userProjects
      });

      await ctx.reply(markdownToHtml(response.answer), { parse_mode: 'HTML' });

    } catch (error) {
      logger.error('Smart Bot error:', error);
      await ctx.reply('Извините, произошла ошибка. Попробуйте позже.');
    }
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

        // Проверяем, нужен ли AI-анализ (есть ли stale/missing блоки)
        const cachedStatuses = await SupabaseClient.getCustomBlockStatuses(project.project_id);
        const now = Date.now();
        const needsAnalysis = activeBlocks.some(block => {
          const blockKey = block.id || block.name;
          const cached = cachedStatuses.find((s: any) => s.block_id === blockKey && s.status_analysis);
          if (!cached) return true;
          return (now - new Date(cached.updated_at).getTime()) / 3600000 >= CACHE_MAX_AGE_HOURS;
        });

        // Если нужен AI-анализ — показываем прогресс-сообщение
        let progressMsg: any = null;
        if (needsAnalysis) {
          progressMsg = await ctx.reply(`🔍 Анализирую проект ${project.project_name}...`);
        }

        const allStatuses = await getOrAnalyzeStatuses(project.project_id, project.project_name, activeBlocks);

        // Удаляем прогресс-сообщение
        if (progressMsg) {
          try { await ctx.deleteMessage(progressMsg.message_id); } catch {}
        }

        const statusMap: Record<string, string> = {};
        for (const block of activeBlocks) {
          const blockKey = block.id || block.name;
          const manual = manualStatuses.get(blockKey);
          if (isManualStatusFresh(manual)) {
            logger.info(`  [statusMap] ${blockKey} → MANUAL: "${manual!.status}"`);
            statusMap[blockKey] = manual!.status;
            continue;
          }
          if (manual) {
            const ageDays = (Date.now() - new Date(manual.changedAt).getTime()) / 86400000;
            logger.info(`  [statusMap] ${blockKey} → MANUAL EXPIRED (${ageDays.toFixed(1)}d): "${manual.status}" — using AI`);
          }
          const status = allStatuses.find((s: any) => s.block_id === blockKey);
          if (status?.status_analysis) {
            logger.info(`  [statusMap] ${blockKey} → AI: "${status.status_analysis.substring(0, 60)}..."`);
            statusMap[blockKey] = status.status_analysis;
          }
        }

        let statusText = formatStatusForClient(activeBlocks, statusMap, format);

        // Убираем ссылки на сообщения [#34700] — в статусе они не нужны
        statusText = statusText.replace(/\s*\[#\d+(?:,\s*#?\d+)*\]/g, '');

        const statusMessage = `📋 ${project.project_name}\n\n${statusText}`;

        const buttons = Markup.inlineKeyboard([
          Markup.button.callback('📤 Отправить клиенту', `client_status:${project.project_id}`),
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
    ctx: any,
    previousQA?: { question: string; answer: string }
  ): Promise<string> {
    const BATCH_SIZE = 200;
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
          messageCount: messages.length,
          previousQA: previousQA
        });

        if (!result.needsMore) {
          logger.info(`Found answer using ${messages.length} messages`);
          const linkMap = SupabaseClient.buildMessageLinkMap(messages);
          let answer = cleanAIAnswer(result.answer);
          if (linkMap.size > 0) {
            answer = resolveMessageLinksHtml(answer, linkMap);
          }
          return markdownToHtml(answer);
        }

        if (messages.length < currentLimit) {
          logger.info(`No more messages available (${messages.length} total)`);
          const linkMap = SupabaseClient.buildMessageLinkMap(messages);
          let answer = cleanAIAnswer(result.answer);
          if (linkMap.size > 0) {
            answer = resolveMessageLinksHtml(answer, linkMap);
          }
          return markdownToHtml(answer);
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

      const allStatuses = await getOrAnalyzeStatuses(projectId, project.project_name, activeBlocks);

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

      await ctx.reply(`✅ Обновлено ${updatedCount} блоков. Формирую обновлённый статус...`);

      const { sendStatusToProducerAdmin } = await import('../workflows/status-scheduler');
      await sendStatusToProducerAdmin(project);

      await ctx.reply(`✅ Готово! Статус обновлён (только для вас, клиенту не отправлялось).\n\n💡 Если нужно ещё что-то поправить — напишите.`);

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
        await this.bot.telegram.sendMessage(producerTgChatId, fullMessage, { parse_mode: 'HTML' });
      } else {
        const parts = this.splitMessage(updates, MAX_LENGTH - header.length);

        for (let i = 0; i < parts.length; i++) {
          const partHeader = i === 0
            ? header
            : `Статус на сегодня по проекту "${projectName}" (часть ${i + 1}):\n\n`;

          await this.bot.telegram.sendMessage(
            producerTgChatId,
            partHeader + parts[i],
            { parse_mode: 'HTML' }
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
        await this.bot.telegram.sendMessage(producerTgChatId, fullMessage, { parse_mode: 'HTML', ...keyboard });
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
            { parse_mode: 'HTML', ...(isLast ? keyboard : {}) }
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

      const allStatuses = await getOrAnalyzeStatuses(project.project_id, project.project_name, activeBlocks);

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
