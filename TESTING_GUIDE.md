# 🧪 Гайд по запуску и тестированию

## Шаг 1: Создай `.env` файл

⚠️ **ВАЖНО:** Файл должен быть в **корне** проекта: `/Users/daryak/Desktop/ninja/.env`

Скопируй `.env.example` в `.env`:
```bash
cd /Users/daryak/Desktop/ninja
cp .env.example .env
```

Проверь что в `.env` есть эти поля:
```bash
# Боты
TELEGRAM_BOT_TOKEN=8297252635:AAFrrMTvTZdmdkAoAeJkNubKqTK6D-lIuMw
TELEGRAM_PRODUCER_BOT_TOKEN=8245061842:AAF1JOJWlyhwKTAF5ghetSMa7KBDrN9BtS0

# База данных
SUPABASE_URL=https://cultdatabase.space
SUPABASE_SERVICE_KEY=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJyb2xlIjoic2VydmljZV9yb2xlIiwiaXNzIjoic3VwYWJhc2UiLCJpYXQiOjE3NTM1MzU3MDgsImV4cCI6MjA2ODg5NTcwOH0.MVMN87EiLWU1eWE0rY7Yjl9t5lQ52PSo4qRss1zvW3I

# AI
OPENROUTER_API_KEY=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
OPENROUTER_MODEL=google/gemini-2.5-flash-lite

# Тестирование - уведомления только тебе!
TEST_MODE=true
TEST_TELEGRAM_ID=489599665

# ⚠️ ВАЖНО: DRY RUN для безопасного тестирования на проде!
# Анализирует сообщения, но НЕ меняет данные в БД
DRY_RUN=true
```

**Что делает DRY_RUN?**
- `DRY_RUN=true` → Анализирует сообщения, но **НЕ меняет** данные в БД (безопасно для прода!)
- `DRY_RUN=false` → Реально изменяет данные в БД (только когда выкладываешь на прод!)
```

---

## Шаг 2: Установи зависимости

### Python (AI Service)

```bash
cd /Users/daryak/Desktop/ninja/ai-service
pip install -r requirements.txt
```

Если ошибка конфликта зависимостей - это нормально, pip сам разрешит.

### Node.js (Backend)

```bash
cd /Users/daryak/Desktop/ninja/backend
npm install
```

---

## Шаг 3: Запусти сервисы

Открой **2 терминала**.

### Терминал 1: AI Service

```bash
cd /Users/daryak/Desktop/ninja/ai-service
uvicorn src.api:app --reload
```

Должно быть:
```
INFO:     Uvicorn running on http://127.0.0.1:8000
```

### Терминал 2: Backend

```bash
cd /Users/daryak/Desktop/ninja/backend
npm run dev
```

Должно быть:
```
info: Smart Bot launched
info: Silent Bot launched
info: Scheduler started with cron: 0 */8 * * *
```

---

## Шаг 4: Тестируй боты!

### ✅ Бот 1 (Silent) - Молчаливый

1. Найди бота в Telegram (токен `8297252635:AAFrrMTvTZdmdkAoAeJkNubKqTK6D-lIuMw`)
2. Добавь его в групповой чат проекта
3. Напиши что-то в чате
4. Проверь в Supabase → таблица `messages` → должна появиться запись

### ✅ Бот 2 (Smart) - Умный

1. Найди бота в Telegram (токен `8245061842:AAF1JOJWlyhwKTAF5ghetSMa7KBDrN9BtS0`)
2. Напиши `/start` → должно приветствие
3. Напиши `/status` → показать статусы проектов
4. Задай вопрос: "Какой статус проекта X?"
5. Напиши `/analyze` → запустить анализ вручную

---

## Решение проблем

### ❌ Backend: "Missing Supabase credentials"

**Причина:** Файл `.env` не найден или в неправильном месте

**Решение:**
1. Убедись что `.env` в корне: `/Users/daryak/Desktop/ninja/.env`
2. НЕ в `backend/.env`!
3. Проверь что есть `SUPABASE_URL` и `SUPABASE_SERVICE_KEY`

### ❌ AI Service: "ModuleNotFoundError: No module named 'langchain_openai'"

**Причина:** Зависимости не установились из-за конфликта

**Решение:**
```bash
cd /Users/daryak/Desktop/ninja/ai-service
pip install langchain-openai langchain-community
```

### ❌ Бот не отвечает

**Причина:** Токены неправильные или боты не запущены

**Решение:**
1. Проверь логи backend терминала - должно быть "Smart Bot launched"
2. Проверь что токены правильные в `.env`

### ❌ Уведомления идут другим продюсерам

**Причина:** `TEST_MODE` не включен

**Решение:**
Добавь в `.env`:
```bash
TEST_MODE=true
TEST_TELEGRAM_ID=489599665
```

И перезапусти backend.

---

## 📊 Как проверить что всё работает

### 1. Healthcheck

**AI Service:**
```bash
curl http://localhost:8000/health
# Должно: {"status":"healthy"}
```

**Backend:**
```bash
curl http://localhost:3000/health
# Должно: {"status":"ok"}
```

### 2. Логи

**AI Service (терминал 1):**
```
INFO:     Application startup complete
```

**Backend (терминал 2):**
```
info: Smart Bot launched
info: Silent Bot launched
info: Scheduler started
```

### 3. Тест анализа

1. Напиши боту `/analyze`
2. Должно появиться: "Запускаю анализ статусов... ⏳"
3. В логах backend:
   - "🚀 Starting status update workflow..."
   - "Found X chats to process"
   - "✅ Status update workflow completed"
4. Если TEST_MODE=true, получишь уведомление только ты

---

## ✅ Контрольный список запуска

- [ ] `.env` файл в корне проекта (`/Users/daryak/Desktop/ninja/.env`)
- [ ] Все обязательные поля заполнены (токены, Supabase, OpenRouter)
- [ ] `TEST_MODE=true` и `TEST_TELEGRAM_ID=489599665` добавлены
- [ ] `DRY_RUN=true` добавлен (безопасный режим!)
- [ ] `pip install -r requirements.txt` выполнен (ai-service)
- [ ] `npm install` выполнен (backend)
- [ ] AI Service запущен на порту 8000
- [ ] Backend запущен, логи показывают "Bot launched"
- [ ] Боты отвечают в Telegram

---

## 🧪 DRY RUN режим (безопасное тестирование на проде)

### Что это?

**DRY_RUN** - режим "сухого прогона", когда бот анализирует сообщения и показывает что изменилось бы, но **НЕ меняет** данные в БД.

### Зачем?

Ты работаешь с **реальной БД на проде**, которая используется в активной разработке. Поэтому нельзя просто так менять данные при тестировании!

### Как использовать?

1. **Добавь в `.env`:**
```bash
DRY_RUN=true
```

2. **Перезапусти backend**

3. **Запусти анализ:**
```
/analyze
```

### Что произойдет?

✅ **Бот сделает:**
- Соберёт непроанализированные сообщения из чатов
- Отправит в AI (Gemini) для анализа
- Покажет какие поля проекта изменились бы
- Отправит уведомление с префиксом `🧪 [DRY RUN - НЕ СОХРАНЕНО В БД]`

❌ **Бот НЕ сделает:**
- НЕ обновит поля проектов в БД
- НЕ пометит сообщения как `is_analyzed=true`

### Пример логов в DRY RUN:

```
info: 🧪 DRY RUN MODE: Changes will NOT be saved to database
info: 🚀 Starting status update workflow...
info: Found 3 chats to process
info: 📝 Processing chat 123 for project 456
info: Found 5 messages in chat 123
info: 🤖 Calling AI service to analyze project "Test Project"...
info: 🧪 [DRY RUN] Would update project 456:
{
  "storyboard_client": "на согласовании",
  "editing_cult": "начали работу"
}
info: 🧪 [DRY RUN] Would mark 5 messages as analyzed
info: ✅ Completed processing chat 123
```

### Пример уведомления в DRY RUN:

```
📊 Обновление статуса проекта "Test Project":

🧪 [DRY RUN - НЕ СОХРАНЕНО В БД]

• Раскадровка (клиент): на согласовании
• Монтаж (Cult): начали работу
```

### Когда отключить DRY_RUN?

Только когда **выкладываешь на прод** и готова к реальным изменениям в БД:

```bash
# В .env поменяй на:
DRY_RUN=false
```

---

Готово! Теперь можешь тестировать безопасно 🚀
