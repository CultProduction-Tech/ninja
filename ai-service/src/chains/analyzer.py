from typing import Dict, Any, Optional, List
from langchain_openai import ChatOpenAI
from langchain.schema import HumanMessage, SystemMessage, AIMessage
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

            messages = [
                SystemMessage(content="""Ты — эксперт-аналитик проектных коммуникаций.

КРИТИЧЕСКИЕ ТРЕБОВАНИЯ:
1. Анализируй ТОЛЬКО то, что ЯВНО написано в переписке
2. НЕ придумывай, НЕ додумывай, НЕ предполагай
3. Если информации нет - пиши РОВНО "информация отсутствует" (3 слова)
4. Если информация есть - максимум 1-2 четких предложения с фактами
5. СТРОГО ЗАПРЕЩЕНО markdown (**, *, ##, _, и т.д.) - только простой текст
6. БЕЗ заголовков типа "Статус:", "Текущее состояние:" - сразу к делу
7. Живой профессиональный язык: "ждем ОС", "окнули", "в работе"

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
   - Максимум 1-2 предложения
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

ПРИМЕР 2 - Ждем согласования:
Переписка: "[Продюсер]: Отправили статику 24.12
            [Клиент]: Спасибо, посмотрю после праздников 12-13 января"
Блок: "раскадровка"
✅ Ответ: Отправили 24.12, ждем обратную связь от клиента (согласование перенесено на 12-13 января)

ПРИМЕР 3 - Согласовано:
Переписка: "[Клиент]: Посмотрел стайлшоты, супер! Можно продолжать"
Блок: "стайлшоты"
✅ Ответ: Согласовано клиентом

ПРИМЕР 4 - В работе:
Переписка: "[Продюсер]: Начали монтаж, сегодня будет первая версия к 18:00"
Блок: "монтаж"
✅ Ответ: В работе, первая версия сегодня к 18:00

ПРИМЕР 5 - Косвенное упоминание:
Переписка: "[Продюсер]: Актеры нашлись, проведем коллбек 5 марта"
Блок: "кастинг"
✅ Ответ: Актеры найдены, коллбек запланирован на 5 марта

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
        prompt = f"""Ты - ассистент проектного менеджера. Твоя задача - ответить на вопрос используя ТОЛЬКО информацию из переписки.

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
