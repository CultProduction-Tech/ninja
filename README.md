# Ninja Status Bot 🥷

Автоматизированная система для мониторинга статусов проектов через Telegram.

Это полная переписка n8n workflows в код (Node.js/TypeScript + Python).

## Архитектура

```
ninja/
├── backend/         # Node.js/TypeScript - основной бэкенд
│   ├── bot/        # Telegram боты
│   ├── workflows/  # Бизнес-логика workflows
│   ├── api/        # REST API и webhooks
│   └── database/   # Supabase client
│
├── ai-service/     # Python - AI/LLM сервис
│   ├── chains/     # LangChain анализаторы (19 цепочек из n8n)
│   ├── prompts/    # AI промпты
│   └── memory/     # Память для чат-ботов
│
└── shared/         # Общие типы
```

## Возможности

### Telegram Боты
1. **Main Status Bot** - собирает сообщения из чатов
2. **Producer Agent** - AI-ассистент для продюсеров с памятью диалогов
3. **Get ID Bot** - получает Telegram ID пользователей

### Workflows
1. **Collect Messages** - сохраняет все сообщения в БД
2. **Status Update** - анализирует переписки через AI (19 этапов проекта)
3. **Scheduler** - автоматический запуск по расписанию (каждые 8 часов)

### AI Анализ
- Договор (doc)
- Раскадровка (storyboard)
- AI-генерации (aigen)
- Кастинг (casting)
- Костюмы (clothes)
- Реквизит (props)
- Локации (location)
- Аниматик (animatic)
- Моделирование (modelling)
- Стайлшоты (styleshots)
- Анимация (animation)
- Монтаж (editing)
- Музыка (music)
- Войсовер (vo)
- Цветокоррекция (colorgrading)
- Фотографии (photos)
- Компьютерная графика (cg)

Каждый этап анализируется для:
- Статуса от клиента (_client)
- Статуса от команды Cult (_cult)

## Установка

### 1. Клонируйте репозиторий

```bash
cd ninja
```

### 2. Настройте переменные окружения

```bash
cp .env.example .env
# Отредактируйте .env, добавьте свои ключи
```

### 3. Запустите через Docker

```bash
docker-compose up -d
```

Или запустите сервисы отдельно:

### Backend (Node.js)

```bash
cd backend
npm install
npm run dev
```

### AI Service (Python)

```bash
cd ai-service
python -m venv venv
source venv/bin/activate  # Windows: venv\Scripts\activate
pip install -r requirements.txt
uvicorn src.api:app --reload
```

## Конфигурация

### Переменные окружения

См. `.env.example` для полного списка.

Основные:
- `TELEGRAM_BOT_TOKEN` - токен главного бота
- `SUPABASE_URL` - URL Supabase проекта
- `SUPABASE_SERVICE_KEY` - ключ Supabase
- `OPENROUTER_API_KEY` - ключ OpenRouter для AI

### База данных (Supabase)

Необходимые таблицы:
- `messages` - сообщения из чатов
- `projects` - проекты с полями статусов
- `chats` - список чатов
- `system` - системные настройки

## API Endpoints

### Backend (порт 3000)

- `GET /health` - статус сервиса
- `POST /webhook/update_start` - запуск анализа статусов
- `POST /webhook/one_more_trigger` - повторный запуск

### AI Service (порт 8000)

- `GET /health` - статус AI сервиса
- `POST /analyze/status` - анализ всех этапов проекта
- `POST /chat` - чат с Producer Agent
- `POST /analyze/stage` - анализ конкретного этапа

## Разработка

### Backend

```bash
cd backend
npm run dev      # development с hot reload
npm run build    # production build
npm run lint     # проверка кода
```

### AI Service

```bash
cd ai-service
# Установите dev dependencies
pip install black isort pytest

# Форматирование
black src/
isort src/

# Тесты
pytest
```

## Сравнение с n8n

| n8n Workflow | Код |
|-------------|-----|
| Collect Messages to Database | `backend/src/workflows/collect-messages.ts` |
| Status Update (8240 строк!) | `backend/src/workflows/orchestrator.ts` + `ai-service/src/chains/analyzer.py` |
| Producer Agent | `backend/src/bot/producer-agent.ts` + AI memory |
| Get ID bot | `backend/src/bot/get-id-bot.ts` |
| Status Update Trigger | `backend/src/workflows/trigger.ts` |
| Set_status | `backend/src/database/supabase.ts::updateProjectField` |

## Преимущества кодовой версии

✅ Git версионирование
✅ Типобезопасность (TypeScript)
✅ Проще отладка и тестирование
✅ Лучшая производительность
✅ Полный контроль над логикой
✅ Возможность CI/CD

## Лицензия

MIT
