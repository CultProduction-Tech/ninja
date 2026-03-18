import axios from 'axios';
import { logger } from '../utils/logger';

const AI_SERVICE_URL = process.env.AI_SERVICE_URL || 'http://localhost:8000';

const DEFAULT_TIMEOUT = 120000;
const LONG_TIMEOUT = 300000;

export class AIServiceClient {
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

  static async classifyIntent(message: string, projectName: string): Promise<string> {
    try {
      const response = await axios.post(`${AI_SERVICE_URL}/classify/intent`, {
        message,
        projectName
      }, { timeout: 10000 });
      return response.data.intent;
    } catch (error) {
      logger.error('Error classifying intent:', error);
      return 'GENERAL';
    }
  }

  static async classifyDashboardStatuses(blocks: Array<{
    name: string;
    status: string;
    isDocuments: boolean;
  }>): Promise<Record<string, string>> {
    try {
      logger.info(`AI dashboard classify request (${blocks.length} blocks)`);
      const response = await axios.post(`${AI_SERVICE_URL}/classify/dashboard`, { blocks }, {
        timeout: DEFAULT_TIMEOUT
      });
      return response.data;
    } catch (error) {
      logger.error('Error classifying dashboard statuses:', error);
      return {};
    }
  }

  static async getGlossary(): Promise<{
    base: Record<string, string>;
    approved: Record<string, string>;
    pending: Record<string, string>;
    stats: {
      base_count: number;
      discovered_total: number;
      pending: number;
      approved: number;
      rejected: number;
      active_total: number;
    };
  }> {
    try {
      const response = await axios.get(`${AI_SERVICE_URL}/glossary`, {
        timeout: DEFAULT_TIMEOUT
      });
      return response.data;
    } catch (error) {
      logger.error('Error calling AI service for glossary:', error);
      throw error;
    }
  }

  static async discoverGlossaryTerms(params: {
    conversation: string;
    projectName?: string;
  }): Promise<{
    discovered: Array<{ term: string; definition: string; confidence: number }>;
    newTermsAdded: number;
  }> {
    try {
      const timeout = params.conversation.length > 10000 ? LONG_TIMEOUT : DEFAULT_TIMEOUT;
      logger.info(`AI glossary discover request (${params.conversation.length} chars, timeout: ${timeout}ms)`);

      const response = await axios.post(`${AI_SERVICE_URL}/glossary/discover`, params, {
        timeout: timeout
      });
      return response.data;
    } catch (error) {
      logger.error('Error calling AI service for glossary discovery:', error);
      throw error;
    }
  }

  static async approveGlossaryTerm(term: string): Promise<{ status: string; term: string }> {
    try {
      const response = await axios.post(`${AI_SERVICE_URL}/glossary/approve`, { term }, {
        timeout: DEFAULT_TIMEOUT
      });
      return response.data;
    } catch (error) {
      logger.error('Error calling AI service to approve glossary term:', error);
      throw error;
    }
  }

  static async editGlossaryTerm(term: string, definition: string): Promise<{ status: string; term: string; definition: string }> {
    try {
      const response = await axios.post(`${AI_SERVICE_URL}/glossary/edit`, { term, definition }, {
        timeout: DEFAULT_TIMEOUT
      });
      return response.data;
    } catch (error) {
      logger.error('Error calling AI service to edit glossary term:', error);
      throw error;
    }
  }

  static async rejectGlossaryTerm(term: string): Promise<{ status: string; term: string }> {
    try {
      const response = await axios.post(`${AI_SERVICE_URL}/glossary/reject`, { term }, {
        timeout: DEFAULT_TIMEOUT
      });
      return response.data;
    } catch (error) {
      logger.error('Error calling AI service to reject glossary term:', error);
      throw error;
    }
  }
}
