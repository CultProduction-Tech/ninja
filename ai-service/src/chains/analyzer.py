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
            max_tokens=200,
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
            current_status = block.currentStatus if hasattr(block, 'currentStatus') else block.get('currentStatus')

            logger.info(f"Analyzing block: {block_name} ({block_type})")

            prompt = self._create_block_prompt(block_name, block_type, current_status, conversation)

            glossary_text = self._build_glossary_section()

            messages = [
                SystemMessage(content=f"""Ты — эксперт-аналитик проектных коммуникаций.

{glossary_text}

КРИТИЧЕСКИЕ ТРЕБОВАНИЯ:
1. Анализируй ТОЛЬКО то, что ЯВНО написано в переписке
2. НЕ придумывай, НЕ додумывай, НЕ предполагай
3. Если информации нет - пиши РОВНО "информация отсутствует" (3 слова)
4. Если информация есть - ВСЕГДА пиши буллетами через "- " (каждый факт на новой строке). Максимум 3-4 буллета, каждый — одно короткое предложение
5. СТРОГО ЗАПРЕЩЕНО markdown (**, *, ##, _, и т.д.) - только простой текст
6. БЕЗ заголовков типа "Статус:", "Текущее состояние:" - сразу к делу
7. Живой профессиональный язык: "ждем ОС", "окнули", "в работе"
8. ССЫЛКИ НА ИСТОЧНИКИ: каждое сообщение в переписке помечено тегом [#число]. В конце каждого буллета добавь тег самого релевантного сообщения. Пример: "- Ждем ОС от клиента [#245]"

Твоя задача - быть максимально точным и не засорять статусы пустой информацией."""),
                HumanMessage(content=prompt)
            ]

            try:
                response = await self.llm.ainvoke(messages)

                result_key = block_id if block_id else block_name

                results[result_key] = response.content

                logger.info(f"Analyzed {block_name}: {response.content[:100]}... [key: {result_key}]")

            except Exception as e:
                logger.error(f"Error analyzing block {block_name}: {e}")
                result_key = block_id if block_id else block_name
                results[result_key] = f"Ошибка анализа: {str(e)}"

        return results

    def _create_block_prompt(
        self,
        block_name: str,
        block_type: str,
        current_status: Optional[str],
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

        prompt = f"""Ты - эксперт по анализу проектных коммуникаций. Твоя задача - извлечь ТОЧНЫЙ статус блока из переписки.

АНАЛИЗИРУЕМЫЙ БЛОК: "{display_name}"

ПЕРЕПИСКА (от новых к старым сообщениям):
{conversation}

Текущий статус в БД: {current_status or 'не указан'}

═══════════════════════════════════════════
🎯 ГЛАВНАЯ ЗАДАЧА
═══════════════════════════════════════════

Прочитай ВСЮ переписку внимательно и найди ПОСЛЕДНЮЮ актуальную информацию по блоку "{display_name}".
Сфокусируйся на СВЕЖИХ сообщениях (в начале переписки) - они важнее старых.

⚠️ ВАЖНО: Ищи упоминания блока по:
- Полному названию: "{display_name}"
- Частям названия (например: "Подбор музыки" → ищи "музыка", "подбор", "трек")
- Синонимам и смыслу (например: "монтаж"="склейка"="edit", "кастинг"="актеры")

═══════════════════════════════════════════
🚨 КРИТИЧЕСКИ ВАЖНЫЕ ПРАВИЛА
═══════════════════════════════════════════

1. ⛔ СТРОГО ЗАПРЕЩЕНО:
   - Придумывать информацию, которой НЕТ в переписке
   - Делать выводы на основе предположений
   - Писать объяснения типа "потому что...", "так как..."
   - Использовать слова "вероятно", "возможно", "похоже"

2. ✅ ПРАВИЛО "ИНФОРМАЦИЯ ОТСУТСТВУЕТ":
   Если блок "{display_name}" НЕ обсуждается в переписке - верни РОВНО 3 слова:
   "информация отсутствует"

   ⚠️ НО ПЕРЕД ЭТИМ:
   - Проверь ВСЕ сообщения, включая старые
   - Ищи синонимы и косвенные упоминания
   - Проверь упоминания дат/дедлайнов связанных с этим блоком

3. ✅ ЕСЛИ БЛОК ОБСУЖДАЕТСЯ:
   - Напиши ТОЛЬКО факты из последних сообщений
   - ВСЕГДА используй буллеты через "- " (каждый факт с новой строки)
   - Максимум 3-4 буллета, каждый — одно короткое предложение
   - Укажи КОНКРЕТИКУ: что ждем, от кого, когда
   - Используй даты из переписки: "24.12", "завтра", "к вечеру"
   - Живой язык: "ждем ОС", "окнули", "в работе"

═══════════════════════════════════════════
📋 СТАТУСЫ СОГЛАСОВАНИЯ (ВАЖНО!)
═══════════════════════════════════════════

⚠️ ОСТОРОЖНО! НЕ путай "отправили" с "согласовано":

❌ НЕ СОГЛАСОВАНО (не пиши "Согласовано"):
- "Отправили на проверку"
- "Ждем ОС от клиента"
- "Клиент посмотрит позже"
- "Перенесли на завтра"
- "На согласовании"

✅ СОГЛАСОВАНО (можно писать "Согласовано"):
- "Клиент одобрил"
- "Клиент окнул / сказал ок"
- "Клиент дал добро"
- "Финальное утверждение от клиента"

═══════════════════════════════════════════
✅ ПРИМЕРЫ ПРАВИЛЬНЫХ ОТВЕТОВ
═══════════════════════════════════════════

ПРИМЕР 1 - НЕТ упоминаний:
Переписка: Обсуждают только локации и договор
Блок: "монтаж"
✅ Ответ: информация отсутствует

ПРИМЕР 2 - Ждем согласования (несколько фактов → буллеты):
Переписка: "[#101][Продюсер]: Отправили статику 24.12
            [#102][Клиент]: Спасибо, посмотрю после праздников 12-13 января"
Блок: "раскадровка"
✅ Ответ:
- Отправили 24.12 [#101]
- Ждем ОС от клиента (перенесено на 12-13 января) [#102]

ПРИМЕР 3 - Согласовано:
Переписка: "[#55][Клиент]: Посмотрел стайлшоты, супер! Можно продолжать"
Блок: "стайлшоты"
✅ Ответ:
- Согласовано клиентом [#55]

ПРИМЕР 4 - В работе:
Переписка: "[#200][Продюсер]: Начали монтаж, сегодня будет первая версия к 18:00"
Блок: "монтаж"
✅ Ответ:
- В работе, первая версия сегодня к 18:00 [#200]

ПРИМЕР 5 - Косвенное упоминание:
Переписка: "[#301][Продюсер]: Актеры нашлись, проведем коллбек 5 марта"
Блок: "кастинг"
✅ Ответ:
- Актеры найдены, коллбек 5 марта [#301]

═══════════════════════════════════════════
❌ ПРИМЕРЫ НЕПРАВИЛЬНЫХ ОТВЕТОВ
═══════════════════════════════════════════

❌ "Блок не обсуждается в данной переписке"
✅ Правильно: "информация отсутствует"

❌ "Согласовано" (когда только отправили на проверку)
✅ Правильно: "На согласовании у клиента"

❌ "Статус не ясен, возможно в работе"
✅ Правильно: "информация отсутствует" (нет конкретики)

❌ "**Статус:** Ждем обратную связь" (markdown!)
✅ Правильно: "Ждем обратную связь от клиента"

═══════════════════════════════════════════

ТЕПЕРЬ ПРОАНАЛИЗИРУЙ ПЕРЕПИСКУ ДЛЯ БЛОКА "{display_name}".
Помни: сначала ищи упоминания во ВСЕЙ переписке, и только если их точно нет - пиши "информация отсутствует".
"""

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
   - Можешь процитировать конкретные сообщения
   - Можешь указать даты/время если это важно
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
Переписка: [...Татьяна: Клиент посмотрел ролики и сказал супер 24.12...]
Ответ: Клиент согласовал ролики 24 декабря. Сказал что все супер.

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

            needs_more = answer.startswith("NEED_MORE_CONTEXT:")

            if needs_more:
                answer = answer.replace("NEED_MORE_CONTEXT:", "").strip()
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
