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
        results = {}

        logger.info(f"Analyzing {len(blocks)} blocks for project '{project_name}'")

        for block in blocks:
            block_name = block.name if hasattr(block, 'name') else block.get('name')
            block_type = block.type if hasattr(block, 'type') else block.get('type')
            block_id = block.id if hasattr(block, 'id') else block.get('id')
            logger.info(f"Analyzing block: {block_name} ({block_type})")

            prompt = self._create_block_prompt(block_name, block_type, conversation)

            # Debug: log full prompt for scenario-like blocks
            if any(kw in block_name.lower() for kw in ['сценар', 'костюм', 'реквизит']):
                logger.info(f"=== DEBUG PROMPT for {block_name} ===")
                logger.info(f"PROMPT:\n{prompt[:2000]}")
                logger.info(f"=== END DEBUG PROMPT ===")

            glossary_text = self._build_glossary_section()

            messages = [
                SystemMessage(content=f"""Ты — аналитик. Извлекай ТЕКУЩИЙ статус блока из переписки.

{glossary_text}

ПРАВИЛА (СТРОГО!):
1. Пиши ТОЛЬКО итоговое состояние на СЕЙЧАС. НЕ перечисляй историю.
2. Максимум 2 буллета через "- ". Каждый — одно короткое предложение.
3. В конце каждого буллета — тег источника [#число].
4. Нет информации о блоке → пиши ровно: информация отсутствует
5. Переписка идёт от НОВЫХ к СТАРЫМ. Бери ТОЛЬКО из самых свежих сообщений.
6. НЕ придумывай. Без markdown. Без заголовков. Только факты."""),
                HumanMessage(content=prompt)
            ]

            try:
                response = await self.llm.ainvoke(messages)

                result_key = block_id if block_id else block_name

                raw_response = response.content
                cleaned = self._postprocess_status(raw_response)
                results[result_key] = cleaned

                # Debug: log raw vs cleaned for problematic blocks
                if any(kw in block_name.lower() for kw in ['сценар', 'костюм', 'реквизит']):
                    logger.info(f"=== DEBUG RESPONSE for {block_name} ===")
                    logger.info(f"RAW: {raw_response}")
                    logger.info(f"CLEANED: {cleaned}")
                    logger.info(f"=== END DEBUG RESPONSE ===")

                logger.info(f"Analyzed {block_name}: {cleaned[:100]}... [key: {result_key}]")

            except Exception as e:
                logger.error(f"Error analyzing block {block_name}: {e}")
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
        conversation: str
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

        prompt = f"""БЛОК: "{display_name}"
{episode_instruction}
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
        message_count: int
    ) -> dict:
        glossary_text = self._build_glossary_section()

        prompt = f"""Ты - ассистент проектного менеджера. Твоя задача - ответить на вопрос используя ТОЛЬКО информацию из переписки.

{glossary_text}

ПРОЕКТ: "{project_name}"

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

5. ✅ СПЕЦИАЛЬНЫЕ СЛУЧАИ:
   - Если вопрос про ссылки/материалы - ищи https://, drive.google, miro, notion, etc
   - Если вопрос про людей - ищи имена, никнеймы, упоминания
   - Если вопрос про даты - ищи даты, числа, слова "завтра", "послезавтра", etc

═══════════════════════════════════════════
📋 ПРИМЕРЫ ПРАВИЛЬНЫХ ОТВЕТОВ
═══════════════════════════════════════════

ПРИМЕР 1 - Информация найдена:
Вопрос: Когда клиент согласовал ролики?
Переписка: [...[#34500][Продюсер]: Клиент посмотрел ролики и сказал супер 24.12...]
Ответ: Клиент согласовал ролики 24 декабря. Продюсер написал: «Клиент посмотрел ролики и сказал супер» [#34500]

ПРИМЕР 1.5 - Вопрос про детали:
Вопрос: Что по кастингу, кого утвердили?
Переписка: [...[#25598][Менеджер]: На роль главной героини утвердили Иванову Анну, клиент согласовал...]
Ответ: На роль главной героини утвердили Иванову Анну. Менеджер: «На роль главной героини утвердили Иванову Анну, клиент согласовал» [#25598]

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

    async def classify_intent(
        self,
        message: str,
        project_name: str
    ) -> str:
        prompt = f"""Классифицируй сообщение пользователя. Контекст: пользователь только что смотрел статус проекта "{project_name}".

Сообщение: "{message}"

Ответь ОДНИМ словом:
- PROJECT_QUESTION — вопрос про ЭТОТ проект (детали, сроки, люди, материалы, согласования, "что по музыке?", "когда съёмки?")
- CORRECTION — пользователь ЯВНО ПРОСИТ ИЗМЕНИТЬ статус ("поменяй на согласовано", "поставь зелёный", "обнови статус"). ВАЖНО: наблюдение или комментарий ("реквизит уже согласован", "съёмки прошли", "музыка утверждена") — это НЕ коррекция, а PROJECT_QUESTION!
- PROJECT_SWITCH — вопрос про ДРУГИЕ проекты ("какие ещё проекты?", "а другие?", "что ещё в работе?")
- GENERAL — всё остальное (приветствие, благодарность, болтовня, "как дела?", "спасибо")

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
