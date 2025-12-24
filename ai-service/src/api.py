from fastapi import FastAPI, HTTPException
from pydantic import BaseModel
from typing import Optional, Dict, Any, List
import uvicorn
from loguru import logger

from .chains.analyzer import StatusAnalyzer
from .memory.conversation import ConversationMemory

app = FastAPI(title="Ninja Status AI Service", version="1.0.0")

# Initialize services
status_analyzer = StatusAnalyzer()
conversation_memory = ConversationMemory()


# Request/Response models
class StatusAnalysisRequest(BaseModel):
    projectId: int
    projectName: str
    currentStatus: Dict[str, Any]
    conversation: str


class StatusAnalysisResponse(BaseModel):
    doc: Optional[str] = None
    storyboard_client: Optional[str] = None
    storyboard_cult: Optional[str] = None
    aigen_client: Optional[str] = None
    aigen_cult: Optional[str] = None
    casting_client: Optional[str] = None
    casting_cult: Optional[str] = None
    clothes_client: Optional[str] = None
    clothes_cult: Optional[str] = None
    props_client: Optional[str] = None
    props_cult: Optional[str] = None
    location_client: Optional[str] = None
    location_cult: Optional[str] = None
    animatic_client: Optional[str] = None
    animatic_cult: Optional[str] = None
    modelling_client: Optional[str] = None
    modelling_cult: Optional[str] = None
    styleshots_client: Optional[str] = None
    styleshots_cult: Optional[str] = None
    animation_client: Optional[str] = None
    animation_cult: Optional[str] = None
    editing_client: Optional[str] = None
    editing_cult: Optional[str] = None
    music_client: Optional[str] = None
    music_cult: Optional[str] = None
    vo_client: Optional[str] = None
    vo_cult: Optional[str] = None
    colorgrading_client: Optional[str] = None
    colorgrading_cult: Optional[str] = None
    photos_client: Optional[str] = None
    photos_cult: Optional[str] = None
    cg_client: Optional[str] = None
    cg_cult: Optional[str] = None


class ChatRequest(BaseModel):
    userId: str
    message: str


class ChatContextRequest(BaseModel):
    userId: str
    message: str
    userType: str  # "producer", "client", or "unknown"
    projects: List[Dict[str, Any]]


class ChatResponse(BaseModel):
    answer: str


class StageAnalysisRequest(BaseModel):
    stage: str
    conversation: str
    currentValue: Optional[str] = None


class BlockInfo(BaseModel):
    name: str
    type: str  # "standard", "custom_pre", "custom_post"
    id: Optional[str] = None
    currentStatus: Optional[str] = None


class DynamicBlocksRequest(BaseModel):
    projectId: int
    projectName: str
    blocks: List[BlockInfo]
    conversation: str


# Endpoints
@app.get("/")
async def root():
    return {"service": "ninja-ai-service", "status": "ok"}


@app.get("/health")
async def health():
    return {"status": "healthy"}


@app.post("/analyze/status", response_model=StatusAnalysisResponse)
async def analyze_status(request: StatusAnalysisRequest):
    """
    Main endpoint to analyze project status from conversation.
    Replaces the 19 LLM chains from n8n Status Update workflow.
    """
    try:
        logger.info(f"Analyzing status for project {request.projectId}")

        result = await status_analyzer.analyze_all_stages(
            project_name=request.projectName,
            current_status=request.currentStatus,
            conversation=request.conversation
        )

        return StatusAnalysisResponse(**result)

    except Exception as e:
        logger.error(f"Error analyzing status: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/chat", response_model=ChatResponse)
async def chat(request: ChatRequest):
    """
    Producer Agent chat endpoint with conversation memory.
    """
    try:
        logger.info(f"Chat request from user {request.userId}")

        # Get conversation history
        history = conversation_memory.get_history(request.userId)

        # Generate response
        response = await status_analyzer.chat(
            user_id=request.userId,
            message=request.message,
            history=history
        )

        # Save to memory
        conversation_memory.add_message(request.userId, "user", request.message)
        conversation_memory.add_message(request.userId, "assistant", response)

        return ChatResponse(answer=response)

    except Exception as e:
        logger.error(f"Error in chat: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/chat/context", response_model=ChatResponse)
async def chat_with_context(request: ChatContextRequest):
    """
    Smart Bot chat with user context (producer/client) and projects.
    Responds differently based on user type.
    """
    try:
        logger.info(f"Chat with context from {request.userType} {request.userId}")

        # Get conversation history
        history = conversation_memory.get_history(request.userId)

        # Generate response with context
        response = await status_analyzer.chat_with_context(
            user_id=request.userId,
            message=request.message,
            history=history,
            user_type=request.userType,
            projects=request.projects
        )

        # Save to memory
        conversation_memory.add_message(request.userId, "user", request.message)
        conversation_memory.add_message(request.userId, "assistant", response)

        return ChatResponse(answer=response)

    except Exception as e:
        logger.error(f"Error in chat with context: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/analyze/stage")
async def analyze_stage(request: StageAnalysisRequest):
    """
    Analyze a specific project stage.
    """
    try:
        logger.info(f"Analyzing stage: {request.stage}")

        result = await status_analyzer.analyze_single_stage(
            stage=request.stage,
            conversation=request.conversation,
            current_value=request.currentValue
        )

        return result

    except Exception as e:
        logger.error(f"Error analyzing stage {request.stage}: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/analyze/dynamic-blocks")
async def analyze_dynamic_blocks(request: DynamicBlocksRequest):
    """
    🆕 NEW: Analyze dynamic blocks from Dashboard.
    Only analyzes blocks that are active for this specific project.
    Supports both standard and custom blocks.
    """
    try:
        logger.info(f"Analyzing {len(request.blocks)} dynamic blocks for project {request.projectName}")

        # Log blocks being analyzed
        for block in request.blocks:
            logger.info(f"  - {block.name} ({block.type})")

        result = await status_analyzer.analyze_dynamic_blocks(
            project_name=request.projectName,
            blocks=request.blocks,
            conversation=request.conversation
        )

        return result

    except Exception as e:
        logger.error(f"Error analyzing dynamic blocks: {e}")
        raise HTTPException(status_code=500, detail=str(e))


if __name__ == "__main__":
    uvicorn.run(app, host="0.0.0.0", port=8000)
