# 📚 Структура проекта Status Ninja

## 🗂️ Основные папки

```
backend/
├── src/
│   ├── bot/              # Telegram боты
│   ├── database/         # Клиенты для работы с БД
│   ├── services/         # Сервисы (AI, внешние API)
│   ├── workflows/        # Бизнес-логика и оркестрация
│   └── utils/            # Утилиты (логгер и т.д.)
├── sql/                  # SQL скрипты
└── dist/                 # Скомпилированный JS (генерируется)

ai-service/
├── src/
│   ├── api.py           # FastAPI endpoints
│   ├── chains/          # LangChain цепочки
│   └── prompts/         # AI промпты
└── venv/                # Python виртуальное окружение
```

---

## 🤖 Боты (src/bot/)

### `smart-bot.ts`
**Главный бот** - анализирует статусы и общается с продюсерами/клиентами

**Основные команды:**
- `/start` - Приветствие
- `/help` - Справка по командам
- `/status` - Показать статусы всех проектов пользователя
- `/analyze` - Запустить анализ вручную (только продюсеры)

**Админские команды (TEST_TELEGRAM_ID):**
- `/admin_projects` - Список всех проектов с ID
- `/admin_settings [ID]` - Настройки клиента для проекта
- `/admin_blocks [ID]` - Активные блоки проекта
- `/admin_status [ID]` - Текущий статус из БД (projects table)
- `/admin_send_now [ID]` - Отправить статус продюсеру прямо сейчас
- `/admin_reanalyze [ID]` - Перезапустить анализ с новыми промптами

**Основные функции:**
- `getUserType()` - Определяет producer/client по Telegram ID
- `getUserProjects()` - Получает проекты пользователя
- `formatProjectStatusDynamic()` - Форматирует статус проекта для отображения
- `notifyProducer()` - Отправляет уведомление продюсеру
- `getStandardFieldMapping()` - Маппинг блоков на поля БД

### `collect-bot.ts`
**Бот-коллектор** - собирает сообщения из Telegram чатов

**Функции:**
- Слушает все сообщения в чатах где добавлен
- Сохраняет в таблицу `messages`
- Связывает с проектами через `telegram_chat_id`

### `get-id-bot.ts`
**Вспомогательный бот** - получает Telegram ID пользователя

**Использование:**
- Переслать сообщение от пользователя боту
- Бот вернёт Telegram ID

---

## 💾 База данных (src/database/)

### `supabase.ts`
**Главный клиент для БД Status Ninja**

#### 📨 MESSAGES (Сообщения)
```typescript
saveMessage(data)                    // Сохранить сообщение
getUnanalyzedMessages(chatId, limit) // Получить непроанализированные
getLastMessages(chatId, limit)       // Получить последние N сообщений
markMessagesAsAnalyzed(messageIds)   // Пометить как проанализированные
```

**Таблица:** `messages`
```sql
- message_id (PK)
- telegram_chat_id
- sender_id
- message_text
- chat_name_tg
- timestamp
- is_analyzed (boolean)
```

#### 📁 PROJECTS (Проекты)
```typescript
getProject(projectId)                      // Получить проект с продюсером и клиентом
getAllProjects()                           // Все проекты с продюсерами
updateProjectField(id, field, value)       // Обновить одно поле
updateProjectFields(id, fields)            // Обновить несколько полей
```

**Таблица:** `projects` (ПРОДАКШН - используется n8n)
```sql
- project_id (PK)
- project_name
- producer_id (FK)
- producer2, producer3
- client_id (FK)
- client2, client3
- doc                    # Статус: Документы
- storyboard_cult        # Статус: Раскадровка (команда)
- storyboard_client      # Статус: Раскадровка (клиент)
- casting_cult           # Статус: Кастинг
- location_cult          # Статус: Локации
- props_cult             # Статус: Реквизит
- clothes_cult           # Статус: Одежда/костюм
- editing_cult           # Статус: Монтаж
- vo_cult                # Статус: Войсовер
- music_cult             # Статус: Музыка
- colorgrading_cult      # Статус: Цветокоррекция
- photos_cult            # Статус: Фото
- cg_cult                # Статус: CG
- animatic_cult          # Статус: Аниматик
- modelling_cult         # Статус: Моделирование
- styleshots_cult        # Статус: Стайлшоты
- animation_cult         # Статус: Анимация
... и другие поля
```

**Таблица:** `projects_test` (ТЕСТОВАЯ - для отладки промптов)
```sql
Копия структуры projects
Используется командой /admin_reanalyze
НЕ влияет на продакшн!
```

#### 📋 PROJECTS_TEST (Тестовые данные)
```typescript
updateProjectTestField(id, field, value)  // Обновить поле в projects_test
getProjectTest(projectId)                 // Получить тестовый проект
ensureProjectTestExists(projectId)        // Создать копию если нет
```

#### 💬 CHATS (Чаты)
```typescript
getAllChats()                        // Все чаты
getChatByProjectId(projectId)        // Основной чат проекта (outer)
getChatsByProjectId(projectId)       // Все чаты проекта
getChatByTelegramId(telegramChatId)  // Чат по Telegram ID
getLastMessagesForProject(id, limit) // Сообщения из ВСЕХ чатов проекта
```

**Таблица:** `chats`
```sql
- chat_id (PK)
- telegram_chat_id (уникальный ID чата в Telegram)
- chat_name_tg
- project_id (FK)
- chat_type ('outer' | 'inner' | 'docs' | ...)
```

**Логика:**
- `outer` - основной чат с клиентом
- `inner` - внутренние рабочие чаты команды
- Один проект может иметь несколько чатов
- `getChatByProjectId()` предпочитает `outer` тип

#### 👥 PRODUCERS (Продюсеры)
```typescript
getProducer(telegramId)           // Продюсер по Telegram ID
getAllProducers()                 // Все продюсеры
getProducerProjects(producerId)   // Проекты продюсера
```

**Таблица:** `producers`
```sql
- producer_id (PK)
- producer_name
- producer_tg_chat_id (Telegram ID)
```

#### 👤 CLIENTS (Клиенты)
```typescript
getClient(telegramId)           // Клиент по Telegram ID
getClientProjects(clientId)     // Проекты клиента
```

**Таблица:** `clients`
```sql
- client_id (PK)
- client_name
- client_chat_id (Telegram ID)
```

#### ⚙️ SYSTEM (Системные настройки)
```typescript
getSystemSettings()               // Глобальные настройки
updateSystemFlag(flag, value)     // Обновить флаг
```

**Таблица:** `system`
```sql
- id (1)
- number_of_new_messages (лимит сообщений для анализа)
- другие настройки
```

#### 📊 CUSTOM BLOCK STATUSES (Кастомные блоки)
```typescript
upsertCustomBlockStatus(data)      // Сохранить/обновить статус
getCustomBlockStatuses(projectId)  // Получить статусы проекта
deleteCustomBlockStatus(id, blockId) // Удалить статус
```

**Таблица:** `custom_block_statuses`
```sql
- project_id (FK)
- block_id
- block_name
- block_type ('custom_pre' | 'custom_post')
- status_analysis (текст статуса)
- updated_at
PRIMARY KEY (project_id, block_id)
```

**Назначение:**
- Хранит AI-анализ кастомных блоков
- Обновляется командой `/admin_reanalyze`
- Используется при отправке статусов продюсеру

#### 🎛️ CLIENT SETTINGS (Настройки клиентов)
```typescript
getClientSettings(projectId)       // Настройки или дефолтные
getDefaultClientSettings()         // Дефолтные значения
```

**Таблица:** `client_settings`
```sql
- project_id (FK, PK)
- status_frequency_day (дни отправки: "Mon,Tue,Wed,Thu,Fri")
- status_frequency_time (время: "10:00:00+03")
- format_status ('короткий' | 'длинный')
```

**Дефолтные значения:**
```javascript
{
  status_frequency_day: 'Mon,Tue,Wed,Thu,Fri',  // Будни
  status_frequency_time: '10:00:00+03',         // 10:00 МСК
  format_status: 'длинный'
}
```

---

### `dashboard-supabase.ts`
**Клиент для БД Dashboard (Airtable-подобная система)**

#### Функции:
```typescript
getActiveBlocks(projectName)       // Получить ВСЕ блоки проекта (пре + пост)
```

**Таблицы:**
- `project_task_templates` - полный список блоков для каждого проекта
  - `project_id` - ID проекта
  - `project_name` - название проекта
  - `pre_blocks` (JSONB) - массив блоков препродакшна `[{id, name, type}]`
  - `post_blocks` (JSONB) - массив блоков постпродакшна `[{id, name, type}]`

**Структура блока:**
```typescript
{
  id: string             // Уникальный ID блока (обязательно)
  name: string           // Название блока
  type: 'standard' | 'custom_pre' | 'custom_post'  // Тип блока
}
```

**Логика:**
- `getActiveBlocks()` возвращает **все блоки** проекта (пре + пост) из одной таблицы
- Статусы блоков хранятся в Status Ninja БД, не в Dashboard
- Dashboard хранит только **шаблон** блоков (какие блоки есть у проекта)

**Standard blocks:**
- documents, storyboard, casting, location, props, wardrobe,
- editing, voice, music, color, photos, cg,
- animatic, modelling, styleshots, animation

**Custom blocks:**
- Любые кастомные блоки с `type: 'custom_pre'` или `'custom_post'`

---

## 🔄 Workflows (src/workflows/)

### `orchestrator.ts`
**Главный оркестратор** - анализ статусов по расписанию

**Основная функция:**
```typescript
async function runStatusUpdate()
```

**Что делает:**
1. Получает все чаты из БД
2. Для каждого чата:
   - Берёт непроанализированные сообщения (is_analyzed = false)
   - Получает активные блоки из Dashboard
   - Анализирует через AI Service
   - Сохраняет статусы:
     - Standard blocks → `projects` table (если не DRY_RUN)
     - Custom blocks → `custom_block_statuses` table (всегда)
   - Помечает сообщения как проанализированные
3. Форматирует обновления для продюсера
4. Возвращает мапу обновлений по проектам

**Переменные окружения:**
- `DRY_RUN=true` - не сохраняет в `projects`, но сохраняет `custom_block_statuses`

**Функции форматирования:**
```typescript
formatUpdateText(blocks, updates, format, dryRun)
categorizeStatus(status)  // 'important' | 'approved' | 'dates' | 'in_progress'
```

### `status-scheduler.ts`
**Планировщик отправки статусов** - отправляет продюсерам за 1 час до дедлайна

**Основная функция:**
```typescript
function startStatusScheduler()
```

**Работа:**
- Запускается каждый час (cron: `0 * * * *`)
- Проверяет все проекты
- Читает `client_settings` для каждого проекта
- Если текущее время = (время дедлайна - 1 час) И день совпадает:
  - Отправляет статус продюсеру

**Функция отправки:**
```typescript
async function sendStatusToProducer(project)
```

**Что делает:**
1. Читает `client_settings` (формат короткий/длинный)
2. Получает активные блоки из Dashboard
3. Читает статусы:
   - Standard blocks → из `projects` table
   - Custom blocks → из `custom_block_statuses`
4. Если кастомных блоков нет в БД:
   - Вызывает `analyzeCustomBlocksOnDemand()` (берёт 50 последних сообщений)
5. Форматирует статус через `formatStatusForClient()`
6. Отправляет через Smart Bot

**TEST_MODE:**
- Если `TEST_MODE=true` - все сообщения идут на `TEST_TELEGRAM_ID`
- Добавляет префикс с именем продюсера

**Функция on-demand анализа:**
```typescript
async function analyzeCustomBlocksOnDemand(project, customBlocks)
```
- Берёт последние 50 сообщений из всех чатов проекта
- Анализирует только кастомные блоки
- Сохраняет в `custom_block_statuses`

**Маппинг стандартных блоков:**
```typescript
getStandardFieldMapping(dashboardBlockName)
// 'documents' → 'doc'
// 'storyboard' → 'storyboard_cult'
// 'casting' → 'casting_cult'
// и т.д.
```

**Форматирование статусов:**
```typescript
formatStatusForClient(blocks, statusMap, format)
```
- Группирует по категориям:
  - ❓ Важные вопросы (important)
  - 📍 Наши процессы (in_progress)
  - ✅ Согласовано (approved)
  - ‼️ Важные даты (dates)
- Два формата: короткий и длинный

### `trigger.ts`
**Триггер для проверки** - проверяет есть ли новые сообщения

### `collect-messages.ts`
**Коллектор сообщений** - настраивает сохранение сообщений в БД

---

## 🤖 AI Service (src/services/)

### `ai-client.ts`
**Клиент для общения с AI Service (FastAPI)**

**Эндпоинты:**
```typescript
// Анализ статуса проекта (legacy)
analyzeProjectStatus(params)
// → POST http://localhost:8000/analyze/status

// Анализ конкретного этапа
analyzeStage(params)
// → POST http://localhost:8000/analyze/stage

// Анализ динамических блоков (основной)
analyzeDynamicBlocks(params)
// → POST http://localhost:8000/analyze/dynamic-blocks

// Чат с контекстом
chatWithContext(params)
// → POST http://localhost:8000/chat/context
```

---

## 🧠 AI Service (Python - ai-service/)

### `src/api.py`
**FastAPI сервер** с эндпоинтами для AI

**Эндпоинты:**
- `POST /analyze/status` - Анализ всего проекта (legacy)
- `POST /analyze/stage` - Анализ конкретного блока
- `POST /analyze/dynamic-blocks` - Анализ списка блоков (используется)
- `POST /chat/context` - Чат с контекстом пользователя

### `src/chains/analyzer.py`
**LangChain цепочки** для анализа

### `src/prompts/templates.py`
**AI промпты для анализа**

**Основной промпт:** `DEFAULT_STAGE_PROMPT`
```
Требует структуру:
Что и когда ждем от клиента/агентства: [ответ]
Что и во сколько пришлем/что делаем сейчас: [ответ]
Когда ждем обратную связь от клиента: [дата]
Важные даты: [если есть]

ПРАВИЛА:
- НЕ используй markdown
- Пиши КРАТКО (1 предложение)
- Живой язык: "ждем ОС", "в работе"
```

**Специфичные промпты:** `STAGE_PROMPTS`
- `doc` - для договоров
- `storyboard_client` - для раскадровки (клиент)
- `storyboard_cult` - для раскадровки (команда)
- `default` - для всех остальных

**Системные промпты для чата:**
- `PRODUCER_SYSTEM_PROMPT` - для продюсеров
- `CLIENT_SYSTEM_PROMPT` - для клиентов
- `UNKNOWN_SYSTEM_PROMPT` - для неизвестных

---

## 🔄 Потоки данных

### 1️⃣ Сбор сообщений (постоянно)
```
Telegram → Collect Bot → messages table
```

### 2️⃣ Анализ по расписанию (STATUS_UPDATE_CRON)
```
orchestrator.ts (cron: 8:00, 14:00, 18:00)
  ↓
  1. Читает messages (is_analyzed = false)
  2. Получает active blocks из Dashboard
  3. AI Service анализирует
  4. Сохраняет:
     - Standard blocks → projects table
     - Custom blocks → custom_block_statuses
  5. Помечает messages.is_analyzed = true
  ↓
Smart Bot отправляет обновления продюсерам (если TEST_MODE)
```

### 3️⃣ Отправка статусов (каждый час)
```
status-scheduler.ts (cron: 0 * * * *)
  ↓
  1. Проверяет client_settings всех проектов
  2. Если время совпало (дедлайн - 1 час):
     ↓
     3. Читает статусы:
        - Standard: projects table
        - Custom: custom_block_statuses
     4. Если custom блоков нет → analyzeCustomBlocksOnDemand()
     5. Форматирует (короткий/длинный)
     6. Отправляет продюсеру (или TEST_TELEGRAM_ID)
```

### 4️⃣ Команда /admin_reanalyze [ID] (ручная)
```
Smart Bot → /admin_reanalyze
  ↓
  1. Берёт последние 50 сообщений из ВСЕХ чатов проекта
  2. Получает active blocks из Dashboard
  3. AI Service анализирует с НОВЫМИ промптами
  4. Сохраняет:
     - Standard blocks → projects_test (БЕЗОПАСНО!)
     - Custom blocks → custom_block_statuses
  5. НЕ трогает projects table (n8n использует)
```

### 5️⃣ Команда /admin_send_now [ID] (ручная)
```
Smart Bot → /admin_send_now
  ↓
  Вызывает sendStatusToProducer(project)
  (читает из projects, не из projects_test)
```

---

## 📝 SQL Скрипты (sql/)

### `create_projects_test.sql`
Создаёт таблицу `projects_test` - копию структуры `projects`

```sql
CREATE TABLE IF NOT EXISTS public.projects_test (
  LIKE public.projects INCLUDING ALL
);
```

**Назначение:**
- Тестирование новых AI промптов
- Не влияет на продакшн
- Используется `/admin_reanalyze`

---

## ⚙️ Переменные окружения (.env)

```bash
# Telegram
TELEGRAM_SMART_BOT_TOKEN=xxx
TELEGRAM_COLLECT_BOT_TOKEN=xxx
TELEGRAM_GET_ID_BOT_TOKEN=xxx
TEST_TELEGRAM_ID=489599665

# Supabase (Status Ninja)
SUPABASE_URL=xxx
SUPABASE_SERVICE_KEY=xxx

# Supabase (Dashboard)
DASHBOARD_SUPABASE_URL=xxx
DASHBOARD_SUPABASE_KEY=xxx

# AI Service
AI_SERVICE_URL=http://localhost:8000

# Режимы
DRY_RUN=true          # Не сохранять в projects table
TEST_MODE=true        # Все сообщения на TEST_TELEGRAM_ID

# Расписание
STATUS_UPDATE_CRON=0 8,14,18 * * *  # Анализ в 8:00, 14:00, 18:00
```

---

## 🚀 Основные команды

### Разработка
```bash
npm run dev         # Запуск с nodemon (перезапуск при изменениях)
npm run build       # Компиляция TypeScript
npm start           # Запуск продакшн версии
```

### Python AI Service
```bash
cd ai-service
source venv/bin/activate
uvicorn src.api:app --reload
```

---

## 🔍 Отладка

### Логи
Используется Winston logger:
```typescript
import { logger } from '../utils/logger';

logger.info('Сообщение');
logger.warn('Предупреждение');
logger.error('Ошибка', error);
```

### Проверка статусов
```
/admin_projects          # Список проектов с ID
/admin_status [ID]       # Показать текущий статус
/admin_blocks [ID]       # Показать активные блоки
/admin_settings [ID]     # Показать настройки клиента
```

### Тестирование промптов
```
/admin_reanalyze [ID]    # Перезапустить анализ
                         # ✅ Безопасно - пишет в projects_test
```

---

## 📦 Зависимости

### Backend (Node.js)
- `telegraf` - Telegram Bot API
- `@supabase/supabase-js` - Supabase клиент
- `axios` - HTTP клиент для AI Service
- `node-cron` - Планировщик задач
- `winston` - Логгирование

### AI Service (Python)
- `fastapi` - API сервер
- `langchain` - AI цепочки
- `openai` - OpenAI/OpenRouter API

---

## 🎯 Безопасность данных

### ✅ Безопасно изменять:
- `projects_test` - тестовая таблица
- `custom_block_statuses` - новая таблица для кастомных блоков
- `messages.is_analyzed` - флаг обработки

### ⚠️ Осторожно:
- `projects` - используется n8n в продакшене
- `chats` - связь проектов и чатов
- `producers`, `clients` - данные пользователей

### 🔒 Только читать:
- Dashboard (`project_details`) - управляется через Dashboard UI

---

## 🔗 Связи таблиц

```
producers
  ↓ (producer_id)
projects ← (project_id) → chats
  ↓ (client_id)              ↓ (telegram_chat_id)
clients                    messages

projects
  ↓ (project_id)
custom_block_statuses

projects
  ↓ (project_id)
client_settings

projects
  ↓ (project_id)
projects_test (копия)
```

---

## 📊 Маппинг блоков → полей БД

| Dashboard Block | DB Field (projects) | Русское название |
|----------------|-------------------|-----------------|
| documents | doc | Договор |
| storyboard | storyboard_cult | Раскадровка |
| casting | casting_cult | Кастинг |
| location | location_cult | Локации |
| props | props_cult | Реквизит |
| wardrobe | clothes_cult | Одежда |
| editing | editing_cult | Монтаж |
| voice | vo_cult | Войсовер |
| music | music_cult | Музыка |
| color | colorgrading_cult | Цветокоррекция |
| photos | photos_cult | Фото |
| cg | cg_cult | CG |
| animatic | animatic_cult | Аниматик |
| modelling | modelling_cult | Моделирование |
| styleshots | styleshots_cult | Стайлшоты |
| animation | animation_cult | Анимация |

**Custom blocks** сохраняются в `custom_block_statuses` по `block_id`.

---

## 🐛 Частые проблемы

### "Чат не найден для проекта"
**Причина:** В таблице `chats` нет записей с `project_id = X`

**Решение:** Проверить в БД, что у чатов проекта заполнено поле `project_id`

### "Статусы содержат markdown и слишком длинные"
**Причина:** Старые данные из БД, созданные старыми промптами

**Решение:**
1. Обновить промпты в `ai-service/src/prompts/templates.py`
2. Запустить `/admin_reanalyze [ID]`
3. Данные сохранятся в `projects_test` (безопасно)

### "Сообщения не анализируются"
**Причина:** Все сообщения помечены `is_analyzed = true`

**Решение:**
- Либо добавить новые сообщения в чат
- Либо сбросить флаг в БД: `UPDATE messages SET is_analyzed = false WHERE ...`

---

## 📖 Дополнительная информация

### Форматы статусов

**Короткий формат:**
```
📍 Блок
Статус в работе

✅ Согласовано:
- Блок 1
- Блок 2
```

**Длинный формат:**
```
❓ Важные вопросы:
Текст вопроса

Наши процессы:

📍 Блок 1
Что делаем сейчас

📍 Блок 2
Что делаем сейчас

✅ Согласовано:
- Блок А
- Блок Б

‼️ Важные даты и этапы проекта:
Даты и дедлайны
```

### Категоризация статусов

Функция `categorizeStatus()` определяет категорию по ключевым словам:

- **Important:** "важно", "необходимо", "срочно", "требуется"
- **Approved:** "согласовано", "утверждено", "окнули", "готов"
- **Dates:** даты в тексте, "PPM", "съемка", "презентация"
- **In Progress:** всё остальное

---

*Последнее обновление: 25.12.2024*
