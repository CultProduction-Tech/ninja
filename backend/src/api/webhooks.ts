import { Express } from 'express';
import { logger } from '../utils/logger';
import { checkAndTriggerUpdate } from '../workflows/trigger';

export function setupWebhooks(app: Express) {

  // Webhook to trigger status update
  app.post('/webhook/update_start', async (req, res) => {
    try {
      logger.info('Webhook /update_start triggered');

      // Run async, don't wait
      checkAndTriggerUpdate().catch(err => {
        logger.error('Error in checkAndTriggerUpdate:', err);
      });

      res.json({ status: 'triggered' });
    } catch (error) {
      logger.error('Webhook error:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // Webhook for "one more trigger" (called after status update completes)
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

  // Telegram webhook endpoint (if using webhooks instead of polling)
  app.post('/telegram/webhook', (req, res) => {
    logger.info('Telegram webhook received');
    // Handle Telegram updates
    res.sendStatus(200);
  });
}
