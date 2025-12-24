# Ninja Status AI Service

Python FastAPI сервис для AI анализа проектов.

## Структура

```
src/
├── chains/       # LangChain анализаторы
├── prompts/      # AI промпты для всех этапов
├── memory/       # Память для чат-ботов
└── api.py        # FastAPI приложение
```

## Запуск

```bash
# Development
uvicorn src.api:app --reload

# Production
uvicorn src.api:app --host 0.0.0.0 --port 8000
```

## Docker

```bash
docker build -t ninja-ai-service .
docker run -p 8000:8000 --env-file .env ninja-ai-service
```

## API Docs

После запуска доступна автоматическая документация:
- Swagger UI: http://localhost:8000/docs
- ReDoc: http://localhost:8000/redoc
