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
   * Получить project_id из дашборда по имени проекта.
   */
  static async getProjectIdFromDashboard(projectName: string): Promise<number | null> {
    try {
      const { data, error } = await dashboardSupabase
        .from('project_statuses')
        .select('id')
        .eq('project_name', projectName)
        .single();

      if (data) return data.id;

      // Fallback: попробовать project_task_templates
      if (error) {
        const { data: tplData } = await dashboardSupabase
          .from('project_task_templates')
          .select('id')
          .eq('project_name', projectName)
          .single();

        if (tplData) return tplData.id;
      }

      return null;
    } catch (error) {
      logger.error(`Error getting project id from dashboard for ${projectName}:`, error);
      return null;
    }
  }

  /**
   * Синхронизировать AI-статус блока в дашбордную Supabase (OCTOPUS).
   * Для стандартных блоков: обновить JSON-колонку в project_statuses.
   * Для кастомных блоков: записать в status_change_history с change_type: "auto".
   * Не перезаписывает ручные статусы (change_type: "manual").
   */
  static async syncStatusToDashboard(
    projectName: string,
    blockId: string,
    blockName: string,
    blockType: 'standard' | 'custom_pre' | 'custom_post',
    newStatus: string
  ): Promise<void> {
    try {
      // Проверяем: если последняя запись в history — manual, не перезаписываем
      const taskName = blockId;

      const { data: lastEntry } = await dashboardSupabase
        .from('status_change_history')
        .select('change_type, new_status')
        .eq('project_name', projectName)
        .eq('task_name', taskName)
        .order('changed_at', { ascending: false })
        .limit(1)
        .single();

      if (lastEntry?.change_type === 'manual') {
        logger.info(`Dashboard sync skipped for ${projectName}/${blockName}: manual status has priority`);
        return;
      }

      // Если статус не изменился — пропускаем
      if (lastEntry?.new_status === newStatus) {
        return;
      }

      const oldStatus = lastEntry?.new_status || null;
      const now = new Date().toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric' });

      // Для стандартных блоков — обновить JSON-колонку в project_statuses
      if (blockType === 'standard') {
        const { error: updateError } = await dashboardSupabase
          .from('project_statuses')
          .update({ [blockId]: { status: newStatus, date: now } })
          .eq('project_name', projectName);

        if (updateError) {
          logger.warn(`Dashboard project_statuses update failed for ${projectName}/${blockName}:`, updateError);
        }
      }

      // Для всех блоков — запись в status_change_history
      const projectId = await this.getProjectIdFromDashboard(projectName);

      const { error: historyError } = await dashboardSupabase
        .from('status_change_history')
        .insert({
          project_id: projectId,
          project_name: projectName,
          task_name: taskName,
          old_status: oldStatus,
          new_status: newStatus,
          old_date: null,
          new_date: now,
          changed_by: null,
          change_type: 'auto',
          metadata: {}
        });

      if (historyError) {
        logger.warn(`Dashboard history insert failed for ${projectName}/${blockName}:`, historyError);
      } else {
        logger.info(`Dashboard synced: ${projectName} / ${blockName} → ${newStatus}`);
      }
    } catch (error) {
      logger.error(`Error syncing status to dashboard for ${projectName}/${blockName}:`, error);
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
