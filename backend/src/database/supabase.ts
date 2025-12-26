import { createClient } from '@supabase/supabase-js';
import { logger } from '../utils/logger';

const supabaseUrl = process.env.SUPABASE_URL!;
const supabaseKey = process.env.SUPABASE_SERVICE_KEY!;

if (!supabaseUrl || !supabaseKey) {
  logger.error('Missing Supabase credentials in environment variables');
  throw new Error('Missing Supabase credentials');
}

export const supabase = createClient(supabaseUrl, supabaseKey);

export class SupabaseClient {
  static supabase = supabase;

  // ============================================
  // MESSAGES
  // ============================================

  static async saveMessage(data: {
    telegram_chat_id: string;
    sender_id: string;
    message_text: string;
    chat_name_tg: string;
    is_analyzed: boolean;
  }) {
    const { data: result, error } = await supabase
      .from('messages')
      .insert([data]);

    if (error) throw error;
    return result;
  }

  static async getUnanalyzedMessages(chatId: string, limit: number = 50) {
    const { data, error } = await supabase
      .from('messages')
      .select('*')
      .eq('telegram_chat_id', chatId)
      .eq('is_analyzed', false)
      .order('timestamp', { ascending: true })
      .limit(limit);

    if (error) throw error;
    return data || [];
  }

  /**
   * Get last N messages from chat (regardless of is_analyzed status)
   */
  static async getLastMessages(chatId: string, limit: number = 50) {
    const { data, error } = await supabase
      .from('messages')
      .select('*')
      .eq('telegram_chat_id', chatId)
      .order('timestamp', { ascending: false })
      .limit(limit);

    if (error) throw error;
    // Reverse to get chronological order
    return data ? data.reverse() : [];
  }

  /**
   * Get primary chat for project (prefers 'outer' type, falls back to first chat)
   */
  static async getChatByProjectId(projectId: number) {
    const { data, error } = await supabase
      .from('chats')
      .select('*')
      .eq('project_id', projectId);

    if (error && error.code !== 'PGRST116') {
      logger.error(`Error getting chats for project ${projectId}:`, error);
      return null;
    }

    if (!data || data.length === 0) {
      logger.warn(`No chats found for project ${projectId}`);
      return null;
    }

    // Prefer 'outer' chat type (main chat with client)
    const outerChat = data.find(chat => chat.chat_type === 'outer');
    if (outerChat) {
      logger.info(`Found outer chat for project ${projectId}: ${outerChat.chat_name_tg}`);
      return outerChat;
    }

    // Otherwise return first available chat
    logger.info(`No outer chat found for project ${projectId}, using first chat: ${data[0].chat_name_tg}`);
    return data[0];
  }

  /**
   * Get all chats for project
   */
  static async getChatsByProjectId(projectId: number) {
    const { data, error } = await supabase
      .from('chats')
      .select('*')
      .eq('project_id', projectId);

    if (error) throw error;
    return data || [];
  }

  /**
   * Get messages from all chats of a project (combines messages from all chat types)
   */
  static async getLastMessagesForProject(projectId: number, limit: number = 50) {
    // Get all chats for this project
    const chats = await this.getChatsByProjectId(projectId);

    if (chats.length === 0) {
      logger.warn(`No chats found for project ${projectId}`);
      return [];
    }

    logger.info(`Found ${chats.length} chats for project ${projectId}`);

    // Get chat IDs
    const chatIds = chats.map(chat => chat.telegram_chat_id);

    // Get messages from all these chats
    const { data, error } = await supabase
      .from('messages')
      .select('*')
      .in('telegram_chat_id', chatIds)
      .order('timestamp', { ascending: false })
      .limit(limit);

    if (error) throw error;

    logger.info(`Retrieved ${data?.length || 0} messages from ${chats.length} chats for project ${projectId}`);

    // Return in chronological order (oldest first)
    return data ? data.reverse() : [];
  }

  static async markMessagesAsAnalyzed(messageIds: number[]) {
    const { data, error } = await supabase
      .from('messages')
      .update({ is_analyzed: true })
      .in('message_id', messageIds);

    if (error) throw error;
    return data;
  }

  // ============================================
  // PROJECTS
  // ============================================

  static async getProject(projectId: number) {
    const { data, error } = await supabase
      .from('projects')
      .select(`
        *,
        producer:producers!projects_producer_id_fkey(producer_id, producer_name, producer_tg_chat_id),
        client:clients!projects_client_id_fkey(client_id, client_name, client_chat_id)
      `)
      .eq('project_id', projectId)
      .single();

    if (error) throw error;
    return data;
  }

  static async updateProjectField(
    projectId: number,
    fieldName: string,
    newValue: string
  ) {
    const { data, error } = await supabase
      .from('projects')
      .update({ [fieldName]: newValue })
      .eq('project_id', projectId);

    if (error) throw error;
    return data;
  }

  /**
   * Update field in projects_test table (for testing new prompts)
   */
  static async updateProjectTestField(
    projectId: number,
    fieldName: string,
    newValue: string
  ) {
    const { data, error } = await supabase
      .from('projects_test')
      .update({ [fieldName]: newValue })
      .eq('project_id', projectId);

    if (error) throw error;
    return data;
  }

  /**
   * Get project from projects_test table
   */
  static async getProjectTest(projectId: number) {
    const { data, error } = await supabase
      .from('projects_test')
      .select(`
        *,
        producer:producer_id (*),
        producer2:producer2 (*)
      `)
      .eq('project_id', projectId)
      .single();

    if (error) throw error;
    return data;
  }

  /**
   * Upsert project in projects_test (copy from projects if not exists)
   */
  static async ensureProjectTestExists(projectId: number) {
    // Check if exists in projects_test
    const { data: existing } = await supabase
      .from('projects_test')
      .select('project_id')
      .eq('project_id', projectId)
      .single();

    if (!existing) {
      // Copy from projects
      const project = await this.getProject(projectId);
      if (project) {
        const { error } = await supabase
          .from('projects_test')
          .insert(project);

        if (error) {
          logger.error(`Error creating project_test ${projectId}:`, error);
          throw error;
        }
        logger.info(`✅ Created project_test for project ${projectId}`);
      }
    }
  }

  static async updateProjectFields(
    projectId: number,
    fields: Record<string, any>
  ) {
    const { data, error } = await supabase
      .from('projects')
      .update(fields)
      .eq('project_id', projectId);

    if (error) throw error;
    return data;
  }

  // ============================================
  // CHATS
  // ============================================

  static async getAllChats() {
    const { data, error } = await supabase
      .from('chats')
      .select('*');

    if (error) throw error;
    return data || [];
  }

  static async getChatByTelegramId(telegramChatId: string) {
    const { data, error } = await supabase
      .from('chats')
      .select('*')
      .eq('telegram_chat_id', telegramChatId)
      .single();

    if (error && error.code !== 'PGRST116') throw error;
    return data;
  }

  // ============================================
  // PRODUCERS
  // ============================================

  static async getProducer(telegramId: string) {
    logger.debug(`📞 getProducer: searching for telegram_id=${telegramId}`);

    const { data, error } = await supabase
      .from('producers')
      .select('*')
      .eq('producer_tg_chat_id', telegramId)
      .single();

    if (error && error.code !== 'PGRST116') {
      logger.error(`❌ getProducer error for ${telegramId}:`, error);
      throw error;
    }

    if (data) {
      logger.debug(`✓ Found producer: ${data.producer_name}`);
    } else {
      logger.debug(`✗ No producer found for ${telegramId}`);
    }

    return data;
  }

  static async getAllProducers() {
    const { data, error } = await supabase
      .from('producers')
      .select('*');

    if (error) throw error;
    return data || [];
  }

  static async getProducerProjects(producerId: number) {
    const { data, error } = await supabase
      .from('projects')
      .select('*')
      .or(`producer_id.eq.${producerId},producer2.eq.${producerId},producer3.eq.${producerId}`);

    if (error) throw error;
    return data || [];
  }

  // ============================================
  // CLIENTS
  // ============================================

  static async getClient(telegramId: string) {
    logger.debug(`📞 getClient: searching for telegram_id=${telegramId}`);

    const { data, error } = await supabase
      .from('clients')
      .select('*')
      .eq('client_chat_id', telegramId)
      .single();

    if (error && error.code !== 'PGRST116') {
      logger.error(`❌ getClient error for ${telegramId}:`, error);
      throw error;
    }

    if (data) {
      logger.debug(`✓ Found client: ${data.client_name}`);
    } else {
      logger.debug(`✗ No client found for ${telegramId}`);
    }

    return data;
  }

  static async getClientProjects(clientId: number) {
    const { data, error } = await supabase
      .from('projects')
      .select('*')
      .or(`client_id.eq.${clientId},client2.eq.${clientId},client3.eq.${clientId}`);

    if (error) throw error;
    return data || [];
  }

  // ============================================
  // USER ROLES
  // ============================================

  /**
   * Determine user role by Telegram ID
   * Returns: "Продюсер [Name]", "Клиент [Name]", or "Команда"
   */
  static async getUserRole(senderId: string): Promise<string> {
    try {
      logger.debug(`🔍 Checking role for sender_id: ${senderId}`);

      // Check if producer
      const producer = await this.getProducer(senderId);
      if (producer) {
        logger.debug(`✓ Found producer: ${producer.producer_name}`);
        return `Продюсер ${producer.producer_name}`;
      }

      // Check if client
      const client = await this.getClient(senderId);
      if (client) {
        logger.debug(`✓ Found client: ${client.client_name}`);
        return `Клиент ${client.client_name}`;
      }

      // Unknown user = team member
      logger.debug(`ℹ️ Sender ${senderId} not found in producers or clients - marking as Команда`);
      return 'Команда';

    } catch (error) {
      logger.error(`Error determining role for sender ${senderId}:`, error);
      return `ID:${senderId}`;
    }
  }

  /**
   * Format messages with roles for AI analysis
   * Converts: [sender_id]: text
   * To: [Продюсер Анна]: text
   */
  static async formatConversationWithRoles(messages: any[]): Promise<string> {
    const formattedLines: string[] = [];

    for (const msg of messages) {
      const role = await this.getUserRole(msg.sender_id);
      formattedLines.push(`[${role}]: ${msg.message_text}`);
    }

    return formattedLines.join('\n\n');
  }

  // ============================================
  // SYSTEM SETTINGS
  // ============================================

  static async getSystemSettings() {
    const { data, error } = await supabase
      .from('system')
      .select('*')
      .eq('id', 1)
      .single();

    if (error) throw error;
    return data;
  }

  static async updateSystemFlag(flagName: string, value: boolean) {
    const { data, error } = await supabase
      .from('system')
      .update({ [flagName]: value })
      .eq('id', 1);

    if (error) throw error;
    return data;
  }

  // ============================================
  // CUSTOM BLOCK STATUSES
  // ============================================

  /**
   * Save or update custom block status
   */
  static async upsertCustomBlockStatus(data: {
    project_id: number;
    block_id: string;
    block_name: string;
    block_type: string;
    status_analysis: string;
  }) {
    const { data: result, error } = await supabase
      .from('custom_block_statuses')
      .upsert(
        {
          ...data,
          updated_at: new Date().toISOString(),
        },
        { onConflict: 'project_id,block_id' }
      )
      .select();

    if (error) throw error;
    return result;
  }

  /**
   * Get custom block statuses for a project
   */
  static async getCustomBlockStatuses(projectId: number) {
    const { data, error } = await supabase
      .from('custom_block_statuses')
      .select('*')
      .eq('project_id', projectId);

    if (error) throw error;
    return data || [];
  }

  /**
   * Delete custom block status
   */
  static async deleteCustomBlockStatus(projectId: number, blockId: string) {
    const { error } = await supabase
      .from('custom_block_statuses')
      .delete()
      .eq('project_id', projectId)
      .eq('block_id', blockId);

    if (error) throw error;
  }

  /**
   * Get client settings for a project
   * Returns settings or default if not found
   */
  static async getClientSettings(projectId: number) {
    const { data, error } = await supabase
      .from('client_settings')
      .select('*')
      .eq('project_id', projectId)
      .single();

    if (error && error.code !== 'PGRST116') {
      // PGRST116 = no rows found, which is OK (we'll use defaults)
      logger.error(`Error getting client settings for project ${projectId}:`, error);
    }

    // Return data or default settings
    return data || getDefaultClientSettings();
  }

  /**
   * Get all projects with producer info
   */
  static async getAllProjects() {
    const { data, error } = await supabase
      .from('projects')
      .select(`
        *,
        producer:producer_id (*)
      `);

    if (error) {
      logger.error('Error getting all projects:', error);
      return [];
    }

    return data || [];
  }
}

/**
 * Default client settings
 * Used when project doesn't have custom settings
 */
export function getDefaultClientSettings() {
  return {
    status_frequency_day: 'Mon,Tue,Wed,Thu,Fri', // Weekdays
    status_frequency_time: '10:00:00+03', // 10:00 Moscow time
    format_status: 'длинный', // Long format
  };
}
