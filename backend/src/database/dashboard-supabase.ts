import { createClient } from '@supabase/supabase-js';
import { logger } from '../utils/logger';

const supabaseUrl = process.env.DASHBOARD_SUPABASE_URL!;
const supabaseKey = process.env.DASHBOARD_SUPABASE_KEY!;

if (!supabaseUrl || !supabaseKey) {
  throw new Error('Missing Dashboard Supabase credentials');
}

const dashboardSupabase = createClient(supabaseUrl, supabaseKey);

export interface DashboardBlock {
  id: string;
  name: string;
  type: 'standard' | 'custom_pre' | 'custom_post';
}

export class DashboardClient {
  static supabase = dashboardSupabase;

  static async getActiveBlocks(projectName: string): Promise<DashboardBlock[]> {
    try {
      const { data, error } = await dashboardSupabase
        .from('project_task_templates')
        .select('pre_blocks, post_blocks')
        .eq('project_name', projectName)
        .single();

      if (error) {
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

      if (Array.isArray(data.pre_blocks)) {
        for (const block of data.pre_blocks) {
          blocks.push({
            id: block.id,
            name: block.name,
            type: block.type
          });
        }
      }

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
