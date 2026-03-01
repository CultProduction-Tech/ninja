import axios from 'axios';
import { logger } from '../utils/logger';

const AI_SERVICE_URL = process.env.AI_SERVICE_URL || 'http://localhost:8000';

const DEFAULT_TIMEOUT = 120000;
const LONG_TIMEOUT = 300000;

export class AIServiceClient {
  static async analyzeProjectStatus(params: {
    projectId: number;
    projectName: string;
    currentStatus: any;
    conversation: string;
  }) {
    try {
      const response = await axios.post(`${AI_SERVICE_URL}/analyze/status`, params);
      return response.data;
    } catch (error) {
      logger.error('Error calling AI service for status analysis:', error);
      throw error;
    }
  }

  static async chatWithContext(params: {
    userId: string;
    message: string;
    userType: 'producer' | 'client' | 'unknown';
    projects: any[];
  }) {
    try {
      const timeout = params.message.length > 10000 ? LONG_TIMEOUT : DEFAULT_TIMEOUT;
      logger.info(`AI chat request (${params.message.length} chars, timeout: ${timeout}ms)`);

      const response = await axios.post(`${AI_SERVICE_URL}/chat/context`, params, {
        timeout: timeout
      });
      return response.data;
    } catch (error) {
      logger.error('Error calling AI service for chat:', error);
      throw error;
    }
  }

  static async chat(params: {
    userId: string;
    message: string;
  }) {
    try {
      const response = await axios.post(`${AI_SERVICE_URL}/chat`, params);
      return response.data;
    } catch (error) {
      logger.error('Error calling AI service for chat:', error);
      throw error;
    }
  }

  static async analyzeStage(params: {
    stage: string;
    conversation: string;
    currentValue?: string;
  }) {
    try {
      const response = await axios.post(`${AI_SERVICE_URL}/analyze/stage`, params);
      return response.data;
    } catch (error) {
      logger.error(`Error analyzing stage ${params.stage}:`, error);
      throw error;
    }
  }

  static async analyzeDynamicBlocks(params: {
    projectId: number;
    projectName: string;
    blocks: Array<{
      name: string;
      type: 'standard' | 'custom_pre' | 'custom_post';
      id?: string;
      currentStatus?: string;
    }>;
    conversation: string;
  }) {
    try {
      const timeout = params.conversation.length > 10000 ? LONG_TIMEOUT : DEFAULT_TIMEOUT;
      logger.info(`AI analyze blocks request (${params.blocks.length} blocks, ${params.conversation.length} chars, timeout: ${timeout}ms)`);

      const response = await axios.post(`${AI_SERVICE_URL}/analyze/dynamic-blocks`, params, {
        timeout: timeout
      });
      return response.data;
    } catch (error) {
      logger.error('Error calling AI service for dynamic blocks analysis:', error);
      throw error;
    }
  }

  static async answerQuestion(params: {
    projectName: string;
    question: string;
    conversation: string;
    messageCount: number;
  }): Promise<{ answer: string; needsMore: boolean }> {
    try {
      const timeout = params.conversation.length > 10000 ? LONG_TIMEOUT : DEFAULT_TIMEOUT;
      logger.info(`AI question request (${params.messageCount} messages, ${params.conversation.length} chars, timeout: ${timeout}ms)`);

      const response = await axios.post(`${AI_SERVICE_URL}/answer/question`, params, {
        timeout: timeout
      });
      return response.data;
    } catch (error) {
      logger.error('Error calling AI service for question answering:', error);
      throw error;
    }
  }
}
