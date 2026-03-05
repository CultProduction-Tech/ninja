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
  phase: 'pre' | 'post';
}

export interface ManualStatus {
  taskName: string;
  status: string;
  date: string | null;
  changedAt: string;
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
            type: block.type,
            phase: 'pre'
          });
        }
      }

      if (Array.isArray(data.post_blocks)) {
        for (const block of data.post_blocks) {
          blocks.push({
            id: block.id,
            name: block.name,
            type: block.type,
            phase: 'post'
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

  /**
   * Получить последние ручные статусы блоков проекта из дашборда.
   * Возвращает Map: taskName (block.id) → ManualStatus
   */
  static async getManualStatuses(projectName: string): Promise<Map<string, ManualStatus>> {
    const result = new Map<string, ManualStatus>();

    try {
      const { data, error } = await dashboardSupabase
        .from('status_change_history')
        .select('task_name, new_status, new_date, changed_at')
        .eq('project_name', projectName)
        .eq('change_type', 'manual')
        .order('changed_at', { ascending: false });

      if (error) {
        logger.error(`Error getting manual statuses for ${projectName}:`, error);
        return result;
      }

      if (!data || data.length === 0) {
        return result;
      }

      // Берём только последнюю запись по каждому блоку (данные уже отсортированы по changed_at desc)
      for (const row of data) {
        if (!result.has(row.task_name)) {
          result.set(row.task_name, {
            taskName: row.task_name,
            status: row.new_status,
            date: row.new_date,
            changedAt: row.changed_at,
          });
        }
      }

      logger.info(`Found ${result.size} manual statuses for ${projectName}`);
      return result;
    } catch (error) {
      logger.error(`Error in getManualStatuses:`, error);
      return result;
    }
  }

}
