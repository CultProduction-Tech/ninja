import { Express } from 'express';
import { logger } from '../utils/logger';
import { checkAndTriggerUpdate } from '../workflows/trigger';

export function setupWebhooks(app: Express) {

  app.post('/webhook/update_start', async (req, res) => {
    try {
      logger.info('Webhook /update_start triggered');

      checkAndTriggerUpdate().catch(err => {
        logger.error('Error in checkAndTriggerUpdate:', err);
      });

      res.json({ status: 'triggered' });
    } catch (error) {
      logger.error('Webhook error:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  app.post('/webhook/one_more_trigger', async (req, res) => {
    try {
      logger.info('Webhook /one_more_trigger triggered - running another update cycle');

      checkAndTriggerUpdate().catch(err => {
        logger.error('Error in checkAndTriggerUpdate:', err);
      });

      res.json({ status: 'triggered' });
    } catch (error) {
      logger.error('Webhook error:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  app.post('/telegram/webhook', (req, res) => {
    logger.info('Telegram webhook received');
    res.sendStatus(200);
  });
}
