"""
Авто-обнаруженные термины глоссария.
Хранятся в ai-service/data/discovered_glossary.json.
Админ одобряет/отклоняет через Telegram.
"""

import json
import os
from typing import Dict, List, Optional
from datetime import datetime
from loguru import logger

DATA_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(__file__))), "data")
DISCOVERED_FILE = os.path.join(DATA_DIR, "discovered_glossary.json")


def _ensure_file() -> None:
    """Создаёт файл и директорию, если не существуют."""
    os.makedirs(DATA_DIR, exist_ok=True)
    if not os.path.exists(DISCOVERED_FILE):
        with open(DISCOVERED_FILE, "w", encoding="utf-8") as f:
            json.dump({"terms": {}}, f, ensure_ascii=False, indent=2)


def load_discovered() -> Dict:
    """Загружает все обнаруженные термины из файла."""
    _ensure_file()
    try:
        with open(DISCOVERED_FILE, "r", encoding="utf-8") as f:
            return json.load(f)
    except (json.JSONDecodeError, IOError) as e:
        logger.error(f"Error loading discovered glossary: {e}")
        return {"terms": {}}


def save_discovered(data: Dict) -> None:
    """Сохраняет термины в файл."""
    _ensure_file()
    with open(DISCOVERED_FILE, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)


def get_approved_terms() -> Dict[str, str]:
    """Возвращает dict только одобренных терминов {термин: определение}."""
    data = load_discovered()
    return {
        term: info["definition"]
        for term, info in data.get("terms", {}).items()
        if info.get("status") == "approved"
    }


def get_pending_terms() -> Dict[str, dict]:
    """Возвращает pending-термины с полной информацией."""
    data = load_discovered()
    return {
        term: info
        for term, info in data.get("terms", {}).items()
        if info.get("status") == "pending"
    }


def add_discovered_terms(terms: List[Dict], source_project: Optional[str] = None) -> int:
    """
    Добавляет обнаруженные термины (если ещё нет в базе).
    terms: [{term, definition, confidence}]
    Возвращает количество новых терминов.
    """
    from .base_glossary import BASE_GLOSSARY

    data = load_discovered()
    existing = data.get("terms", {})
    added = 0

    for item in terms:
        term = item.get("term", "").strip()
        definition = item.get("definition", "").strip()
        confidence = item.get("confidence", 0.0)

        if not term or not definition:
            continue

        # Пропускаем если уже есть в базовом глоссарии
        if term in BASE_GLOSSARY:
            continue

        # Пропускаем если уже обнаружен
        if term in existing:
            continue

        existing[term] = {
            "definition": definition,
            "confidence": confidence,
            "status": "pending",
            "source_project": source_project,
            "discovered_at": datetime.now().isoformat(),
        }
        added += 1

    data["terms"] = existing
    save_discovered(data)
    logger.info(f"Added {added} new discovered terms (source: {source_project})")
    return added


def approve_term(term: str) -> bool:
    """Одобряет термин. Возвращает True если термин найден."""
    data = load_discovered()
    terms = data.get("terms", {})
    if term not in terms:
        return False
    terms[term]["status"] = "approved"
    terms[term]["approved_at"] = datetime.now().isoformat()
    save_discovered(data)
    logger.info(f"Approved glossary term: {term}")
    return True


def reject_term(term: str) -> bool:
    """Отклоняет термин. Возвращает True если термин найден."""
    data = load_discovered()
    terms = data.get("terms", {})
    if term not in terms:
        return False
    terms[term]["status"] = "rejected"
    terms[term]["rejected_at"] = datetime.now().isoformat()
    save_discovered(data)
    logger.info(f"Rejected glossary term: {term}")
    return True


def approve_all_pending() -> int:
    """Одобряет все pending-термины. Возвращает кол-во одобренных."""
    data = load_discovered()
    terms = data.get("terms", {})
    count = 0
    now = datetime.now().isoformat()
    for info in terms.values():
        if info.get("status") == "pending":
            info["status"] = "approved"
            info["approved_at"] = now
            count += 1
    save_discovered(data)
    logger.info(f"Approved all pending terms: {count}")
    return count


def get_glossary_stats() -> Dict:
    """Статистика глоссария."""
    from .base_glossary import BASE_GLOSSARY

    data = load_discovered()
    terms = data.get("terms", {})

    pending = sum(1 for t in terms.values() if t.get("status") == "pending")
    approved = sum(1 for t in terms.values() if t.get("status") == "approved")
    rejected = sum(1 for t in terms.values() if t.get("status") == "rejected")

    return {
        "base_count": len(BASE_GLOSSARY),
        "discovered_total": len(terms),
        "pending": pending,
        "approved": approved,
        "rejected": rejected,
        "active_total": len(BASE_GLOSSARY) + approved,
    }
