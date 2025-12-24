import { createClient } from '@supabase/supabase-js';
import { logger } from '../utils/logger';

/**
 * Dashboard Supabase Client
 * Connects to separate Dashboard database
 */

const supabaseUrl = process.env.DASHBOARD_SUPABASE_URL!;
const supabaseKey = process.env.DASHBOARD_SUPABASE_KEY!;

if (!supabaseUrl || !supabaseKey) {
  throw new Error('Missing Dashboard Supabase credentials');
}

const dashboardSupabase = createClient(supabaseUrl, supabaseKey);

/**
 * Block structure from Dashboard
 */
export interface DashboardBlock {
  name: string;
  type: 'standard' | 'custom_pre' | 'custom_post';
  id?: string; // For custom blocks
  currentStatus?: string; // Current status from Dashboard
}

export class DashboardClient {
  static supabase = dashboardSupabase;

  /**
   * Get project stage (препродакшн/постпродакшн)
   */
  static async getProjectStage(projectName: string): Promise<string | null> {
    try {
      const { data, error } = await dashboardSupabase
        .from('projects_main')
        .select('stage')
        .eq('project_name', projectName)
        .single();

      if (error) {
        logger.error(`Error getting project stage for ${projectName}:`, error);
        return null;
      }

      return data?.stage || null;
    } catch (error) {
      logger.error(`Error in getProjectStage:`, error);
      return null;
    }
  }

  /**
   * Get standard blocks from project_statuses
   * Returns only blocks where status is not null
   */
  static async getStandardBlocks(projectName: string): Promise<DashboardBlock[]> {
    try {
      const { data, error } = await dashboardSupabase
        .from('project_statuses')
        .select('*')
        .eq('project_name', projectName)
        .single();

      if (error) {
        logger.error(`Error getting standard blocks for ${projectName}:`, error);
        return [];
      }

      if (!data) return [];

      const blocks: DashboardBlock[] = [];
      const standardFields = [
        'documents', 'storyboard', 'casting', 'location', 'props',
        'wardrobe', 'editing', 'voice', 'music', 'color', 'photos',
        'cg', 'animatic', 'modelling', 'styleshots', 'animation'
      ];

      for (const field of standardFields) {
        const value = data[field];
        // Check if field exists and has non-null status
        if (value && typeof value === 'object' && value.status !== null && value.status !== undefined) {
          blocks.push({
            name: field,
            type: 'standard',
            currentStatus: value.status
          });
        }
      }

      logger.info(`Found ${blocks.length} standard blocks for ${projectName}`);
      return blocks;
    } catch (error) {
      logger.error(`Error in getStandardBlocks:`, error);
      return [];
    }
  }

  /**
   * Get custom blocks from project_details
   */
  static async getCustomBlocks(projectName: string, stage: string): Promise<DashboardBlock[]> {
    try {
      // First, get project_id from projects_main
      const { data: projectData, error: projectError } = await dashboardSupabase
        .from('projects_main')
        .select('project_id')
        .eq('project_name', projectName)
        .single();

      if (projectError || !projectData) {
        logger.error(`Error getting project_id for ${projectName}:`, projectError);
        return [];
      }

      // Get custom tasks
      const { data, error } = await dashboardSupabase
        .from('project_details')
        .select('custom_tasks_pre, custom_tasks_post')
        .eq('project_id', projectData.project_id)
        .single();

      if (error) {
        logger.error(`Error getting custom blocks for ${projectName}:`, error);
        return [];
      }

      if (!data) return [];

      const blocks: DashboardBlock[] = [];
      const isPreProduction = stage?.toLowerCase().includes('пре');

      // Get appropriate custom tasks based on stage
      const customTasks = isPreProduction ? data.custom_tasks_pre : data.custom_tasks_post;
      const blockType = isPreProduction ? 'custom_pre' : 'custom_post';

      if (Array.isArray(customTasks)) {
        for (const task of customTasks) {
          blocks.push({
            name: task.name,
            type: blockType,
            id: task.id,
            currentStatus: task.status
          });
        }
      }

      logger.info(`Found ${blocks.length} custom blocks for ${projectName} (${stage})`);
      return blocks;
    } catch (error) {
      logger.error(`Error in getCustomBlocks:`, error);
      return [];
    }
  }

  /**
   * Get all active blocks for a project
   */
  static async getActiveBlocks(projectName: string): Promise<DashboardBlock[]> {
    try {
      // Get stage
      const stage = await this.getProjectStage(projectName);

      // Get standard blocks
      const standardBlocks = await this.getStandardBlocks(projectName);

      // Get custom blocks
      const customBlocks = stage ? await this.getCustomBlocks(projectName, stage) : [];

      const allBlocks = [...standardBlocks, ...customBlocks];
      logger.info(`Total active blocks for ${projectName}: ${allBlocks.length}`);

      return allBlocks;
    } catch (error) {
      logger.error(`Error in getActiveBlocks:`, error);
      return [];
    }
  }

  /**
   * Update standard block status in Dashboard
   */
  static async updateStandardBlockStatus(
    projectName: string,
    blockName: string,
    newStatus: string
  ): Promise<void> {
    try {
      const { error } = await dashboardSupabase
        .from('project_statuses')
        .update({
          [blockName]: { status: newStatus, date: new Date().toISOString() }
        })
        .eq('project_name', projectName);

      if (error) {
        logger.error(`Error updating standard block ${blockName}:`, error);
      } else {
        logger.info(`✅ Updated Dashboard: ${projectName} / ${blockName}`);
      }
    } catch (error) {
      logger.error(`Error in updateStandardBlockStatus:`, error);
    }
  }

  /**
   * Update custom block status in Dashboard
   */
  static async updateCustomBlockStatus(
    projectName: string,
    blockId: string,
    blockType: 'custom_pre' | 'custom_post',
    newStatus: string
  ): Promise<void> {
    try {
      // Get project_id
      const { data: projectData } = await dashboardSupabase
        .from('projects_main')
        .select('project_id')
        .eq('project_name', projectName)
        .single();

      if (!projectData) return;

      // Get current tasks
      const field = blockType === 'custom_pre' ? 'custom_tasks_pre' : 'custom_tasks_post';
      const { data } = await dashboardSupabase
        .from('project_details')
        .select(field)
        .eq('project_id', projectData.project_id)
        .single();

      if (!data) return;

      // Update the specific task
      const tasks = data[field] || [];
      const updatedTasks = tasks.map((task: any) => {
        if (task.id === blockId) {
          return { ...task, status: newStatus };
        }
        return task;
      });

      // Save back
      const { error } = await dashboardSupabase
        .from('project_details')
        .update({ [field]: updatedTasks })
        .eq('project_id', projectData.project_id);

      if (error) {
        logger.error(`Error updating custom block ${blockId}:`, error);
      } else {
        logger.info(`✅ Updated Dashboard custom block: ${projectName} / ${blockId}`);
      }
    } catch (error) {
      logger.error(`Error in updateCustomBlockStatus:`, error);
    }
  }
}
