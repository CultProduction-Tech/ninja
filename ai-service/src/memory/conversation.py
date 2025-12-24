from typing import Dict, List
from collections import defaultdict
from loguru import logger


class ConversationMemory:
    """
    Simple in-memory conversation storage.
    For production, use Redis or database.
    """

    def __init__(self, max_messages: int = 10):
        self.conversations: Dict[str, List[Dict[str, str]]] = defaultdict(list)
        self.max_messages = max_messages

    def add_message(self, user_id: str, role: str, content: str):
        """Add a message to conversation history."""
        self.conversations[user_id].append({
            'role': role,
            'content': content
        })

        # Keep only last N messages
        if len(self.conversations[user_id]) > self.max_messages:
            self.conversations[user_id] = self.conversations[user_id][-self.max_messages:]

        logger.debug(f"Added {role} message for user {user_id}")

    def get_history(self, user_id: str) -> List[Dict[str, str]]:
        """Get conversation history for a user."""
        return self.conversations.get(user_id, [])

    def clear_history(self, user_id: str):
        """Clear conversation history for a user."""
        if user_id in self.conversations:
            del self.conversations[user_id]
            logger.info(f"Cleared history for user {user_id}")
