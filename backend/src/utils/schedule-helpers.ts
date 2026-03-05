import { logger } from './logger';

/**
 * Парсит время в формате "21:00:00+03" → { hour, minute, offsetHours }
 */
function parseTimeWithOffset(timeStr: string): { hour: number; minute: number; offsetHours: number } | null {
  const match = timeStr.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?(?:\+(\d{1,2}))?$/);
  if (!match) return null;
  return {
    hour: parseInt(match[1]),
    minute: parseInt(match[2]),
    offsetHours: match[4] ? parseInt(match[4]) : 3, // default Moscow +03
  };
}

/**
 * Проверяет, попадает ли текущее время в тихие часы.
 * Поддерживает overnight range (21:00 → 09:00).
 * Если настройки null — возвращает false (не в тихих часах).
 */
export function isInQuietHours(quietFrom: string | null, quietTo: string | null): boolean {
  if (!quietFrom || !quietTo) return false;

  const from = parseTimeWithOffset(quietFrom);
  const to = parseTimeWithOffset(quietTo);
  if (!from || !to) return false;

  const now = new Date();
  const utcMinutes = now.getUTCHours() * 60 + now.getUTCMinutes();
  const currentMinutes = ((utcMinutes + from.offsetHours * 60) % (24 * 60) + 24 * 60) % (24 * 60);

  const fromMinutes = from.hour * 60 + from.minute;
  const toMinutes = to.hour * 60 + to.minute;

  if (fromMinutes <= toMinutes) {
    // Дневной диапазон (09:00 → 18:00)
    return currentMinutes >= fromMinutes && currentMinutes < toMinutes;
  } else {
    // Ночной диапазон (21:00 → 09:00)
    return currentMinutes >= fromMinutes || currentMinutes < toMinutes;
  }
}

/**
 * Проверяет, заблокирована ли отправка в выходные.
 * @returns { blocked: true } — не отправлять вообще
 * @returns { blocked: false, urgentOnly: true } — только срочные
 * @returns { blocked: false, urgentOnly: false } — отправлять как обычно
 */
export function checkWeekendPolicy(weekendSetting: string | null): { blocked: boolean; urgentOnly: boolean } {
  const now = new Date();
  const day = now.getDay(); // 0=Sun, 6=Sat
  const isWeekend = day === 0 || day === 6;

  if (!isWeekend) {
    return { blocked: false, urgentOnly: false };
  }

  if (weekendSetting === 'no') {
    return { blocked: true, urgentOnly: false };
  }

  if (weekendSetting === 'urgent') {
    return { blocked: false, urgentOnly: true };
  }

  // null или другие значения — отправлять как обычно
  return { blocked: false, urgentOnly: false };
}
