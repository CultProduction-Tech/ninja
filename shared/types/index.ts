/**
 * Shared TypeScript types for Ninja Status Bot
 */

// Project stage fields
export type ProjectStage =
  | 'doc'
  | 'storyboard_client' | 'storyboard_cult'
  | 'aigen_client' | 'aigen_cult'
  | 'casting_client' | 'casting_cult'
  | 'clothes_client' | 'clothes_cult'
  | 'props_client' | 'props_cult'
  | 'location_client' | 'location_cult'
  | 'animatic_client' | 'animatic_cult'
  | 'modelling_client' | 'modelling_cult'
  | 'styleshots_client' | 'styleshots_cult'
  | 'animation_client' | 'animation_cult'
  | 'editing_client' | 'editing_cult'
  | 'music_client' | 'music_cult'
  | 'vo_client' | 'vo_cult'
  | 'colorgrading_client' | 'colorgrading_cult'
  | 'photos_client' | 'photos_cult'
  | 'cg_client' | 'cg_cult';

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

  // All stage fields
  doc?: string;
  storyboard_client?: string;
  storyboard_cult?: string;
  aigen_client?: string;
  aigen_cult?: string;
  casting_client?: string;
  casting_cult?: string;
  clothes_client?: string;
  clothes_cult?: string;
  props_client?: string;
  props_cult?: string;
  location_client?: string;
  location_cult?: string;
  animatic_client?: string;
  animatic_cult?: string;
  modelling_client?: string;
  modelling_cult?: string;
  styleshots_client?: string;
  styleshots_cult?: string;
  animation_client?: string;
  animation_cult?: string;
  editing_client?: string;
  editing_cult?: string;
  music_client?: string;
  music_cult?: string;
  vo_client?: string;
  vo_cult?: string;
  colorgrading_client?: string;
  colorgrading_cult?: string;
  photos_client?: string;
  photos_cult?: string;
  cg_client?: string;
  cg_cult?: string;

  created_at: string;
  updated_at: string;
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

// AI Service types
export interface StatusAnalysisRequest {
  projectId: number;
  projectName: string;
  currentStatus: Partial<Project>;
  conversation: string;
}

export interface StatusAnalysisResponse {
  [key: string]: string | undefined;
}

export interface ChatRequest {
  userId: string;
  message: string;
}

export interface ChatResponse {
  answer: string;
}
