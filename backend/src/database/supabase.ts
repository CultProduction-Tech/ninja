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

  static async getAllProjects() {
    const { data, error } = await supabase
      .from('projects')
      .select('*');

    if (error) throw error;
    return data || [];
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
    const { data, error } = await supabase
      .from('producers')
      .select('*')
      .eq('producer_tg_chat_id', telegramId)
      .single();

    if (error && error.code !== 'PGRST116') throw error; // PGRST116 = not found
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
    const { data, error } = await supabase
      .from('clients')
      .select('*')
      .eq('client_chat_id', telegramId)
      .single();

    if (error && error.code !== 'PGRST116') throw error;
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
}
