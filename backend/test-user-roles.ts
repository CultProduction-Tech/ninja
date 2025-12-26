import { SupabaseClient } from './src/database/supabase';
import { logger } from './src/utils/logger';

/**
 * Тестовый скрипт для проверки getUserRole
 * Использование: npx tsx test-user-roles.ts
 */

async function testUserRoles() {
  logger.info('🧪 Тестирование getUserRole...\n');

  // Тестовые ID из ваших данных
  const testIds = [
    '466891805', // Ольга Спортмастер (клиент #28)
    '474197497', // Татьяна Захарова (продюсер #20 И клиент #15)
    '157273532', // Не в БД - должна быть "Команда"
    '489599665', // Дарья (продюсер #32 И клиент #18)
    '5331966343', // Ekaterina Ermolaeva (продюсер #27)
  ];

  for (const senderId of testIds) {
    logger.info(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
    logger.info(`Testing sender_id: ${senderId}`);
    logger.info(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);

    try {
      const role = await SupabaseClient.getUserRole(senderId);
      logger.info(`✅ Result: "${role}"`);
    } catch (error) {
      logger.error(`❌ Error:`, error);
    }
  }

  logger.info('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  logger.info('✅ Тест завершен');
}

testUserRoles()
  .then(() => process.exit(0))
  .catch((error) => {
    logger.error('❌ Fatal error:', error);
    process.exit(1);
  });
