/**
 * Единый справочник блоков проекта.
 * Все маппинги (имена, эмодзи, поля БД, категории) — здесь.
 */

// Маппинг: имя блока в дашборде → колонка в таблице projects
const FIELD_MAPPING: Record<string, string> = {
  'documents': 'doc',
  'storyboard': 'storyboard_cult',
  'casting': 'casting_cult',
  'location': 'location_cult',
  'props': 'props_cult',
  'wardrobe': 'clothes_cult',
  'editing': 'editing_cult',
  'voice': 'vo_cult',
  'music': 'music_cult',
  'color': 'colorgrading_cult',
  'photos': 'photos_cult',
  'cg': 'cg_cult',
  'animatic': 'animatic_cult',
  'modelling': 'modelling_cult',
  'styleshots': 'styleshots_cult',
  'animation': 'animation_cult',
  // Русские алиасы (дашборд иногда передаёт русские имена)
  'Документы': 'doc',
  'Раскадровка': 'storyboard_cult',
  'Кастинг': 'casting_cult',
  'Локация': 'location_cult',
  'Реквизит': 'props_cult',
  'Костюмы': 'clothes_cult',
  'Монтаж': 'editing_cult',
  'Озвучка': 'vo_cult',
  'Музыка': 'music_cult',
  'Цветокоррекция': 'colorgrading_cult',
  'Фото': 'photos_cult',
  'CG': 'cg_cult',
  'Аниматик': 'animatic_cult',
  'Моделирование': 'modelling_cult',
  'Стайлшоты': 'styleshots_cult',
  'Анимация': 'animation_cult',
};

// Русские отображаемые имена стандартных блоков
const DISPLAY_NAMES: Record<string, string> = {
  'documents': 'Документы',
  'storyboard': 'Сториборд',
  'casting': 'Кастинг',
  'location': 'Локации / Декорации',
  'props': 'Эскизы и реквизит',
  'wardrobe': 'Костюм',
  'editing': 'Монтаж',
  'voice': 'Войсовер',
  'music': 'Музыка',
  'color': 'Цветокоррекция',
  'photos': 'Фото',
  'cg': 'CG',
  'animatic': 'Аниматик',
  'modelling': 'Моделирование',
  'styleshots': 'Стайлшоты',
  'animation': 'Анимация',
};

// Эмодзи для стандартных блоков
const EMOJIS: Record<string, string> = {
  'documents': '📋',
  'storyboard': '🎨',
  'casting': '🎭',
  'location': '📍',
  'props': '🎪',
  'wardrobe': '👕',
  'editing': '✂️',
  'voice': '🎤',
  'music': '🎵',
  'color': '🌈',
  'photos': '📷',
  'cg': '💫',
  'animatic': '🎬',
  'modelling': '🏗️',
  'styleshots': '📸',
  'animation': '🎞️',
};

// Ключевые слова для категоризации статусов
const IMPORTANT_KEYWORDS = [
  // Срочность
  'важно', 'необходимо', 'срочно', 'нужно утвердить', 'требуется',
  'критично', 'обязательно', 'должны', 'надо',
  // Ожидание от клиента/команды
  'ждем ос', 'ждём ос', 'ждем обратн', 'ждём обратн',
  'ждем фидбек', 'ждём фидбек', 'ждем ваш фидбек', 'ждём ваш фидбек',
  'ждем от клиента', 'ждём от клиента', 'ждем ответ', 'ждём ответ',
  'ждем согласов', 'ждём согласов', 'ждем подтвержд', 'ждём подтвержд',
  'ждем правк', 'ждём правк', 'ждем комментар', 'ждём комментар',
  'нужно согласов', 'на согласовании',
  // Проблемы
  'задержка', 'отказал', 'переделать', 'не устроил', 'не подходит',
  'заблокирован', 'проблема', 'не успева'
];

const APPROVED_KEYWORDS = [
  // Прямое согласование
  'согласовано', 'согласован ', 'согласована', 'утверждено', 'утвержден', 'утверждена',
  'одобрено', 'одобрен', 'окнули', 'ок от клиента',
  // Завершение
  'подписан', 'завершен', 'завершена', 'принято', 'принят', 'финальн',
  'готово к', 'готов к', 'сдано', 'сдан ',
  // Косвенные маркеры утверждения
  'можно забирать', 'правки внесены', 'правки учтены',
  'без замечаний', 'замечаний нет', 'комментариев нет',
  'клиент подтвердил', 'клиент одобрил'
];

const DATE_PATTERN = /\d{1,2}[.\-\/]\d{1,2}|\d{1,2}\s+(января|февраля|марта|апреля|мая|июня|июля|августа|сентября|октября|ноября|декабря)|PPM|pre-PPM|съемка|презентация/i;

/**
 * Получить имя колонки в таблице projects по имени блока из дашборда.
 * Возвращает null если блок не стандартный.
 */
export function getStandardFieldMapping(blockName: string): string | null {
  return FIELD_MAPPING[blockName] || null;
}

/**
 * Получить русское отображаемое имя стандартного блока.
 * Для кастомных блоков возвращает оригинальное имя.
 */
export function getBlockDisplayName(blockName: string): string {
  return DISPLAY_NAMES[blockName] || blockName;
}

/**
 * Получить эмодзи для блока.
 * Для стандартных — из справочника, для кастомных — ⭐.
 */
export function getBlockEmoji(blockName: string): string {
  return EMOJIS[blockName] || '⭐';
}

/**
 * Категоризировать статус по ключевым словам.
 */
export function categorizeStatus(status: string): 'important' | 'in_progress' | 'approved' | 'dates' | 'no_info' {
  const lower = status.toLowerCase();

  if (lower.includes('информация отсутствует') || lower.includes('нет информации')) {
    return 'no_info';
  }

  if (IMPORTANT_KEYWORDS.some(kw => lower.includes(kw))) {
    return 'important';
  }

  if (APPROVED_KEYWORDS.some(kw => lower.includes(kw))) {
    return 'approved';
  }

  if (DATE_PATTERN.test(status)) {
    return 'dates';
  }

  return 'in_progress';
}
