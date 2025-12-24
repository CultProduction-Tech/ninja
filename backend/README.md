# Ninja Status Backend

Node.js/TypeScript backend сервис.

## Структура

```
src/
├── bot/          # Telegram боты
├── workflows/    # Бизнес-логика
├── api/          # REST API и webhooks
├── database/     # Supabase клиент
├── services/     # Внешние сервисы (AI)
└── utils/        # Утилиты
```

## Запуск

```bash
# Development
npm run dev

# Production
npm run build
npm start
```

## Тесты

```bash
npm test
```
