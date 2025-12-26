import 'dotenv/config';
import express from 'express';
import { logger } from './utils/logger';
import { startTelegramBots } from './bot/telegram';
import { startScheduler } from './workflows/trigger';
import { startStatusScheduler } from './workflows/status-scheduler';
import { setupWebhooks } from './api/webhooks';

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(express.json());

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'ninja-status-backend' });
});

// Setup webhooks
setupWebhooks(app);

// Start server
async function start() {
  try {
    logger.info('🚀 Starting Ninja Status Bot...');

    // Start Express server
    app.listen(PORT, () => {
      logger.info(`✅ Backend server running on port ${PORT}`);
    });

    // Start Telegram bots
    logger.info('📱 Launching Telegram bots...');
    await startTelegramBots();
    logger.info('✅ Telegram bots started');

    // Start scheduler for analysis
    logger.info('⏰ Starting analysis scheduler...');
    startScheduler();
    logger.info('✅ Analysis scheduler started');

    // Start status notification scheduler
    logger.info('📅 Starting status notification scheduler...');
    startStatusScheduler();
    logger.info('✅ Status notification scheduler started');

    logger.info('🎉 All services started successfully!');

  } catch (error) {
    logger.error('❌ Failed to start application:', error);
    process.exit(1);
  }
}

start();
