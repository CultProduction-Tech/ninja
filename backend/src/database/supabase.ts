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

  static async saveMessage(data: {
    telegram_chat_id: string;
    sender_id: string;
    message_text: string;
    chat_name_tg: string;
    is_analyzed: boolean;
    telegram_message_id?: number;
  }) {
    logger.info(`saveMessage: telegram_message_id=${data.telegram_message_id} (type: ${typeof data.telegram_message_id})`);

    const { data: result, error } = await supabase
      .from('messages')
      .insert([data])
      .select('message_id, telegram_message_id');

    if (error) throw error;
    if (result && result[0]) {
      logger.info(`saveMessage: saved as #${result[0].message_id}, tg_msg_id=${result[0].telegram_message_id}`);
    }
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

  static async getLastMessages(chatId: string, limit: number = 50) {
    const { data, error } = await supabase
      .from('messages')
      .select('*')
      .eq('telegram_chat_id', chatId)
      .order('timestamp', { ascending: false })
      .limit(limit);

    if (error) throw error;
    return data ? data.reverse() : [];
  }

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

    const outerChat = data.find(chat => chat.chat_type === 'outer');
    if (outerChat) {
      logger.info(`Found outer chat for project ${projectId}: ${outerChat.chat_name_tg}`);
      return outerChat;
    }

    logger.info(`No outer chat found for project ${projectId}, using first chat: ${data[0].chat_name_tg}`);
    return data[0];
  }

  static async getChatsByProjectId(projectId: number) {
    const { data, error } = await supabase
      .from('chats')
      .select('*')
      .eq('project_id', projectId);

    if (error) throw error;
    return data || [];
  }

  static async getLastMessagesForProject(projectId: number, limit: number = 50) {
    const chats = await this.getChatsByProjectId(projectId);

    if (chats.length === 0) {
      logger.warn(`No chats found for project ${projectId}`);
      return [];
    }

    logger.info(`Found ${chats.length} chats for project ${projectId}`);

    const chatIds = chats.map(chat => chat.telegram_chat_id);

    const { data, error } = await supabase
      .from('messages')
      .select('*')
      .in('telegram_chat_id', chatIds)
      .order('timestamp', { ascending: false })
      .limit(limit);

    if (error) throw error;

    logger.info(`Retrieved ${data?.length || 0} messages from ${chats.length} chats for project ${projectId}`);

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

  static async getProjectTest(projectId: number) {
    const { data: testData, error: testError } = await supabase
      .from('projects_test')
      .select('*')
      .eq('project_id', projectId)
      .single();

    if (testError) throw testError;

    const { data: projectData, error: projectError } = await supabase
      .from('projects')
      .select(`
        producer:producer_id (*),
        producer2:producer2 (*),
        client:client_id (*)
      `)
      .eq('project_id', projectId)
      .single();

    if (projectError) {
      return testData;
    }

    return {
      ...testData,
      producer: projectData?.producer,
      producer2: projectData?.producer2,
      client: projectData?.client
    };
  }

  static async ensureProjectTestExists(projectId: number) {
    const { data: existing } = await supabase
      .from('projects_test')
      .select('project_id')
      .eq('project_id', projectId)
      .single();

    if (!existing) {
      const project = await this.getProject(projectId);
      if (project) {
        const { error } = await supabase
          .from('projects_test')
          .insert(project);

        if (error) {
          logger.error(`Error creating project_test ${projectId}:`, error);
          throw error;
        }
        logger.info(`Created project_test for project ${projectId}`);
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

  static async getProducer(telegramId: string) {
    logger.debug(`getProducer: searching for telegram_id=${telegramId}`);

    const { data, error } = await supabase
      .from('producers')
      .select('*')
      .eq('producer_tg_chat_id', telegramId)
      .single();

    if (error && error.code !== 'PGRST116') {
      logger.error(`getProducer error for ${telegramId}:`, error);
      throw error;
    }

    if (data) {
      logger.debug(`Found producer: ${data.producer_name}`);
    } else {
      logger.debug(`No producer found for ${telegramId}`);
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

  static async getClient(telegramId: string) {
    logger.debug(`getClient: searching for telegram_id=${telegramId}`);

    const { data, error } = await supabase
      .from('clients')
      .select('*')
      .eq('client_chat_id', telegramId)
      .single();

    if (error && error.code !== 'PGRST116') {
      logger.error(`getClient error for ${telegramId}:`, error);
      throw error;
    }

    if (data) {
      logger.debug(`Found client: ${data.client_name}`);
    } else {
      logger.debug(`No client found for ${telegramId}`);
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

  static async getUserRole(senderId: string): Promise<string> {
    try {
      logger.debug(`Checking role for sender_id: ${senderId}`);

      const producer = await this.getProducer(senderId);
      if (producer) {
        logger.debug(`Found producer: ${producer.producer_name}`);
        return `Продюсер ${producer.producer_name}`;
      }

      const client = await this.getClient(senderId);
      if (client) {
        logger.debug(`Found client: ${client.client_name}`);
        return `Клиент ${client.client_name}`;
      }

      logger.debug(`Sender ${senderId} not found in producers or clients - marking as Команда`);
      return 'Команда';

    } catch (error) {
      logger.error(`Error determining role for sender ${senderId}:`, error);
      return `ID:${senderId}`;
    }
  }

  static async formatConversationWithRoles(messages: any[]): Promise<string> {
    const formattedLines: string[] = [];

    for (const msg of messages) {
      const role = await this.getUserRole(msg.sender_id);
      const msgTag = msg.message_id ? `[#${msg.message_id}]` : '';
      formattedLines.push(`${msgTag}[${role}]: ${msg.message_text}`);
    }

    return formattedLines.join('\n\n');
  }

  static buildMessageLinkMap(messages: any[]): Map<number, string> {
    const linkMap = new Map<number, string>();
    for (const msg of messages) {
      if (!msg.message_id || !msg.telegram_chat_id || !msg.telegram_message_id) continue;
      const chatId = msg.telegram_chat_id.toString().replace(/^-100/, '');
      const link = `https://t.me/c/${chatId}/${msg.telegram_message_id}`;
      linkMap.set(msg.message_id, link);
    }
    return linkMap;
  }

  static async buildLinkMapByIds(messageIds: number[]): Promise<Map<number, string>> {
    if (messageIds.length === 0) {
      logger.info('buildLinkMapByIds: no IDs to resolve');
      return new Map();
    }

    logger.info(`buildLinkMapByIds: resolving ${messageIds.length} IDs: ${messageIds.join(', ')}`);

    const { data, error } = await supabase
      .from('messages')
      .select('message_id, telegram_chat_id, telegram_message_id')
      .in('message_id', messageIds);

    if (error) {
      logger.error('Error fetching messages by IDs:', error);
      return new Map();
    }

    logger.info(`buildLinkMapByIds: found ${data?.length || 0} messages in DB`);
    if (data && data.length > 0) {
      logger.info(`buildLinkMapByIds: first msg: ${JSON.stringify(data[0])}`);
    }

    const linkMap = this.buildMessageLinkMap(data || []);
    logger.info(`buildLinkMapByIds: linkMap has ${linkMap.size} entries`);
    return linkMap;
  }

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

  static async getCustomBlockStatuses(projectId: number) {
    const { data, error } = await supabase
      .from('custom_block_statuses')
      .select('*')
      .eq('project_id', projectId);

    if (error) throw error;
    return data || [];
  }

  static async deleteCustomBlockStatus(projectId: number, blockId: string) {
    const { error } = await supabase
      .from('custom_block_statuses')
      .delete()
      .eq('project_id', projectId)
      .eq('block_id', blockId);

    if (error) throw error;
  }

  static async getClientSettings(projectId: number) {
    const { data, error } = await supabase
      .from('client_settings')
      .select('*')
      .eq('project_id', projectId)
      .single();

    if (error && error.code !== 'PGRST116') {
      logger.error(`Error getting client settings for project ${projectId}:`, error);
    }

    return data || getDefaultClientSettings();
  }

  static async upsertClientSettings(projectId: number, field: string, value: any) {
    logger.info(`upsertClientSettings: project=${projectId} field=${field} value=${JSON.stringify(value)}`);

    const { data: existing } = await supabase
      .from('client_settings')
      .select('project_id')
      .eq('project_id', projectId)
      .single();

    if (existing) {
      const { error } = await supabase
        .from('client_settings')
        .update({ [field]: value })
        .eq('project_id', projectId);
      if (error) {
        logger.error(`upsertClientSettings update failed: ${error.message}`, error);
        throw error;
      }
    } else {
      const { error } = await supabase
        .from('client_settings')
        .insert({ project_id: projectId, [field]: value });
      if (error) {
        logger.error(`upsertClientSettings insert failed: ${error.message}`, error);
        throw error;
      }
    }
    logger.info(`upsertClientSettings: success for project=${projectId} field=${field}`);
  }

  static async getAllProjects() {
    const { data, error } = await supabase
      .from('projects')
      .select(`
        *,
        producer:producer_id (*),
        client:client_id (*)
      `);

    if (error) {
      logger.error('Error getting all projects:', error);
      return [];
    }

    return data || [];
  }
}

export function getDefaultClientSettings() {
  return {
    status_frequency_day: 'Mon,Tue,Wed,Thu,Fri',
    status_frequency_time: '10:00:00+03',
    format_status: 'длинный',
    quiet_from: null as string | null,
    quiet_to: null as string | null,
    weekend: null as string | null,
    response_time_work: null as number | null,
    response_time_off: null as number | null,
    approval_time: null as string | null,
    deadline_date: null as string | null,
    skip_link_notifications: false,
    skip_deadline_notifications: false,
  };
}
