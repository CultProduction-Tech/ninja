import json
from typing import Dict, Any, Optional, List
from langchain_openai import ChatOpenAI
from langchain_core.messages import HumanMessage, SystemMessage, AIMessage
from loguru import logger

from ..config import settings
from ..prompts.templates import (
    PRODUCER_SYSTEM_PROMPT,
    CLIENT_SYSTEM_PROMPT,
    UNKNOWN_SYSTEM_PROMPT
)


class StatusAnalyzer:
    def __init__(self):
        self.llm = ChatOpenAI(
            model=settings.openrouter_model,
            openai_api_key=settings.openrouter_api_key,
            openai_api_base="https://openrouter.ai/api/v1",
            temperature=0.1,
            max_tokens=400,
        )
        # Separate LLM for batch block analysis — needs much more tokens
        self.batch_llm = ChatOpenAI(
            model=settings.openrouter_model,
            openai_api_key=settings.openrouter_api_key,
            openai_api_base="https://openrouter.ai/api/v1",
            temperature=0.1,
            max_tokens=3000,
        )

    async def chat(
        self,
        user_id: str,
        message: str,
        history: List[Dict[str, str]]
    ) -> str:
        messages = [
            SystemMessage(content=PRODUCER_SYSTEM_PROMPT)
        ]

        for msg in history:
            if msg['role'] == 'user':
                messages.append(HumanMessage(content=msg['content']))
            else:
                messages.append(AIMessage(content=msg['content']))

        messages.append(HumanMessage(content=message))

        response = await self.llm.ainvoke(messages)

        return response.content

    async def chat_with_context(
        self,
        user_id: str,
        message: str,
        history: List[Dict[str, str]],
        user_type: str,
        projects: List[Dict[str, Any]]
    ) -> str:
        if user_type == 'producer':
            system_prompt = PRODUCER_SYSTEM_PROMPT
        elif user_type == 'client':
            system_prompt = CLIENT_SYSTEM_PROMPT
        else:
            system_prompt = UNKNOWN_SYSTEM_PROMPT

        if projects and len(projects) > 0:
            projects_info = "\n\nВаши проекты:\n"
            for p in projects:
                projects_info += f"- {p.get('project_name', 'Без названия')}\n"

            system_prompt += projects_info

        messages = [
            SystemMessage(content=system_prompt)
        ]

        for msg in history:
            if msg['role'] == 'user':
                messages.append(HumanMessage(content=msg['content']))
            else:
                messages.append(AIMessage(content=msg['content']))

        user_message = message

        if projects:
            for project in projects:
                project_name = project.get('project_name', '')
                if project_name.lower() in message.lower():
                    user_message += f"\n\n[Контекст проекта '{project_name}':\n"
                    user_message += f"Договор: {project.get('doc', 'Нет данных')}\n"
                    user_message += f"Раскадровка: {project.get('storyboard_cult', 'Нет данных')}\n"
                    user_message += f"Монтаж: {project.get('editing_cult', 'Нет данных')}]"
                    break

        messages.append(HumanMessage(content=user_message))

        response = await self.llm.ainvoke(messages)

        return response.content

    def _build_glossary_section(self) -> str:
        """Собирает глоссарий из базовых + одобренных авто-терминов для вставки в system prompt."""
        from ..glossary.base_glossary import BASE_GLOSSARY
        from ..glossary.discovered import get_approved_terms

        all_terms = {**BASE_GLOSSARY, **get_approved_terms()}

        lines = ["ГЛОССАРИЙ ТЕРМИНОВ ВИДЕОПРОДАКШНА (используй для понимания сленга в переписке):"]
        for term, definition in all_terms.items():
            lines.append(f"- {term}: {definition}")
        return "\n".join(lines)

    async def discover_terms(self, conversation: str, project_name: str = "") -> List[Dict]:
        """
        AI-вызов: находит профессиональные термины, которых нет в глоссарии.
        Возвращает: [{term, definition, confidence}]
        """
        from ..glossary.base_glossary import BASE_GLOSSARY
        from ..glossary.discovered import get_approved_terms, load_discovered

        known_terms = set(BASE_GLOSSARY.keys())
        known_terms.update(get_approved_terms().keys())
        # Также исключаем уже обнаруженные (pending/rejected)
        all_discovered = load_discovered().get("terms", {})
        known_terms.update(all_discovered.keys())

        known_list = ", ".join(sorted(known_terms))

        prompt = f"""Ты — лингвист-эксперт по видеопродакшну. Прочитай переписку и найди профессиональные термины, сленг и аббревиатуры, которых НЕТ в текущем глоссарии.

ТЕКУЩИЙ ГЛОССАРИЙ (эти термины уже известны, НЕ включай их):
{known_list}

ПЕРЕПИСКА:
{conversation}

ЗАДАЧА:
1. Найди профессиональные термины видеопродакшна, рекламной индустрии, дизайна
2. Найди сленговые выражения и аббревиатуры
3. НЕ включай общеупотребительные слова и обычную речь
4. НЕ включай имена людей, названия компаний, даты

Верни JSON-массив (только JSON, без markdown):
[
  {{"term": "термин", "definition": "краткое определение на русском", "confidence": 0.8}},
  ...
]

confidence — уверенность что это профессиональный термин (0.0-1.0).
Включай только термины с confidence >= 0.6.
Если новых терминов нет — верни пустой массив: []"""

        try:
            discover_llm = ChatOpenAI(
                model=settings.openrouter_model,
                openai_api_key=settings.openrouter_api_key,
                openai_api_base="https://openrouter.ai/api/v1",
                temperature=0.1,
                max_tokens=1000,
            )

            messages = [
                SystemMessage(content="Ты — лингвист-эксперт. Отвечай строго в формате JSON."),
                HumanMessage(content=prompt)
            ]

            response = await discover_llm.ainvoke(messages)
            raw = response.content.strip()

            # Убираем markdown обёртку если есть
            if raw.startswith("```"):
                raw = raw.split("\n", 1)[1] if "\n" in raw else raw[3:]
                if raw.endswith("```"):
                    raw = raw[:-3]
                raw = raw.strip()

            terms = json.loads(raw)

            # Фильтруем по confidence
            terms = [t for t in terms if t.get("confidence", 0) >= 0.6]

            logger.info(f"Discovered {len(terms)} new terms from project '{project_name}'")
            return terms

        except Exception as e:
            logger.error(f"Error discovering terms: {e}")
            return []

    async def analyze_dynamic_blocks(
        self,
        project_name: str,
        blocks: List[Any],
        conversation: str
    ) -> Dict[str, str]:
        logger.info(f"Analyzing {len(blocks)} blocks for project '{project_name}' (batch mode)")

        block_names_ru = {
            'documents': 'договор', 'storyboard': 'раскадровка', 'casting': 'кастинг',
            'location': 'локации', 'props': 'реквизит', 'wardrobe': 'одежда/костюмы',
            'editing': 'монтаж', 'voice': 'войсовер', 'music': 'музыка',
            'color': 'цветокоррекция', 'photos': 'фотографии', 'cg': 'компьютерная графика',
            'animatic': 'аниматик', 'modelling': '3D моделирование',
            'styleshots': 'стайлшоты', 'animation': 'анимация'
        }

        # Detailed descriptions so AI understands what each block means
        block_descriptions = {
            'documents': 'ТОЛЬКО юридические документы: договор, смета, акты, счета, закрывающие документы. НЕ сценарии, НЕ контент.',
            'storyboard': 'ТОЛЬКО текст/содержание сценария. НЕ монтаж, НЕ рыбы, НЕ выпуски.',
            'casting': 'ТОЛЬКО утверждение актёров/героев/экспертов для съёмок. НЕ посты, НЕ контент.',
            'location': 'ТОЛЬКО место съёмок: студия, локация, площадка.',
            'props': 'ТОЛЬКО физический реквизит на площадке: предметы, декорации, элементы сета.',
            'wardrobe': 'ТОЛЬКО одежда/костюмы героев для съёмок.',
            'editing': 'Монтаж видео, сборка, рыбы, смысловой монтаж.',
            'voice': 'Войсовер, озвучка, дикторский текст.',
            'music': 'Музыка, треки, саунд-дизайн, SFX.',
            'color': 'Цветокоррекция, грейдинг готового видео.',
            'photos': 'Фотографии: съёмка, ретушь, отбор фото.',
            'cg': 'Компьютерная графика, CG-заставки, VFX, ИИ-генерация.',
            'animatic': 'Аниматик, раскадровка в движении.',
            'modelling': '3D моделирование объектов.',
            'styleshots': 'Стайлшоты, визуальные референсы стиля.',
            'animation': 'Анимация, моушн-дизайн.',
        }

        block_info = []
        for block in blocks:
            name = block.name if hasattr(block, 'name') else block.get('name')
            block_type = block.type if hasattr(block, 'type') else block.get('type')
            block_id = block.id if hasattr(block, 'id') else block.get('id')
            display = block_names_ru.get(name, name)
            block_info.append({'name': name, 'type': block_type, 'id': block_id, 'display': display})

        blocks_list = "\n".join(
            f"- {b['display']}: {block_descriptions.get(b['name'], '')}" for b in block_info
        )
        expected_keys = ", ".join(f'"{b["display"]}"' for b in block_info)

        glossary_text = self._build_glossary_section()

        prompt = f"""ПЕРЕПИСКА ПРОЕКТА "{project_name}" (от НОВЫХ к старым):
{conversation}

БЛОКИ ПРОЕКТА:
{blocks_list}

ЗАДАЧА: Определи ТЕКУЩИЙ статус КАЖДОГО блока. Верни JSON объект.

ПРАВИЛА:
1. Переписка от НОВЫХ к СТАРЫМ. Бери инфо из САМЫХ СВЕЖИХ сообщений.
2. КРИТИЧНО: Новое ВСЕГДА перекрывает старое. "можно забирать", "получили ок", "согласовано", "утверждено" → итог = "Согласовано"
3. Пиши ТОЛЬКО итог на СЕЙЧАС. НЕ перечисляй историю.
4. Максимум 2 буллета через "- " на блок. Короткие предложения.
5. В конце каждого буллета — тег [#число] из переписки.
6. Блок не упоминается → "информация отсутствует"
7. Без markdown. Без заголовков. Только факты.
8. АБСОЛЮТНЫЙ ЗАПРЕТ НА ГАЛЛЮЦИНАЦИИ:
   - Пиши ТОЛЬКО то, что ЯВНО НАПИСАНО в переписке как ОТВЕТ или РЕШЕНИЕ.
   - ВОПРОС ≠ ОТВЕТ! Если кто-то СПРОСИЛ "а что решили насчет X?" — это НЕ значит, что X решено. Ищи ОТВЕТ на этот вопрос в переписке.
   - Если ответа/решения НЕТ — пиши "информация отсутствует". НЕ додумывай!
   - ЗАПРЕЩЕНО писать "отказались", "решили", "выбрали", "утвердили" если в переписке нет ЯВНОГО сообщения с таким решением.
   - ТЕСТ: для каждого факта в статусе ты должен найти КОНКРЕТНОЕ сообщение [#число] с ОТВЕТОМ (не вопросом). Если не можешь — удали факт.
9. КРИТИЧНО ДЛЯ ПРЕ-ПРОДАКШН: Блоки договор, сценарий, кастинг, костюмы, локация, реквизит — это ПРЕ-продакшн. Если в переписке идёт обсуждение ПОСТ-продакшн (выпуски, монтаж, рыбы, графика, музыка, CG, заставки), значит пре-продакшн УЖЕ ЗАВЕРШЁН. Пиши "Согласовано" для ВСЕХ пре-продакшн блоков, КРОМЕ случаев когда есть КОНКРЕТНАЯ фраза ИМЕННО про этот блок (например "сценарий НЕ утверждён", "проблемы с кастингом", "договор не подписан").
   ВАЖНО: "дедлайн до понедельника", "ОС по рыбам", "возвращаться по выпускам" — это про ПОСТ-продакшн, НЕ про документы/сценарии/кастинг!
   ВАЖНО: Не придумывай факты! Если в переписке НЕТ прямого упоминания проблемы с блоком — пиши "Согласовано".
9. КРИТИЧНО: НЕ ДУБЛИРУЙ! Каждый факт пиши ТОЛЬКО В ОДИН блок. "Клиент будет возвращаться по выпускам частями" → ТОЛЬКО в трейлер/выпуски. НЕ в документы, НЕ в сценарии, НЕ в кастинг.

ФОРМАТ ОТВЕТА (только JSON, без markdown):
{{{expected_keys}}}

Значение каждого ключа — строка со статусом (буллеты через \\n).

Ответ:"""

        messages = [
            SystemMessage(content=f"""Ты — аналитик видеопродакшна. Анализируешь переписку проекта и определяешь статус каждого блока.

{glossary_text}

ГЛАВНОЕ ПРАВИЛО: каждый факт из переписки относится ТОЛЬКО К ОДНОМУ блоку. НЕ копируй одну и ту же информацию в разные блоки.
ВТОРОЕ ПРАВИЛО: НИКОГДА не придумывай факты. Пиши ТОЛЬКО то, что явно написано в сообщениях. Если вопрос задан но ответ не зафиксирован — так и пиши."""),
            HumanMessage(content=prompt)
        ]

        try:
            response = await self.batch_llm.ainvoke(messages)
            raw = response.content.strip()
            if raw.startswith("```"):
                raw = raw.split("\n", 1)[1] if "\n" in raw else raw[3:]
                if raw.endswith("```"):
                    raw = raw[:-3]
                raw = raw.strip()

            parsed = json.loads(raw)
            logger.info(f"Batch analysis result: {json.dumps(parsed, ensure_ascii=False)[:500]}")

            # Map display names back to block IDs
            results = {}
            display_to_info = {b['display']: b for b in block_info}
            for display_name, status in parsed.items():
                info = display_to_info.get(display_name)
                if info:
                    result_key = info['id'] if info['id'] else info['name']
                    cleaned = self._postprocess_status(status)
                    results[result_key] = cleaned
                    logger.info(f"Analyzed {display_name}: {cleaned[:100]}... [key: {result_key}]")

            # Fill in missing blocks
            for b in block_info:
                result_key = b['id'] if b['id'] else b['name']
                if result_key not in results:
                    results[result_key] = "информация отсутствует"
                    logger.warning(f"Block {b['display']} missing from batch response, set to 'информация отсутствует'")

            # Post-processing: fix common AI mistakes
            results = self._postprocess_batch_results(results, block_info)

            return results

        except Exception as e:
            logger.error(f"Batch analysis failed: {e}, falling back to per-block analysis")
            return await self._analyze_blocks_individually(project_name, blocks, conversation)

    def _postprocess_batch_results(self, results: Dict[str, str], block_info: List[Dict]) -> Dict[str, str]:
        """Fix common AI mistakes: wrong categorization and duplication."""
        import re

        # Build type map: block_key -> block_type (pre/post)
        pre_production_keys = set()
        post_production_keys = set()
        PRE_BLOCK_NAMES = {'documents', 'storyboard', 'casting', 'location', 'props', 'wardrobe'}
        for b in block_info:
            key = b['id'] if b['id'] else b['name']
            block_type = b.get('type', '')
            if b['name'] in PRE_BLOCK_NAMES or block_type in ('pre', 'custom_pre', 'standard'):
                # Standard blocks are pre-production by default, custom_pre explicitly
                # But standard post-production blocks (editing, music, etc.) should be post
                POST_BLOCK_NAMES = {'editing', 'voice', 'music', 'color', 'photos', 'cg', 'animatic', 'modelling', 'styleshots', 'animation'}
                if b['name'] in POST_BLOCK_NAMES:
                    post_production_keys.add(key)
                elif block_type == 'custom_post':
                    post_production_keys.add(key)
                else:
                    pre_production_keys.add(key)
            elif block_type == 'custom_post':
                post_production_keys.add(key)
            else:
                post_production_keys.add(key)

        # Post-production keywords that should NOT appear in pre-production blocks
        POST_KEYWORDS = [
            'рыб', 'монтаж', 'выпуск', 'заставк', 'трейлер', 'график', 'музык',
            'цветокоррекц', 'анимац', 'cg', 'vfx', 'озвучк', 'войсовер',
            'мастер', 'превью', 'ролик', 'видео', 'сборк'
        ]

        # Check if there are any post-production blocks with real content
        has_post_content = any(
            key in post_production_keys and results.get(key, '') not in ('информация отсутствует', 'Согласовано', '')
            for key in results
        )

        logger.info(f"Post-process: pre_keys={pre_production_keys}, post_keys={post_production_keys}, has_post={has_post_content}")
        logger.info(f"Post-process: block_info names={[(b['name'], b['type'], b['id']) for b in block_info]}")

        if has_post_content:
            # Fix pre-production blocks that contain post-production info
            for key in pre_production_keys:
                status = results.get(key, '')
                status_lower = status.lower()

                # Check if status contains post-production keywords
                has_post_keyword = any(kw in status_lower for kw in POST_KEYWORDS)

                if has_post_keyword:
                    # Check if there's also genuine pre-production info
                    lines = [l.strip() for l in status.split('\n') if l.strip()]
                    clean_lines = []
                    for line in lines:
                        line_lower = line.lower()
                        if not any(kw in line_lower for kw in POST_KEYWORDS):
                            clean_lines.append(line)

                    if clean_lines:
                        results[key] = '\n'.join(clean_lines)
                        logger.info(f"Post-process: cleaned post-prod keywords from pre-prod block {key}")
                    else:
                        results[key] = '- Согласовано'
                        logger.info(f"Post-process: reset pre-prod block {key} to 'Согласовано' (had only post-prod info)")

        # Anti-hallucination: check for decisive words without message references
        DECISIVE_WORDS = ['отказал', 'решили отказ', 'отменил', 'отменен', 'убрали', 'не будет', 'не будут']
        for key in list(results.keys()):
            status = results.get(key, '')
            if not status or status == 'информация отсутствует' or status == '- Согласовано':
                continue
            lines = [l.strip() for l in status.split('\n') if l.strip()]
            clean_lines = []
            for line in lines:
                line_lower = line.lower()
                has_decisive = any(dw in line_lower for dw in DECISIVE_WORDS)
                has_ref = bool(re.search(r'\[#\d+\]', line))
                if has_decisive and not has_ref:
                    logger.info(f"Post-process: removed hallucination line from {key}: {line[:80]}")
                    continue
                clean_lines.append(line)
            if clean_lines:
                results[key] = '\n'.join(clean_lines)
            else:
                results[key] = 'информация отсутствует'

        # Deduplication: find blocks with very similar content
        from difflib import SequenceMatcher
        keys_list = list(results.keys())
        for i in range(len(keys_list)):
            for j in range(i + 1, len(keys_list)):
                k1, k2 = keys_list[i], keys_list[j]
                s1, s2 = results.get(k1, ''), results.get(k2, '')
                if not s1 or not s2 or s1 == 'информация отсутствует' or s2 == 'информация отсутствует':
                    continue
                if s1 == '- Согласовано' or s2 == '- Согласовано':
                    continue

                similarity = SequenceMatcher(None, s1.lower(), s2.lower()).ratio()
                if similarity > 0.6:
                    # Keep the one in a more specific block, reset the other
                    # Prefer post-production blocks over pre-production
                    if k1 in pre_production_keys and k2 in post_production_keys:
                        results[k1] = '- Согласовано'
                        logger.info(f"Post-process: dedup {k1} (pre) vs {k2} (post), reset {k1}")
                    elif k2 in pre_production_keys and k1 in post_production_keys:
                        results[k2] = '- Согласовано'
                        logger.info(f"Post-process: dedup {k2} (pre) vs {k1} (post), reset {k2}")
                    else:
                        # Both post-production — keep the first, make second generic
                        logger.info(f"Post-process: dedup {k1} vs {k2} (similarity={similarity:.2f})")

        return results

    async def _analyze_blocks_individually(
        self,
        project_name: str,
        blocks: List[Any],
        conversation: str
    ) -> Dict[str, str]:
        """Fallback: analyze blocks one by one if batch fails."""
        results = {}
        for block in blocks:
            block_name = block.name if hasattr(block, 'name') else block.get('name')
            block_type = block.type if hasattr(block, 'type') else block.get('type')
            block_id = block.id if hasattr(block, 'id') else block.get('id')

            prompt = self._create_block_prompt(block_name, block_type, conversation)
            glossary_text = self._build_glossary_section()

            messages = [
                SystemMessage(content=f"""Ты — аналитик. Извлекай ТЕКУЩИЙ статус блока из переписки.
{glossary_text}
ПРАВИЛА (СТРОГО!):
1. Пиши ТОЛЬКО итоговое состояние на СЕЙЧАС.
2. Максимум 2 буллета через "- ".
3. В конце каждого буллета — тег источника [#число].
4. Нет информации → информация отсутствует
5. Переписка от НОВЫХ к СТАРЫМ.
6. НЕ придумывай. Без markdown."""),
                HumanMessage(content=prompt)
            ]
            try:
                response = await self.llm.ainvoke(messages)
                result_key = block_id if block_id else block_name
                results[result_key] = self._postprocess_status(response.content)
            except Exception as e:
                result_key = block_id if block_id else block_name
                results[result_key] = f"Ошибка анализа: {str(e)}"
        return results

    def _postprocess_status(self, raw: str) -> str:
        """Дедупликация и обрезка лишних буллетов."""
        text = raw.strip()

        # Если "информация отсутствует" — вернуть как есть
        if 'информация отсутствует' in text.lower():
            return 'информация отсутствует'

        # Разбиваем на буллеты
        lines = [l.strip() for l in text.split('\n') if l.strip()]
        bullets = []
        current = None
        for line in lines:
            if line.startswith('- '):
                if current:
                    bullets.append(current)
                current = line
            elif current:
                current += ' ' + line
            else:
                # Строка без "- " — оборачиваем
                current = '- ' + line
        if current:
            bullets.append(current)

        # Дедупликация: убираем буллеты с одинаковым текстом (без тегов [#...])
        import re
        seen = set()
        unique_bullets = []
        for b in bullets:
            normalized = re.sub(r'\[#\d+\]', '', b).strip().lower()
            # Убираем пунктуацию для сравнения
            normalized = re.sub(r'[^\w\s]', '', normalized)
            if normalized not in seen:
                seen.add(normalized)
                unique_bullets.append(b)

        # Максимум 3 буллета
        unique_bullets = unique_bullets[:3]

        return '\n'.join(unique_bullets) if unique_bullets else text

    def _create_block_prompt(
        self,
        block_name: str,
        block_type: str,
        conversation: str,
        other_block_names: List[str] = None
    ) -> str:
        # Для стандартных блоков переводим английское имя на русский
        block_names_ru = {
            'documents': 'договор',
            'storyboard': 'раскадровка',
            'casting': 'кастинг',
            'location': 'локации',
            'props': 'реквизит',
            'wardrobe': 'одежда/костюмы',
            'editing': 'монтаж',
            'voice': 'войсовер',
            'music': 'музыка',
            'color': 'цветокоррекция',
            'photos': 'фотографии',
            'cg': 'компьютерная графика',
            'animatic': 'аниматик',
            'modelling': '3D моделирование',
            'styleshots': 'стайлшоты',
            'animation': 'анимация'
        }

        display_name = block_names_ru.get(block_name, block_name)

        # Для блоков с номерами эпизодов добавляем специальную инструкцию
        episode_instruction = ""
        if any(word in display_name.lower() for word in ['выпуск', 'эпизод', 'серия', 'episode']):
            episode_instruction = f"""
ВАЖНО: Этот блок про КОНКРЕТНЫЕ эпизоды "{display_name}".
Пиши ТОЛЬКО про эти эпизоды. Информация про другие эпизоды — НЕ относится к этому блоку.
"""

        other_blocks_text = ""
        if other_block_names:
            other_display = [block_names_ru.get(n, n) for n in other_block_names]
            other_blocks_text = f"\nДРУГИЕ БЛОКИ В ПРОЕКТЕ: {', '.join(other_display)}\nЕсли информация больше подходит к другому блоку — НЕ пиши её здесь.\n"

        prompt = f"""БЛОК: "{display_name}"
{episode_instruction}{other_blocks_text}
ПЕРЕПИСКА (от НОВЫХ к старым):
{conversation}

ЗАДАЧА: Определи ТЕКУЩИЙ статус блока "{display_name}".

ПРАВИЛА:
1. Переписка от НОВЫХ к СТАРЫМ. Бери инфо из САМЫХ СВЕЖИХ сообщений.
2. КРИТИЧНО: Новое ВСЕГДА перекрывает старое. Если сначала "ждем фидбек", а потом "можно забирать" или "получили ок" — итоговый статус = Согласовано. НЕ пиши старый статус!
3. Пиши ТОЛЬКО итог на СЕЙЧАС. НЕ перечисляй историю.
4. Максимум 2 буллета через "- ". Короткие предложения.
5. В конце каждого буллета — тег [#число] из переписки.
6. Блок не упоминается → ответь: информация отсутствует
7. Следующие фразы означают СОГЛАСОВАНО: "можно забирать", "получили ок", "ок от клиента", "согласовано", "утверждено", "одобрено". Если видишь их — пиши "Согласовано".
8. Без markdown. Без заголовков. Только факты.
9. Если в переписке обсуждаются ПОСТ-продакшн блоки (выпуски, монтаж, графика, анимация, музыка), а этот блок — ПРЕ-продакшн (сценарий, кастинг, костюмы, локация, реквизит) и нет ЯВНЫХ проблем с ним — он уже утверждён.
10. НЕ ДУБЛИРУЙ информацию между блоками. Каждый факт относится ТОЛЬКО к одному блоку. Если сообщение не упоминает КОНКРЕТНО "{display_name}" или его синонимы — НЕ используй его для этого блока. Общие фразы типа "клиент вернётся с ОС" без указания блока — ИГНОРИРУЙ.

ПРИМЕРЫ:
Блок не упоминается → информация отсутствует
Ждём ОС → - Ждем ОС от клиента [#102]
Одобрено → - Согласовано [#55]
В работе → - В работе, первая версия к 18:00 [#200]
Сначала "ждем фидбек" потом "можно забирать" → - Согласовано [#200]
Сначала "ждем ОС" потом "получили ок" → - Согласовано [#201]

Ответ:"""

        return prompt

    async def answer_question(
        self,
        project_name: str,
        question: str,
        conversation: str,
        message_count: int,
        previous_qa: dict = None
    ) -> dict:
        glossary_text = self._build_glossary_section()

        previous_context = ""
        if previous_qa:
            previous_context = f"""
ПРЕДЫДУЩИЙ ВОПРОС ПОЛЬЗОВАТЕЛЯ: {previous_qa['question']}
ПРЕДЫДУЩИЙ ОТВЕТ БОТА: {previous_qa['answer']}

⚠️ Учитывай предыдущий диалог! Текущий вопрос может быть уточнением или продолжением предыдущего.
"""

        prompt = f"""Ты - ассистент проектного менеджера. Твоя задача - ответить на вопрос используя ТОЛЬКО информацию из переписки.

{glossary_text}

ПРОЕКТ: "{project_name}"
{previous_context}
ВОПРОС: {question}

ПЕРЕПИСКА ({message_count} сообщений):
{conversation}

═══════════════════════════════════════════
🚨 КРИТИЧЕСКИ ВАЖНЫЕ ПРАВИЛА 🚨
═══════════════════════════════════════════

1. ⛔ СТРОГО ЗАПРЕЩЕНО придумывать информацию, которой НЕТ в переписке
2. ⛔ СТРОГО ЗАПРЕЩЕНО добавлять от себя предположения или советы

3. ✅ ЕСЛИ ИНФОРМАЦИЯ ЕСТЬ В ПЕРЕПИСКЕ:
   - Отвечай четко и коротко (1-3 предложения)
   - ЦИТИРУЙ ключевую часть сообщения (что именно написал человек)
   - В конце цитаты указывай [#ID] сообщения (ID берётся из тегов [#12345] в начале сообщений)
   - Можешь указать даты/время и имя отправителя если это важно
   - Если есть ссылки - обязательно включи их

4. ✅ ЕСЛИ ИНФОРМАЦИИ НЕТ ИЛИ НЕДОСТАТОЧНО:
   - Ответь: "NEED_MORE_CONTEXT: [краткое объяснение что именно не нашел]"
   - Например: "NEED_MORE_CONTEXT: В доступной переписке нет упоминаний о переносе сроков"

5. ✅ ФОРМАТИРОВАНИЕ (Telegram HTML):
   - Используй <b>жирный</b> для имён людей и ключевых фактов
   - Цитаты оборачивай в «кавычки»
   - Для списков используй • (bullet point)
   - НЕ используй Markdown (*, **, #). Только HTML-теги: <b>, <i>, <a href="">

6. ✅ СПЕЦИАЛЬНЫЕ СЛУЧАИ:
   - Если вопрос про ссылки/материалы - ищи https://, drive.google, miro, notion, etc
   - Если вопрос про людей - ищи имена, никнеймы, упоминания
   - Если вопрос про даты - ищи даты, числа, слова "завтра", "послезавтра", etc

═══════════════════════════════════════════
📋 ПРИМЕРЫ ПРАВИЛЬНЫХ ОТВЕТОВ
═══════════════════════════════════════════

ПРИМЕР 1 - Информация найдена:
Вопрос: Когда клиент согласовал ролики?
Переписка: [...[#34500][Продюсер]: Клиент посмотрел ролики и сказал супер 24.12...]
Ответ: Клиент согласовал ролики <b>24 декабря</b>. Продюсер написал: «Клиент посмотрел ролики и сказал супер» [#34500]

ПРИМЕР 1.5 - Вопрос про детали:
Вопрос: Что по кастингу, кого утвердили?
Переписка: [...[#25598][Менеджер]: На роль главной героини утвердили Иванову Анну, клиент согласовал...]
Ответ: На роль главной героини утвердили <b>Иванову Анну</b>. Менеджер: «На роль главной героини утвердили Иванову Анну, клиент согласовал» [#25598]

ПРИМЕР 2 - Информация не найдена (нужно больше контекста):
Вопрос: Когда были съемки?
Переписка: [...обсуждают локации и кастинг...]
Ответ: NEED_MORE_CONTEXT: В доступной переписке нет информации о датах съемок

ПРИМЕР 3 - Ссылки найдены:
Вопрос: Отправь ссылки на материалы
Переписка: [...Вот статика: https://drive.google.com/xxxxx...]
Ответ: Вот ссылки на материалы: https://drive.google.com/xxxxx

═══════════════════════════════════════════

ТЕПЕРЬ ОТВЕТЬ НА ВОПРОС:
"""

        try:
            response = await self.llm.ainvoke(prompt)
            answer = response.content.strip()

            needs_more = "NEED_MORE_CONTEXT" in answer

            if needs_more:
                # Убираем тег из любого места в ответе
                answer = answer.replace("NEED_MORE_CONTEXT:", "").strip()
                # Если AI дал полезный текст перед тегом — оставляем его
                # Убираем пустые строки подряд
                answer = "\n".join(line for line in answer.split("\n") if line.strip())
                logger.info(f"AI needs more context ({message_count} msgs): {answer}")
            else:
                logger.info(f"AI answered using {message_count} messages")

            return {
                "answer": answer,
                "needsMore": needs_more
            }

        except Exception as e:
            logger.error(f"Error in answer_question: {e}")
            return {
                "answer": f"Произошла ошибка при анализе переписки: {str(e)}",
                "needsMore": False
            }

    async def classify_dashboard_statuses(
        self,
        blocks: List[Dict[str, str]]
    ) -> Dict[str, str]:
        block_names = [b['name'] for b in blocks]
        blocks_text = "\n".join(
            f"- Блок \"{b['name']}\" ({'документы' if b.get('isDocuments') else 'другой'}): {b['status']}"
            for b in blocks
        )

        expected_keys = ", ".join(f'"{name}"' for name in block_names)

        prompt = f"""Классифицируй статус каждого блока проекта в категорию для дашборда.

БЛОКИ И ИХ ТЕКУЩИЕ СТАТУСЫ:
{blocks_text}

КАТЕГОРИИ:

Для блоков типа "документы":
- Мы готовим документы
- Ждём документы от вас
- Вносятся правки
- На подписании
- Подписаны
- Не определён

Для всех остальных блоков:
- Мы готовим материалы
- Ждём ваш фидбек
- Мы вносим правки
- Утверждено
- Не определён

ПРАВИЛА:
1. Выбери ОДНУ наиболее подходящую категорию для каждого блока
2. Если статус "информация отсутствует" - "Не определён"
3. "Согласовано" = "Утверждено" (или "Подписаны" для документов)
4. Если статус противоречивый — выбери тот, что отражает ТЕКУЩЕЕ состояние

ВАЖНО: Ключи в JSON должны быть ТОЧНО именами блоков: {expected_keys}
НЕ используй текст статуса как ключ. Ключ = имя блока, значение = категория.

Верни JSON объект (только JSON, без markdown):
{{"название_блока": "категория", ...}}"""

        try:
            response = await self.llm.ainvoke(prompt)
            raw = response.content.strip()
            if raw.startswith("```"):
                raw = raw.split("\n", 1)[1] if "\n" in raw else raw[3:]
                if raw.endswith("```"):
                    raw = raw[:-3]
                raw = raw.strip()

            result = json.loads(raw)
            logger.info(f"Dashboard statuses classified: {result}")
            return result
        except Exception as e:
            logger.error(f"Error classifying dashboard statuses: {e}")
            return {}

    async def classify_intent(
        self,
        message: str,
        project_name: str
    ) -> str:
        prompt = f"""Классифицируй сообщение пользователя. Контекст: пользователь ВЕДЁТ ДИАЛОГ о проекте "{project_name}".

Сообщение: "{message}"

Ответь ОДНИМ словом:
- PROJECT_QUESTION — вопрос или уточнение про ЭТОТ проект. Включает: детали, сроки, люди, материалы, ссылки, согласования, кастинг, монтаж, съёмки. Примеры: "что по музыке?", "когда съёмки?", "а ссылки есть?", "а что по кастингу?", "есть ли материалы?", "кто утверждён?", "в вк нет разве?", "а монтажные версии?". ВАЖНО: если вопрос может относиться к проекту — это PROJECT_QUESTION, даже если он короткий!
- CORRECTION — пользователь ЯВНО ПРОСИТ ИЗМЕНИТЬ статус ("поменяй на согласовано", "поставь зелёный", "обнови статус"). ВАЖНО: наблюдение или комментарий ("реквизит уже согласован", "съёмки прошли") — это НЕ коррекция, а PROJECT_QUESTION!
- PROJECT_SWITCH — вопрос про ДРУГИЕ проекты ("какие ещё проекты?", "а другие?", "что ещё в работе?")
- GENERAL — ТОЛЬКО приветствие, благодарность, болтовня НЕ связанная с проектом ("привет", "спасибо", "как дела?", "пока")

⚠️ При сомнении между PROJECT_QUESTION и GENERAL — выбирай PROJECT_QUESTION (пользователь ведёт диалог о проекте!)

Ответ:"""

        try:
            response = await self.llm.ainvoke(prompt)
            result = response.content.strip().upper()
            if "PROJECT_QUESTION" in result:
                return "PROJECT_QUESTION"
            if "CORRECTION" in result:
                return "CORRECTION"
            if "PROJECT_SWITCH" in result:
                return "PROJECT_SWITCH"
            return "GENERAL"
        except Exception as e:
            logger.error(f"Error in classify_intent: {e}")
            return "GENERAL"
