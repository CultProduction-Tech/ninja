import 'dotenv/config';
import express from 'express';
import { logger } from './utils/logger';
import { startTelegramBots } from './bot/telegram';
import { startScheduler } from './workflows/trigger';
import { startStatusScheduler } from './workflows/status-scheduler';
import { setupWebhooks } from './api/webhooks';

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'ninja-status-backend' });
});

setupWebhooks(app);

async function start() {
  try {
    logger.info('Starting Ninja Status Bot...');

    app.listen(PORT, () => {
      logger.info(`Backend server running on port ${PORT}`);
    });

    await startTelegramBots();
    logger.info('Telegram bots started');

    startScheduler();
    logger.info('Analysis scheduler started');

    startStatusScheduler();
    logger.info('Status notification scheduler started');

    logger.info('All services started successfully');

  } catch (error) {
    logger.error('Failed to start application:', error);
    process.exit(1);
  }
}

start();
