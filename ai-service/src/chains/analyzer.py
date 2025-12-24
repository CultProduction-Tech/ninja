from typing import Dict, Any, Optional, List
from langchain_openai import ChatOpenAI
from langchain.schema import HumanMessage, SystemMessage, AIMessage
from loguru import logger

from ..config import settings
from ..prompts.templates import (
    STAGE_PROMPTS,
    PRODUCER_SYSTEM_PROMPT,
    CLIENT_SYSTEM_PROMPT,
    UNKNOWN_SYSTEM_PROMPT
)


class StatusAnalyzer:
    def __init__(self):
        # Initialize LLM
        self.llm = ChatOpenAI(
            model=settings.openrouter_model,
            openai_api_key=settings.openrouter_api_key,
            openai_api_base="https://openrouter.ai/api/v1",
            temperature=0.3,
        )

    async def analyze_all_stages(
        self,
        project_name: str,
        current_status: Dict[str, Any],
        conversation: str
    ) -> Dict[str, str]:
        """
        Analyze all project stages from conversation.
        This replaces the 19 LLM chain nodes from n8n.
        """
        results = {}

        # List of all stages to analyze
        stages = [
            'doc',
            'storyboard_client', 'storyboard_cult',
            'aigen_client', 'aigen_cult',
            'casting_client', 'casting_cult',
            'clothes_client', 'clothes_cult',
            'props_client', 'props_cult',
            'location_client', 'location_cult',
            'animatic_client', 'animatic_cult',
            'modelling_client', 'modelling_cult',
            'styleshots_client', 'styleshots_cult',
            'animation_client', 'animation_cult',
            'editing_client', 'editing_cult',
            'music_client', 'music_cult',
            'vo_client', 'vo_cult',
            'colorgrading_client', 'colorgrading_cult',
            'photos_client', 'photos_cult',
            'cg_client', 'cg_cult',
        ]

        logger.info(f"Analyzing {len(stages)} stages for project: {project_name}")

        # Analyze each stage
        for stage in stages:
            try:
                current_value = current_status.get(stage, '')

                result = await self.analyze_single_stage(
                    stage=stage,
                    conversation=conversation,
                    current_value=current_value
                )

                results[stage] = result.get('status', '')

            except Exception as e:
                logger.error(f"Error analyzing stage {stage}: {e}")
                results[stage] = current_status.get(stage, '')  # Keep current value on error

        return results

    async def analyze_single_stage(
        self,
        stage: str,
        conversation: str,
        current_value: Optional[str] = None
    ) -> Dict[str, Any]:
        """
        Analyze a single project stage using LLM.
        """
        # Get prompt template for this stage
        prompt_template = STAGE_PROMPTS.get(stage, STAGE_PROMPTS['default'])

        # Build prompt
        prompt = prompt_template.format(
            stage=stage,
            current_value=current_value or 'Нет данных',
            conversation=conversation
        )

        # Call LLM
        messages = [
            SystemMessage(content="Ты — AI-ассистент для анализа статусов проектов."),
            HumanMessage(content=prompt)
        ]

        response = await self.llm.ainvoke(messages)

        return {
            'status': response.content,
            'stage': stage
        }

    async def chat(
        self,
        user_id: str,
        message: str,
        history: List[Dict[str, str]]
    ) -> str:
        """
        Simple chat endpoint with memory (legacy).
        """
        # Build messages from history
        messages = [
            SystemMessage(content=PRODUCER_SYSTEM_PROMPT)  # Default to producer
        ]

        for msg in history:
            if msg['role'] == 'user':
                messages.append(HumanMessage(content=msg['content']))
            else:
                messages.append(AIMessage(content=msg['content']))

        # Add current message
        messages.append(HumanMessage(content=message))

        # Get response
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
        """
        Chat with user context - responds differently for producers and clients.
        Also searches through user's projects when needed.
        """
        # Choose system prompt based on user type
        if user_type == 'producer':
            system_prompt = PRODUCER_SYSTEM_PROMPT
        elif user_type == 'client':
            system_prompt = CLIENT_SYSTEM_PROMPT
        else:
            system_prompt = UNKNOWN_SYSTEM_PROMPT

        # Add projects context to system prompt
        if projects and len(projects) > 0:
            projects_info = "\n\nВаши проекты:\n"
            for p in projects:
                projects_info += f"- {p.get('project_name', 'Без названия')}\n"

            system_prompt += projects_info

        # Build messages from history
        messages = [
            SystemMessage(content=system_prompt)
        ]

        for msg in history:
            if msg['role'] == 'user':
                messages.append(HumanMessage(content=msg['content']))
            else:
                messages.append(AIMessage(content=msg['content']))

        # Add current message with project context if relevant
        user_message = message

        # If user is asking about specific project, add context
        if projects:
            # Simple project search (можно улучшить)
            for project in projects:
                project_name = project.get('project_name', '')
                if project_name.lower() in message.lower():
                    user_message += f"\n\n[Контекст проекта '{project_name}':\n"
                    user_message += f"Договор: {project.get('doc', 'Нет данных')}\n"
                    user_message += f"Раскадровка: {project.get('storyboard_cult', 'Нет данных')}\n"
                    user_message += f"Монтаж: {project.get('editing_cult', 'Нет данных')}]"
                    break

        messages.append(HumanMessage(content=user_message))

        # Get response
        response = await self.llm.ainvoke(messages)

        return response.content

    async def analyze_dynamic_blocks(
        self,
        project_name: str,
        blocks: List[Any],
        conversation: str
    ) -> Dict[str, str]:
        """
        🆕 NEW: Analyze dynamic blocks from Dashboard.
        Only analyzes blocks that are active for this project.
        Supports both standard and custom blocks.
        """
        results = {}

        logger.info(f"Analyzing {len(blocks)} blocks for project '{project_name}'")

        for block in blocks:
            block_name = block.name if hasattr(block, 'name') else block.get('name')
            block_type = block.type if hasattr(block, 'type') else block.get('type')
            block_id = block.id if hasattr(block, 'id') else block.get('id')
            current_status = block.currentStatus if hasattr(block, 'currentStatus') else block.get('currentStatus')

            logger.info(f"Analyzing block: {block_name} ({block_type})")

            # Create dynamic prompt for this block
            if block_type == 'standard':
                # Standard block - use existing logic
                prompt = self._create_standard_block_prompt(block_name, current_status, conversation)
            else:
                # Custom block - create custom prompt
                prompt = self._create_custom_block_prompt(block_name, current_status, conversation)

            # Analyze
            messages = [
                SystemMessage(content="Ты — аналитик проектных статусов. Анализируй переписку и определяй текущий статус работы."),
                HumanMessage(content=prompt)
            ]

            try:
                response = await self.llm.ainvoke(messages)

                # Use block ID for custom blocks, name for standard
                result_key = block_id if block_id else block_name
                results[result_key] = response.content

                logger.info(f"✓ Analyzed {block_name}: {response.content[:100]}...")

            except Exception as e:
                logger.error(f"Error analyzing block {block_name}: {e}")
                result_key = block_id if block_id else block_name
                results[result_key] = f"Ошибка анализа: {str(e)}"

        return results

    def _create_standard_block_prompt(
        self,
        block_name: str,
        current_status: Optional[str],
        conversation: str
    ) -> str:
        """Create prompt for standard block analysis"""

        # Map Dashboard block names to human-readable Russian names
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

        block_name_ru = block_names_ru.get(block_name, block_name)

        prompt = f"""Проанализируй переписку и определи текущий статус этапа "{block_name_ru}".

Переписка:
{conversation}

Текущий статус: {current_status or 'не указан'}

Твоя задача: написать КРАТКИЙ и ТОЧНЫЙ статус этого этапа на основе переписки.

Формат ответа (1-3 предложения):
- Что сейчас происходит на этом этапе
- Что ждем от клиента (если ждем)
- Когда планируется завершение (если упоминается)

Если в переписке нет информации об этом этапе, напиши "информация отсутствует"."""

        return prompt

    def _create_custom_block_prompt(
        self,
        block_name: str,
        current_status: Optional[str],
        conversation: str
    ) -> str:
        """Create prompt for custom block analysis"""

        prompt = f"""Проанализируй переписку и определи текущий статус задачи "{block_name}".

Переписка:
{conversation}

Текущий статус: {current_status or 'не указан'}

Твоя задача: написать КРАТКИЙ и ТОЧНЫЙ статус этой задачи на основе переписки.

Формат ответа (1-3 предложения):
- Что сейчас происходит с этой задачей
- Что ждем от клиента/команды (если ждем)
- Когда планируется завершение (если упоминается)

Если в переписке нет информации об этой задаче, напиши "информация отсутствует"."""

        return prompt
