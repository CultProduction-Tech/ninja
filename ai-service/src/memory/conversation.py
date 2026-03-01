from typing import Dict, List
from collections import defaultdict
from loguru import logger


class ConversationMemory:

    def __init__(self, max_messages: int = 10):
        self.conversations: Dict[str, List[Dict[str, str]]] = defaultdict(list)
        self.max_messages = max_messages

    def add_message(self, user_id: str, role: str, content: str):
        self.conversations[user_id].append({
            'role': role,
            'content': content
        })

        if len(self.conversations[user_id]) > self.max_messages:
            self.conversations[user_id] = self.conversations[user_id][-self.max_messages:]

        logger.debug(f"Added {role} message for user {user_id}")

    def get_history(self, user_id: str) -> List[Dict[str, str]]:
        return self.conversations.get(user_id, [])

    def clear_history(self, user_id: str):
        if user_id in self.conversations:
            del self.conversations[user_id]
            logger.info(f"Cleared history for user {user_id}")
