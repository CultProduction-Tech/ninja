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
  id: string;           // Unique block ID
  name: string;         // Block name
  type: 'standard' | 'custom_pre' | 'custom_post';  // Block type
}

export class DashboardClient {
  static supabase = dashboardSupabase;

  /**
   * 🆕 Get all blocks for a project from project_task_templates
   * Returns combined pre_blocks + post_blocks
   */
  static async getActiveBlocks(projectName: string): Promise<DashboardBlock[]> {
    try {
      const { data, error } = await dashboardSupabase
        .from('project_task_templates')
        .select('pre_blocks, post_blocks')
        .eq('project_name', projectName)
        .single();

      if (error) {
        // If not found, try to log but don't fail
        if (error.code === 'PGRST116') {
          logger.warn(`No task template found for project: ${projectName}`);
        } else {
          logger.error(`Error getting blocks for ${projectName}:`, error);
        }
        return [];
      }

      if (!data) {
        logger.warn(`No data found for project: ${projectName}`);
        return [];
      }

      const blocks: DashboardBlock[] = [];

      // Add pre-production blocks
      if (Array.isArray(data.pre_blocks)) {
        for (const block of data.pre_blocks) {
          blocks.push({
            id: block.id,
            name: block.name,
            type: block.type
          });
        }
      }

      // Add post-production blocks
      if (Array.isArray(data.post_blocks)) {
        for (const block of data.post_blocks) {
          blocks.push({
            id: block.id,
            name: block.name,
            type: block.type
          });
        }
      }

      logger.info(`Found ${blocks.length} blocks for ${projectName} (${data.pre_blocks?.length || 0} pre + ${data.post_blocks?.length || 0} post)`);

      return blocks;
    } catch (error) {
      logger.error(`Error in getActiveBlocks:`, error);
      return [];
    }
  }

}
