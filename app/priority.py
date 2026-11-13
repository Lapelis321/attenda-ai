"""Transparent, deterministic M1 task priority rules."""

from datetime import datetime


TYPE_BASE_PRIORITY = {
    "DELIVER_ORDER": 100,
    "TAKE_ORDER": 80,
}
AGE_POINT_INTERVAL_SECONDS = 60
NEEDS_ATTENTION_AFTER_SECONDS = 5 * 60


def priority_details(task: dict, now: datetime) -> dict:
    """Return explainable priority metadata based only on task type and age."""
    created_at = datetime.fromisoformat(task["created_at"])
    age_seconds = max(0, int((now - created_at).total_seconds()))
    age_points = age_seconds // AGE_POINT_INTERVAL_SECONDS
    base_points = TYPE_BASE_PRIORITY[task["type"]]
    return {
        "score": base_points + age_points,
        "base_points": base_points,
        "age_points": age_points,
        "age_seconds": age_seconds,
        "needs_attention": age_seconds >= NEEDS_ATTENTION_AFTER_SECONDS,
        "explanation": (
            f"{task_type_label(task['type'])} base priority ({base_points}) + "
            f"task age ({age_points} point per elapsed minute)."
        ),
    }


def task_type_label(task_type: str) -> str:
    return "Delivery" if task_type == "DELIVER_ORDER" else "Take order"


def rank_tasks(tasks: list[dict], now: datetime) -> list[dict]:
    """Rank by score, then oldest creation time, then stable numeric ID."""
    enriched = []
    for task in tasks:
        item = dict(task)
        item["priority"] = priority_details(task, now)
        enriched.append(item)
    return sorted(
        enriched,
        key=lambda item: (
            -item["priority"]["score"],
            item["created_at"],
            item["id"],
        ),
    )
