-- Создание тестовой таблицы projects_test (копия структуры projects)
-- Используется для тестирования новых AI промптов без влияния на продакшн

CREATE TABLE IF NOT EXISTS public.projects_test (
  LIKE public.projects INCLUDING ALL
);

-- Если нужно скопировать текущие данные из projects (опционально)
-- INSERT INTO public.projects_test SELECT * FROM public.projects;

-- Комментарий
COMMENT ON TABLE public.projects_test IS 'Тестовая копия таблицы projects для отладки AI промптов';
