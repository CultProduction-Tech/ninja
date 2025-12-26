-- Проверка Telegram ID в базе данных
-- Этот скрипт помогает понять, какие ID записаны и в каком формате

-- 1. Проверка продюсеров
SELECT
  producer_id,
  producer_name,
  producer_tg_chat_id,
  pg_typeof(producer_tg_chat_id) as type
FROM producers
ORDER BY producer_id;

-- 2. Проверка клиентов
SELECT
  client_id,
  client_name,
  client_chat_id,
  pg_typeof(client_chat_id) as type
FROM clients
ORDER BY client_id;

-- 3. Проверка уникальных sender_id в сообщениях (последние 100)
SELECT DISTINCT
  sender_id,
  pg_typeof(sender_id) as type,
  COUNT(*) as message_count
FROM messages
GROUP BY sender_id
ORDER BY message_count DESC
LIMIT 20;

-- 4. Пример сообщений с sender_id
SELECT
  message_id,
  sender_id,
  LEFT(message_text, 50) as message_preview,
  timestamp
FROM messages
ORDER BY timestamp DESC
LIMIT 10;
