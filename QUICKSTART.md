# Quick Start Guide 🚀

Быстрый запуск Ninja Status Bot.

## 1. Подготовка

### Требования
- Node.js 20+
- Python 3.11+
- Docker & Docker Compose (опционально)
- Supabase аккаунт
- OpenRouter API ключ (или OpenAI)
- Telegram Bot токены

### Создайте Telegram ботов

1. Откройте [@BotFather](https://t.me/BotFather) в Telegram
2. Создайте 3 бота:
   - Main Status Bot: `/newbot`
   - Producer Agent Bot: `/newbot`
   - Get ID Bot: `/newbot`
3. Сохраните токены

### Настройте Supabase

1. Создайте проект на [supabase.com](https://supabase.com)
2. Создайте таблицы (SQL):

```sql
-- Messages table
CREATE TABLE messages (
  id BIGSERIAL PRIMARY KEY,
  telegram_chat_id TEXT NOT NULL,
  sender_id TEXT NOT NULL,
  message_text TEXT,
  chat_name_tg TEXT,
  is_analyzed BOOLEAN DEFAULT false,
  created_at TIMESTAMP DEFAULT NOW()
);

-- Projects table
CREATE TABLE projects (
  project_id SERIAL PRIMARY KEY,
  project_name TEXT NOT NULL,

  -- All stage fields (add all 43 fields from types)
  doc TEXT,
  storyboard_client TEXT,
  storyboard_cult TEXT,
  -- ... (добавьте все остальные поля)

  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

-- Chats table
CREATE TABLE chats (
  id SERIAL PRIMARY KEY,
  telegram_chat_id TEXT UNIQUE NOT NULL,
  project_id INTEGER REFERENCES projects(project_id),
  chat_name TEXT,
  created_at TIMESTAMP DEFAULT NOW()
);

-- System settings
CREATE TABLE system (
  id INTEGER PRIMARY KEY DEFAULT 1,
  number_of_new_messages INTEGER DEFAULT 50,
  one_more_update BOOLEAN DEFAULT false
);

INSERT INTO system (id) VALUES (1);
```

## 2. Настройка проекта

```bash
# Клонируйте/перейдите в папку
cd ninja

# Скопируйте .env
cp .env.example .env

# Отредактируйте .env - добавьте свои ключи
nano .env  # или любой редактор
```

### Минимальные настройки в .env:

```env
# Telegram
TELEGRAM_BOT_TOKEN=your_main_bot_token
TELEGRAM_PRODUCER_BOT_TOKEN=your_producer_bot_token
TELEGRAM_GET_ID_BOT_TOKEN=your_get_id_bot_token

# Supabase
SUPABASE_URL=https://xxx.supabase.co
SUPABASE_SERVICE_KEY=your_service_key

# AI
OPENROUTER_API_KEY=your_openrouter_key
```

## 3. Запуск

### Вариант A: Docker (рекомендуется)

```bash
# Запустите все сервисы
docker-compose up -d

# Проверьте логи
docker-compose logs -f

# Остановите
docker-compose down
```

### Вариант B: Локально

#### Terminal 1: Backend

```bash
cd backend
npm install
npm run dev
```

#### Terminal 2: AI Service

```bash
cd ai-service
python -m venv venv
source venv/bin/activate  # Windows: venv\Scripts\activate
pip install -r requirements.txt
uvicorn src.api:app --reload
```

## 4. Проверка

### Backend (порт 3000)

```bash
curl http://localhost:3000/health
# Ответ: {"status":"ok","service":"ninja-status-backend"}
```

### AI Service (порт 8000)

```bash
curl http://localhost:8000/health
# Ответ: {"status":"healthy"}

# Swagger UI
open http://localhost:8000/docs
```

### Telegram боты

1. Найдите своих ботов в Telegram
2. Отправьте `/start`
3. Должны получить приветственное сообщение

## 5. Добавьте бота в чат

1. Создайте группу в Telegram
2. Добавьте Main Status Bot
3. Напишите что-нибудь в чате
4. Проверьте Supabase - должна появиться запись в `messages`

## 6. Запустите анализ статусов

### Вручную через webhook:

```bash
curl -X POST http://localhost:3000/webhook/update_start
```

### Автоматически (каждые 8 часов):

Scheduler уже запущен, анализ будет идти по расписанию.

## Troubleshooting

### Backend не запускается

```bash
# Проверьте логи
cd backend
npm run dev

# Проверьте .env
cat .env | grep TELEGRAM_BOT_TOKEN
```

### AI Service ошибка

```bash
# Проверьте Python версию
python --version  # Должна быть 3.11+

# Переустановите зависимости
pip install -r requirements.txt --force-reinstall
```

### Telegram бот не отвечает

1. Проверьте токен в .env
2. Убедитесь что backend запущен
3. Проверьте логи: `docker-compose logs backend`

### База данных

```bash
# Проверьте подключение к Supabase
# В Supabase dashboard → Project Settings → API
```

## Следующие шаги

1. ✅ Запустите систему
2. 📝 Создайте тестовый проект в Supabase
3. 💬 Добавьте бота в чат проекта
4. 🤖 Протестируйте Producer Agent
5. 📊 Настройте Google Sheets интеграцию (опционально)

## Полезные команды

```bash
# Просмотр логов
docker-compose logs -f backend
docker-compose logs -f ai-service

# Перезапуск сервиса
docker-compose restart backend

# Пересборка
docker-compose up -d --build

# Очистка
docker-compose down -v
```

Готово! 🎉
