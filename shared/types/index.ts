/**
 * Shared TypeScript types for Ninja Status Bot
 */

// Database models
export interface Message {
  id: number;
  telegram_chat_id: string;
  sender_id: string;
  message_text: string;
  chat_name_tg: string;
  is_analyzed: boolean;
  created_at: string;
}

export interface Project {
  project_id: number;
  project_name: string;
  // Стандартные поля блоков хранятся как колонки (legacy, для обратной совместимости)
  // Основное хранилище статусов — таблица custom_block_statuses
  [key: string]: any;
}

export interface Chat {
  id: number;
  telegram_chat_id: string;
  project_id: number;
  chat_name: string;
  created_at: string;
}

export interface SystemSettings {
  id: number;
  number_of_new_messages: number;
  one_more_update: boolean;
}

export interface ChatRequest {
  userId: string;
  message: string;
}

export interface ChatResponse {
  answer: string;
}
