# Ninja Status Bot

Автоматическая система мониторинга статусов производственных проектов через Telegram. Боты анализируют переписку в рабочих чатах, обновляют статусы по этапам проекта и отправляют сводки продюсерам и клиентам.

---

## Архитектура

```
┌────────────────────────────────────────────────────┐
│               TELEGRAM ЧАТЫ ПРОЕКТОВ               │
│           (inner — команда, outer — клиент)         │
└─────────────────────┬──────────────────────────────┘
                      │
           ┌──────────▼──────────┐
           │     Silent Bot      │
           │   (telegram.ts)     │
           │  слушает все чаты,  │
           │  пишет сообщения    │
           │      в БД           │
           └──────────┬──────────┘
                      │
┌─────────────────────▼──────────────────────────────┐
│              STATUS NINJA DB (Supabase)             │
│  projects / chats / messages / producers / clients  │
└──────┬─────────────────────────────────────────────┘
       │
       │  по расписанию (cron) или вручную (/analyze)
       │
┌──────▼──────────────┐    ┌────────────────────────┐
│   orchestrator.ts   │◄──►│   DASHBOARD DB         │
│  читает сообщения,  │    │   (Supabase)            │
│  вызывает AI,       │    │  custom_tasks_pre/post  │
│  сохраняет статусы  │    └────────────────────────┘
└──────┬──────────────┘
       │ HTTP
       │
┌──────▼──────────────────────────────────────────────┐
│              AI SERVICE (Python / FastAPI)           │
│                                                      │
│  LangChain + Google Gemini (via OpenRouter)          │
│                                                      │
│  /analyze/status         — стандартные этапы         │
│  /analyze/dynamic-blocks — кастомные блоки           │
│  /analyze/stage          — один этап                 │
│  /answer/question        — вопрос по переписке       │
│  /chat/context           — диалог с AI               │
└──────┬──────────────────────────────────────────────┘
       │
       │  обновляет projects / custom_block_statuses
       │
┌──────▼──────────────┐
│     Smart Bot       │
│   (smart-bot.ts)    │
│  отправляет статусы │
│  продюсерам и       │
│  клиентам, чат с AI │
└─────────────────────┘
```

---

## Структура файлов

```
ninja/
├── backend/                           Node.js TypeScript сервер
│   └── src/
│       ├── index.ts                   Точка входа: запуск ботов, сервера, планировщика
│       ├── bot/
│       │   ├── telegram.ts            Silent Bot — слушает чаты, сохраняет сообщения в БД
│       │   ├── smart-bot.ts           Smart Bot — интерфейс продюсера (/analyze, чат с AI)
│       │   └── get-id-bot.ts          Вспомогательный бот для получения Telegram ID чата
│       ├── workflows/
│       │   ├── orchestrator.ts        Главный оркестратор: сообщения → AI → сохранение статусов
│       │   ├── collect-messages.ts    Сбор и форматирование переписки из чатов проекта
│       │   ├── status-scheduler.ts    Планировщик отправки статусов клиентам (cron)
│       │   └── trigger.ts             Запуск анализа через webhook
│       ├── database/
│       │   ├── supabase.ts            Клиент Status Ninja DB: проекты, сообщения, чаты, роли
│       │   └── dashboard-supabase.ts  Клиент Dashboard DB: кастомные блоки проекта
│       ├── services/
│       │   └── ai-client.ts           HTTP клиент для обращений к AI сервису
│       ├── api/
│       │   └── webhooks.ts            Express роуты для внешних вызовов
│       └── utils/
│           └── logger.ts              Winston логгер
│
├── ai-service/                        Python FastAPI сервис
│   └── src/
│       ├── api.py                     FastAPI роуты и Pydantic модели запросов/ответов
│       ├── config.py                  Настройки через pydantic-settings (читает .env)
│       ├── chains/
│       │   └── analyzer.py            LangChain цепочки анализа статусов и чата
│       ├── prompts/
│       │   └── templates.py           Промпты для AI (этапы проекта, системные промпты)
│       └── memory/
│           └── conversation.py        In-memory история диалогов (по userId)
│
├── .env.example                       Пример переменных окружения
└── README.md
```

---

## Как это работает

### 1. Сбор сообщений

Silent Bot добавляется в рабочие Telegram чаты проектов. Он молча фиксирует каждое сообщение и сохраняет его в таблицу `messages` со ссылкой на `telegram_chat_id`.

Каждый чат привязан к проекту через таблицу `chats`. У проекта может быть несколько чатов — внутренний (inner) с командой и внешний (outer) с клиентом. Для анализа берутся сообщения из всех чатов проекта.

### 2. Анализ статусов

Анализ запускается двумя способами:
- **По расписанию**: `status-scheduler.ts` через `node-cron` (настраивается через `STATUS_UPDATE_CRON`)
- **Вручную**: команда `/analyze` в Smart Bot

`orchestrator.ts` для каждого проекта:
1. Загружает последние сообщения из всех чатов
2. Определяет роль каждого отправителя — продюсер, клиент или команда — через `getUserRole()`
3. Форматирует переписку: `[Продюсер Иван]: текст`
4. Получает список кастомных блоков из Dashboard DB
5. Отправляет запросы в AI сервис: `/analyze/status` для стандартных полей и `/analyze/dynamic-blocks` для кастомных блоков
6. Сохраняет результаты в `projects` и `custom_block_statuses`

### 3. AI анализ

AI сервис использует LangChain с Google Gemini (`google/gemini-2.5-flash-lite` через OpenRouter).

Для каждого этапа проекта формируется промпт с текущим статусом и перепиской. AI пишет краткое описание (1-3 предложения) в живом разговорном стиле — без markdown, без заголовков, с конкретикой (что ждём, от кого, когда).

Все этапы анализируются параллельно через `asyncio.gather()`.

### 4. Отправка статусов

`status-scheduler.ts` по расписанию из `client_settings` каждого проекта отправляет сводки:
- Клиенту — видимые для него блоки, в коротком или длинном формате
- Продюсеру-администратору — полная сводка по всем блокам

### 5. Диалог с AI

Smart Bot принимает вопросы от продюсеров в свободной форме. Запрос уходит на `/chat/context` или `/answer/question` с контекстом проектов и переписки. AI отвечает на основе реальных данных из чатов.

---

## Типы блоков

### Стандартные блоки

Фиксированные поля в таблице `projects`:

| Поле | Название |
|------|----------|
| `doc` | Договор |
| `storyboard_client` / `storyboard_cult` | Сторибоард |
| `aigen_client` / `aigen_cult` | AI-генерация |
| `casting_client` / `casting_cult` | Кастинг |
| `clothes_client` / `clothes_cult` | Одежда |
| `props_client` / `props_cult` | Реквизит |
| `location_client` / `location_cult` | Локация |
| `animatic_client` / `animatic_cult` | Аниматик |
| `modelling_client` / `modelling_cult` | Моделлинг |
| `styleshots_client` / `styleshots_cult` | Стайлшоты |
| `animation_client` / `animation_cult` | Анимация |
| `editing_client` / `editing_cult` | Монтаж |
| `music_client` / `music_cult` | Музыка |
| `vo_client` / `vo_cult` | Озвучка |
| `colorgrading_client` / `colorgrading_cult` | Цветокоррекция |
| `photos_client` / `photos_cult` | Фото |
| `cg_client` / `cg_cult` | CG |

Суффикс `_client` — статус согласования с клиентом, `_cult` — внутренний статус команды.

### Кастомные блоки

Дополнительные задачи из Dashboard DB (`custom_tasks_pre`, `custom_tasks_post`). Результаты анализа хранятся в таблице `custom_block_statuses` со ссылкой на `project_id` и `block_id`.

---

## Переменные окружения

### Обязательные

| Переменная | Описание |
|------------|----------|
| `TELEGRAM_BOT_TOKEN` | Токен Silent Bot (Бот 1, собирает сообщения) |
| `TELEGRAM_PRODUCER_BOT_TOKEN` | Токен Smart Bot (Бот 2, продюсерский интерфейс) |
| `SUPABASE_URL` | URL Status Ninja DB |
| `SUPABASE_SERVICE_KEY` | Service Key Status Ninja DB (не anon) |
| `DASHBOARD_SUPABASE_URL` | URL Dashboard DB |
| `DASHBOARD_SUPABASE_KEY` | Service Key Dashboard DB |
| `OPENROUTER_API_KEY` | Ключ OpenRouter |

### Опциональные

| Переменная | По умолчанию | Описание |
|------------|--------------|----------|
| `OPENROUTER_MODEL` | `google/gemini-2.5-flash-lite` | Модель LLM |
| `PORT` | `3000` | Порт backend |
| `AI_SERVICE_URL` | `http://localhost:8000` | URL AI сервиса |
| `STATUS_UPDATE_CRON` | `0 */8 * * *` | Расписание автоанализа (каждые 8 часов) |
| `TEST_MODE` | `false` | Уведомления только на `TEST_TELEGRAM_ID` |
| `TEST_TELEGRAM_ID` | — | Telegram ID для тестового режима |
| `DRY_RUN` | `false` | Анализ без записи в БД |
| `LOG_LEVEL` | `info` | Уровень логов |

---

## Установка и запуск

### Backend (Node.js)

```bash
cd backend
npm install
cp ../.env.example .env
# заполни .env нужными значениями
npm run dev
```

Для продакшена:
```bash
npm run build
npm start
```

### AI сервис (Python)

```bash
cd ai-service
python -m venv venv
source venv/bin/activate
pip install -r requirements.txt
cp ../.env.example .env
uvicorn src.api:app --host 0.0.0.0 --port 8000
```

Или через Docker:
```bash
cd ai-service
docker build -t ninja-ai .
docker run -p 8000:8000 --env-file ../.env ninja-ai
```

### Порядок запуска

1. Запустить AI сервис (порт 8000)
2. Запустить Backend (порт 3000)

Оба Telegram бота поднимаются автоматически из `index.ts`.

---

## Команды Smart Bot

| Команда | Описание |
|---------|----------|
| `/start` | Приветствие и список команд |
| `/analyze` | Запустить анализ всех проектов прямо сейчас |
| `/projects` | Список проектов продюсера |

Продюсер может писать в свободной форме — бот передаёт вопрос в AI с контекстом проектов.

---

## База данных (Status Ninja DB)

| Таблица | Описание |
|---------|----------|
| `projects` | Проекты со статусами по всем этапам |
| `chats` | Telegram чаты привязанные к проектам |
| `messages` | Сообщения из чатов |
| `producers` | Продюсеры (telegram_chat_id) |
| `clients` | Клиенты (client_chat_id) |
| `client_settings` | Настройки частоты и формата статусов для каждого клиента |
| `custom_block_statuses` | Результаты анализа кастомных блоков |
| `system` | Системные флаги (test_mode и др.) |

---

## API

### Backend (порт 3000)

| Метод | Путь | Описание |
|-------|------|----------|
| `GET` | `/health` | Статус сервиса |
| `POST` | `/webhook/update_start` | Запуск анализа статусов |
| `POST` | `/webhook/one_more_trigger` | Повторный запуск |

### AI сервис (порт 8000)

| Метод | Путь | Описание |
|-------|------|----------|
| `GET` | `/health` | Статус AI сервиса |
| `POST` | `/analyze/status` | Анализ всех стандартных этапов проекта |
| `POST` | `/analyze/dynamic-blocks` | Анализ кастомных блоков |
| `POST` | `/analyze/stage` | Анализ одного этапа |
| `POST` | `/answer/question` | Ответ на вопрос по переписке |
| `POST` | `/chat/context` | Диалог с AI (с контекстом проектов) |
