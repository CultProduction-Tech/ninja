# 📁 Структура проекта Ninja Status Bot

## 🎯 Главное - что где находится

```
ninja/
├── backend/              # Node.js backend (TypeScript)
├── ai-service/           # Python AI service (FastAPI)
├── .env                  # ⚠️ ВАЖНО: Твои секреты (не коммитится)
├── .env.example          # Пример .env с пояснениями
├── docker-compose.yml    # Запуск всего через Docker
└── документация...
```

---

## 📦 Backend (Node.js/TypeScript)

### Точка входа
- **`backend/src/index.ts`** - Стартует всё:
  - Запускает оба бота
  - Запускает scheduler (таймер анализа)
  - Запускает HTTP сервер

### Боты
- **`backend/src/bot/telegram.ts`** - Настройка обоих ботов
  - Бот 1 (Silent): обработчики для сбора сообщений
  - Бот 2 (Smart): импорт и инициализация

- **`backend/src/bot/smart-bot.ts`** - ⭐ ГЛАВНЫЙ БОТ (Smart Bot)
  - Все команды (`/start`, `/analyze`, `/status`)
  - Чат с пользователями (текст, голос в будущем)
  - Определение типа юзера (producer/client)
  - Отправка уведомлений продюсерам
  - **TEST_MODE** - фильтрация уведомлений только для тебя

### Workflows (бизнес-логика)
- **`backend/src/workflows/orchestrator.ts`** - Анализ статусов
  - Главная функция: `runStatusUpdate()`
  - Получает чаты → сообщения → вызывает AI → обновляет БД
  - Возвращает updates для уведомлений

- **`backend/src/workflows/trigger.ts`** - Scheduler
  - Запускает `runStatusUpdate()` по расписанию (cron)
  - После анализа отправляет уведомления через Smart Bot

- **`backend/src/workflows/collect-messages.ts`** - Сбор сообщений
  - Обработчики для Silent Bot
  - Сохранение сообщений в Supabase

### База данных
- **`backend/src/database/supabase.ts`** - ВСЕ запросы к БД
  - Messages: `saveMessage()`, `getUnanalyzedMessages()`, `markMessagesAsAnalyzed()`
  - Projects: `getProject()`, `updateProjectFields()`
  - Chats: `getAllChats()`, `getChatByTelegramId()`
  - Producers: `getProducer()`, `getProducerProjects()`
  - Clients: `getClient()`, `getClientProjects()`
  - System: `getSystemSettings()`, `updateSystemFlag()`

### Сервисы
- **`backend/src/services/ai-client.ts`** - HTTP клиент для AI service
  - `analyzeProjectStatus()` - анализ 43 полей проекта
  - `chatWithContext()` - чат с контекстом пользователя

### API
- **`backend/src/api/routes.ts`** - HTTP endpoints
  - `GET /health` - проверка работоспособности
  - `POST /webhook/update_start` - ручной запуск анализа (опционально)

### Утилиты
- **`backend/src/utils/logger.ts`** - Логирование (winston)
- **`backend/src/utils/env-validator.ts`** - Проверка .env переменных

### Конфигурация
- **`backend/package.json`** - Зависимости Node.js
  - telegraf (Telegram боты)
  - @supabase/supabase-js (БД)
  - express (HTTP сервер)
  - node-cron (scheduler)
  - axios (HTTP клиент)

- **`backend/tsconfig.json`** - Настройки TypeScript

---

## 🤖 AI Service (Python/FastAPI)

### Точка входа
- **`ai-service/src/api.py`** - FastAPI приложение
  - `POST /analyze/status` - Анализ всех 43 полей проекта
  - `POST /chat/context` - Чат с контекстом пользователя
  - `GET /health` - Healthcheck

### AI логика
- **`ai-service/src/chains/analyzer.py`** - LangChain цепочки
  - `analyze_project_status()` - LLM анализирует разговор + обновляет поля
  - `chat_with_context()` - Чат с разными промптами для producer/client
  - Использует LangChain + OpenRouter (Gemini)

### Промпты
- **`ai-service/src/prompts/templates.py`** - 3 системных промпта:
  - `PRODUCER_SYSTEM_PROMPT` - Для продюсеров (деловой стиль)
  - `CLIENT_SYSTEM_PROMPT` - Для клиентов (вежливый стиль)
  - `UNKNOWN_SYSTEM_PROMPT` - Для неопознанных юзеров
  - `PROJECT_ANALYSIS_PROMPT` - Для анализа 43 полей

### Модели данных
- **`ai-service/src/models/schemas.py`** - Pydantic схемы:
  - `AnalyzeStatusRequest` - Запрос на анализ
  - `ChatRequest` - Запрос на чат
  - `ChatResponse` - Ответ от чата

### Конфигурация
- **`ai-service/requirements.txt`** - Зависимости Python
  - fastapi, uvicorn (веб-сервер)
  - langchain, langchain-openai (AI)
  - openai (LLM клиент)
  - supabase (БД, для истории чата)

---

## 🗄️ База данных (Supabase)

Таблицы используются из существующей n8n базы:

### `messages`
- `message_id` - ID сообщения
- `telegram_chat_id` - ID чата телеграм
- `sender_id` - ID отправителя
- `message_text` - Текст
- `is_analyzed` - Проанализировано? (false → true)

### `projects`
- `project_id` - ID проекта
- `project_name` - Название
- `producer_id`, `producer2`, `producer3` - Продюсеры
- `client_id`, `client2`, `client3` - Клиенты
- **43 поля статусов:**
  - `doc`, `act` (документы)
  - `storyboard_client`, `storyboard_cult` (раскадровка)
  - `aigen_client`, `aigen_cult` (AI-генерации)
  - `casting_client`, `casting_cult` (кастинг)
  - ...и т.д. для всех 19 стадий × 2 варианта (client/cult)

### `chats`
- `telegram_chat_id` - ID чата
- `project_id` - Связь с проектом

### `producers`
- `producer_id` - ID продюсера
- `producer_name` - Имя
- `producer_tg_chat_id` - Telegram ID продюсера

### `clients`
- `client_id` - ID клиента
- `client_name` - Имя
- `client_chat_id` - Telegram ID клиента

### `system`
- `number_of_new_messages` - Лимит сообщений
- `one_more_update` - Флаг повторного запуска

---

## 🔧 Конфигурационные файлы

### `.env`
**⚠️ ВАЖНО:** Этот файл должен быть в **корне проекта** `/Users/daryak/Desktop/ninja/.env`

Не в `backend/.env` и не в `ai-service/.env`, а именно в корне!

Обязательные поля:
```bash
TELEGRAM_BOT_TOKEN=...                # Бот 1 (Silent)
TELEGRAM_PRODUCER_BOT_TOKEN=...       # Бот 2 (Smart)
SUPABASE_URL=...
SUPABASE_SERVICE_KEY=...              # Service role key!
OPENROUTER_API_KEY=...
```

Для тестирования добавь:
```bash
TEST_MODE=true
TEST_TELEGRAM_ID=489599665
```

Подробнее смотри `.env.example`

### `docker-compose.yml`
Запускает 3 сервиса:
- `backend` - Node.js (порт 3000)
- `ai-service` - Python (порт 8000)
- `redis` - Кэш (порт 6379, опционально)

---

## 📚 Документация

- **`README.md`** - Общее описание проекта
- **`ARCHITECTURE_UPDATED.md`** - Архитектура (2 бота, workflow)
- **`UPDATED_SUMMARY.txt`** - Что изменилось vs n8n
- **`QUICKSTART.md`** - Быстрый старт
- **`PROJECT_STRUCTURE.md`** - ⭐ ЭТОТ ФАЙЛ

---

## 🔄 Как работает анализ (упрощенно)

```
1. Silent Bot собирает сообщения из чатов
   ↓ сохраняет в messages (is_analyzed=false)

2. Каждые 8 часов (или /analyze):
   ↓ orchestrator.ts

3. Для каждого чата:
   - Берет непроанализированные сообщения
   - Собирает в разговор: "[user1]: текст\n[user2]: текст"
   ↓ отправляет в AI service

4. AI Service (analyzer.py):
   - Получает разговор + текущие статусы
   - LLM анализирует и обновляет 43 поля
   ↓ возвращает обновленные статусы

5. Backend (orchestrator.ts):
   - Сохраняет новые статусы в projects
   - Помечает сообщения как is_analyzed=true
   ↓ возвращает updates

6. Smart Bot (smart-bot.ts):
   - Отправляет уведомления продюсерам
   - В TEST_MODE отправляет только тебе (489599665)
```

---

## 🧪 Что тестировать

### Бот 1 (Silent)
- Добавь в групповой чат проекта
- Напиши сообщение
- Проверь Supabase → `messages` (должна появиться запись)

### Бот 2 (Smart)
- Напиши боту `/start` от продюсера → приветствие для продюсера
- Напиши боту `/start` от клиента → приветствие для клиента
- Напиши вопрос: "Какой статус проекта X?" → поиск и ответ
- Команда `/analyze` → запуск анализа вручную
- Команда `/status` → показать статусы твоих проектов

---

## ❓ FAQ

**Q: Где должен быть .env файл?**
A: В корне проекта: `/Users/daryak/Desktop/ninja/.env`

**Q: Нужны ли WEBHOOK_BASE_URL и WEBHOOK_SECRET?**
A: НЕТ для локального тестирования. Они нужны только если хочешь вызывать анализ через HTTP API с внешнего сервера.

**Q: Как отключить уведомления другим продюсерам?**
A: Добавь в .env:
```
TEST_MODE=true
TEST_TELEGRAM_ID=489599665
```

**Q: Как изменить расписание анализа?**
A: Измени `STATUS_UPDATE_CRON` в .env (формат cron)

**Q: Почему backend не запускается?**
A: Проверь что .env файл в корне проекта и содержит SUPABASE_URL и SUPABASE_SERVICE_KEY

**Q: Как посмотреть логи?**
A: Backend и AI service выводят логи в консоль. При запуске через Docker: `docker-compose logs -f`

---

Готово! Теперь ты знаешь где что лежит 🎉
