import axios from 'axios';
import { logger } from '../utils/logger';

const AI_SERVICE_URL = process.env.AI_SERVICE_URL || 'http://localhost:8000';

export class AIServiceClient {
  /**
   * Analyze project status from conversation
   */
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

  /**
   * Chat with Smart Bot with user context
   * Учитывает тип пользователя (продюсер/клиент) и его проекты
   */
  static async chatWithContext(params: {
    userId: string;
    message: string;
    userType: 'producer' | 'client' | 'unknown';
    projects: any[];
  }) {
    try {
      const response = await axios.post(`${AI_SERVICE_URL}/chat/context`, params);
      return response.data;
    } catch (error) {
      logger.error('Error calling AI service for chat:', error);
      throw error;
    }
  }

  /**
   * Simple chat (legacy, for backward compatibility)
   */
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

  /**
   * Analyze specific stage (e.g., storyboard, casting, etc.)
   */
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
}
