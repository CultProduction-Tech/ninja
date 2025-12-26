import { SupabaseClient } from './src/database/supabase';
import { logger } from './src/utils/logger';

/**
 * Тестовый скрипт для проверки formatConversationWithRoles
 * Использование: npx tsx test-conversation-format.ts
 */

async function testConversationFormat() {
  logger.info('🧪 Тестирование formatConversationWithRoles...\n');

  // Создадим тестовые сообщения как из БД
  const testMessages = [
    {
      sender_id: '466891805', // Ольга Спортмастер (клиент)
      message_text: 'Супер да',
      timestamp: '2025-12-25T14:49:44.820291+03:00'
    },
    {
      sender_id: '157273532', // Команда (нет в БД)
      message_text: 'Денис в любой день готов',
      timestamp: '2025-12-25T14:50:00.292636+03:00'
    },
    {
      sender_id: '157273532', // Команда
      message_text: 'Осталась только Катя, ждем ее ответа)',
      timestamp: '2025-12-25T14:50:08.841035+03:00'
    },
    {
      sender_id: '466891805', // Ольга (клиент)
      message_text: 'Давайте 21-го тоже тогда',
      timestamp: '2025-12-25T14:59:53.398766+03:00'
    },
    {
      sender_id: '474197497', // Татьяна Захарова (продюсер)
      message_text: 'Всем привет💛\n\n@Markuuuuuun @nastya_grr хочу у вас взять небольшую обратную связь по Filestage🙏',
      timestamp: '2025-12-25T15:38:46.057044+03:00'
    }
  ];

  logger.info('📨 Форматируем переписку с ролями...\n');

  const formattedConversation = await SupabaseClient.formatConversationWithRoles(testMessages);

  logger.info('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  logger.info('📋 РЕЗУЛЬТАТ (как отправляется в AI):');
  logger.info('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

  console.log(formattedConversation);

  logger.info('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  logger.info('✅ Тест завершен');
}

testConversationFormat()
  .then(() => process.exit(0))
  .catch((error) => {
    logger.error('❌ Fatal error:', error);
    process.exit(1);
  });
