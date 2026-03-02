from fastapi import FastAPI, HTTPException
from pydantic import BaseModel
from typing import Optional, Dict, Any, List
import uvicorn
from loguru import logger

from .chains.analyzer import StatusAnalyzer
from .memory.conversation import ConversationMemory

app = FastAPI(title="Ninja Status AI Service", version="1.0.0")

status_analyzer = StatusAnalyzer()
conversation_memory = ConversationMemory()


class ChatRequest(BaseModel):
    userId: str
    message: str


class ChatContextRequest(BaseModel):
    userId: str
    message: str
    userType: str
    projects: List[Dict[str, Any]]


class ChatResponse(BaseModel):
    answer: str


class BlockInfo(BaseModel):
    name: str
    type: str
    id: Optional[str] = None
    currentStatus: Optional[str] = None


class DynamicBlocksRequest(BaseModel):
    projectId: int
    projectName: str
    blocks: List[BlockInfo]
    conversation: str


class QuestionRequest(BaseModel):
    projectName: str
    question: str
    conversation: str
    messageCount: int


class QuestionResponse(BaseModel):
    answer: str
    needsMore: bool


@app.get("/")
async def root():
    return {"service": "ninja-ai-service", "status": "ok"}


@app.get("/health")
async def health():
    return {"status": "healthy"}


@app.post("/chat", response_model=ChatResponse)
async def chat(request: ChatRequest):
    try:
        logger.info(f"Chat request from user {request.userId}")

        history = conversation_memory.get_history(request.userId)

        response = await status_analyzer.chat(
            user_id=request.userId,
            message=request.message,
            history=history
        )

        conversation_memory.add_message(request.userId, "user", request.message)
        conversation_memory.add_message(request.userId, "assistant", response)

        return ChatResponse(answer=response)

    except Exception as e:
        logger.error(f"Error in chat: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/chat/context", response_model=ChatResponse)
async def chat_with_context(request: ChatContextRequest):
    try:
        logger.info(f"Chat with context from {request.userType} {request.userId}")

        history = conversation_memory.get_history(request.userId)

        response = await status_analyzer.chat_with_context(
            user_id=request.userId,
            message=request.message,
            history=history,
            user_type=request.userType,
            projects=request.projects
        )

        conversation_memory.add_message(request.userId, "user", request.message)
        conversation_memory.add_message(request.userId, "assistant", response)

        return ChatResponse(answer=response)

    except Exception as e:
        logger.error(f"Error in chat with context: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/analyze/dynamic-blocks")
async def analyze_dynamic_blocks(request: DynamicBlocksRequest):
    try:
        logger.info(f"Analyzing {len(request.blocks)} dynamic blocks for project {request.projectName}")

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


@app.post("/answer/question", response_model=QuestionResponse)
async def answer_question(request: QuestionRequest):
    try:
        logger.info(f"Answering question for project {request.projectName} ({request.messageCount} messages)")

        result = await status_analyzer.answer_question(
            project_name=request.projectName,
            question=request.question,
            conversation=request.conversation,
            message_count=request.messageCount
        )

        return QuestionResponse(**result)

    except Exception as e:
        logger.error(f"Error answering question: {e}")
        raise HTTPException(status_code=500, detail=str(e))


if __name__ == "__main__":
    uvicorn.run(app, host="0.0.0.0", port=8000)
