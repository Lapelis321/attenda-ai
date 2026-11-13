"""SQLite persistence for shared M1 task and event state."""

import sqlite3
from pathlib import Path
from typing import Callable


TASK_TYPES = {"TAKE_ORDER", "DELIVER_ORDER"}
TASK_ORIGINS = {"SIMULATED_KITCHEN", "MANAGER_DEMO"}
ACTIVE_STATUSES = ("NEW", "IN_PROGRESS")


SCHEMA = """
CREATE TABLE IF NOT EXISTS tasks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    table_id TEXT NOT NULL,
    table_name TEXT NOT NULL,
    type TEXT NOT NULL CHECK (type IN ('TAKE_ORDER', 'DELIVER_ORDER')),
    origin TEXT NOT NULL CHECK (origin IN ('SIMULATED_KITCHEN', 'MANAGER_DEMO')),
    status TEXT NOT NULL CHECK (status IN ('NEW', 'IN_PROGRESS', 'DONE')),
    created_at TEXT NOT NULL,
    started_at TEXT,
    completed_at TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS one_active_task_per_table_type
ON tasks(table_id, type) WHERE status IN ('NEW', 'IN_PROGRESS');
CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id INTEGER,
    kind TEXT NOT NULL,
    origin TEXT NOT NULL,
    message TEXT NOT NULL,
    created_at TEXT NOT NULL,
    FOREIGN KEY(task_id) REFERENCES tasks(id)
);
CREATE TABLE IF NOT EXISTS order_drafts (
    task_id INTEGER PRIMARY KEY,
    confirmed INTEGER NOT NULL DEFAULT 0 CHECK (confirmed IN (0, 1)),
    updated_at TEXT NOT NULL,
    confirmed_at TEXT,
    FOREIGN KEY(task_id) REFERENCES tasks(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS order_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id INTEGER NOT NULL,
    position INTEGER NOT NULL,
    dish_name TEXT NOT NULL,
    quantity INTEGER NOT NULL CHECK (quantity BETWEEN 1 AND 99),
    notes TEXT NOT NULL DEFAULT '',
    FOREIGN KEY(task_id) REFERENCES order_drafts(task_id) ON DELETE CASCADE,
    UNIQUE(task_id, position)
);
"""


class TaskStore:
    def __init__(self, database: Path, now_iso: Callable[[], str]):
        self.database = database
        self.now_iso = now_iso

    def connect(self) -> sqlite3.Connection:
        connection = sqlite3.connect(self.database, timeout=5)
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA foreign_keys = ON")
        return connection

    def initialize(self) -> None:
        self.database.parent.mkdir(parents=True, exist_ok=True)
        with self.connect() as connection:
            connection.executescript(SCHEMA)

    def create_or_reuse_task(
        self, table_id: str, table_name: str, task_type: str, origin: str
    ) -> tuple[dict, bool]:
        if task_type not in TASK_TYPES or origin not in TASK_ORIGINS:
            raise ValueError("Unsupported task type or origin")
        with self.connect() as connection:
            # Serialize the lookup and insert so simultaneous manager requests
            # reuse the same active task instead of leaking an IntegrityError.
            connection.execute("BEGIN IMMEDIATE")
            existing = connection.execute(
                """SELECT * FROM tasks WHERE table_id = ? AND type = ?
                   AND status IN ('NEW', 'IN_PROGRESS') ORDER BY id LIMIT 1""",
                (table_id, task_type),
            ).fetchone()
            if existing:
                connection.commit()
                return dict(existing), False
            created_at = self.now_iso()
            cursor = connection.execute(
                """INSERT INTO tasks
                   (table_id, table_name, type, origin, status, created_at)
                   VALUES (?, ?, ?, ?, 'NEW', ?)""",
                (table_id, table_name, task_type, origin, created_at),
            )
            task_id = cursor.lastrowid
            label = "Order ready" if task_type == "DELIVER_ORDER" else "Take order"
            connection.execute(
                """INSERT INTO events (task_id, kind, origin, message, created_at)
                   VALUES (?, 'TASK_CREATED', ?, ?, ?)""",
                (task_id, origin, f"{label} — {table_name}", created_at),
            )
            row = connection.execute("SELECT * FROM tasks WHERE id = ?", (task_id,)).fetchone()
            return dict(row), True

    def transition(self, task_id: int, target: str) -> tuple[dict | None, bool]:
        if target not in {"IN_PROGRESS", "DONE"}:
            raise ValueError("Unsupported task transition")
        with self.connect() as connection:
            connection.execute("BEGIN IMMEDIATE")
            row = connection.execute("SELECT * FROM tasks WHERE id = ?", (task_id,)).fetchone()
            if not row:
                connection.commit()
                return None, False
            task = dict(row)
            if target == "DONE" and task["type"] == "TAKE_ORDER":
                confirmed = connection.execute(
                    "SELECT confirmed FROM order_drafts WHERE task_id = ?", (task_id,)
                ).fetchone()
                if not confirmed or not confirmed["confirmed"]:
                    connection.commit()
                    return task, False
            if task["status"] == "DONE" or task["status"] == target:
                connection.commit()
                return task, False
            timestamp = self.now_iso()
            if target == "IN_PROGRESS" and task["status"] == "NEW":
                connection.execute(
                    "UPDATE tasks SET status = 'IN_PROGRESS', started_at = ? WHERE id = ?",
                    (timestamp, task_id),
                )
                connection.execute(
                    """INSERT INTO events (task_id, kind, origin, message, created_at)
                       VALUES (?, 'TASK_STARTED', 'WAITER_REPORTED', ?, ?)""",
                    (task_id, f"Started — {task['table_name']}", timestamp),
                )
            elif target == "DONE" and task["status"] == "IN_PROGRESS":
                connection.execute(
                    "UPDATE tasks SET status = 'DONE', completed_at = ? WHERE id = ?",
                    (timestamp, task_id),
                )
                connection.execute(
                    """INSERT INTO events (task_id, kind, origin, message, created_at)
                       VALUES (?, 'TASK_COMPLETED', 'WAITER_REPORTED', ?, ?)""",
                    (task_id, f"Completed by waiter confirmation — {task['table_name']}", timestamp),
                )
            else:
                connection.commit()
                return task, False
            updated = connection.execute("SELECT * FROM tasks WHERE id = ?", (task_id,)).fetchone()
            return dict(updated), True

    def task(self, task_id: int) -> dict | None:
        with self.connect() as connection:
            row = connection.execute("SELECT * FROM tasks WHERE id = ?", (task_id,)).fetchone()
            return dict(row) if row else None

    def order_draft(self, task_id: int) -> dict | None:
        with self.connect() as connection:
            draft = connection.execute(
                "SELECT * FROM order_drafts WHERE task_id = ?", (task_id,)
            ).fetchone()
            if not draft:
                return None
            items = connection.execute(
                "SELECT dish_name, quantity, notes FROM order_items WHERE task_id = ? ORDER BY position",
                (task_id,),
            ).fetchall()
            return {
                "task_id": task_id,
                "confirmed": bool(draft["confirmed"]),
                "updated_at": draft["updated_at"],
                "confirmed_at": draft["confirmed_at"],
                "items": [dict(item) for item in items],
            }

    def save_order_draft(self, task_id: int, items: list[dict]) -> dict:
        timestamp = self.now_iso()
        with self.connect() as connection:
            connection.execute("BEGIN IMMEDIATE")
            connection.execute(
                """INSERT INTO order_drafts (task_id, confirmed, updated_at, confirmed_at)
                   VALUES (?, 0, ?, NULL)
                   ON CONFLICT(task_id) DO UPDATE SET confirmed = 0, updated_at = excluded.updated_at,
                   confirmed_at = NULL""",
                (task_id, timestamp),
            )
            connection.execute("DELETE FROM order_items WHERE task_id = ?", (task_id,))
            connection.executemany(
                """INSERT INTO order_items (task_id, position, dish_name, quantity, notes)
                   VALUES (?, ?, ?, ?, ?)""",
                [(task_id, index, item["dish_name"], item["quantity"], item["notes"])
                 for index, item in enumerate(items)],
            )
        return self.order_draft(task_id)

    def confirm_order_draft(self, task_id: int) -> tuple[dict | None, bool]:
        timestamp = self.now_iso()
        with self.connect() as connection:
            connection.execute("BEGIN IMMEDIATE")
            draft = connection.execute(
                "SELECT * FROM order_drafts WHERE task_id = ?", (task_id,)
            ).fetchone()
            count = connection.execute(
                "SELECT COUNT(*) FROM order_items WHERE task_id = ?", (task_id,)
            ).fetchone()[0]
            if not draft or not count:
                connection.commit()
                return None, False
            if draft["confirmed"]:
                connection.commit()
                return self.order_draft(task_id), False
            connection.execute(
                "UPDATE order_drafts SET confirmed = 1, confirmed_at = ?, updated_at = ? WHERE task_id = ?",
                (timestamp, timestamp, task_id),
            )
            connection.execute(
                """INSERT INTO events (task_id, kind, origin, message, created_at)
                   SELECT id, 'ORDER_DRAFT_CONFIRMED', 'WAITER_REPORTED',
                          'Order draft confirmed after human review — ' || table_name, ?
                   FROM tasks WHERE id = ?""",
                (timestamp, task_id),
            )
        return self.order_draft(task_id), True

    def active_tasks(self) -> list[dict]:
        with self.connect() as connection:
            rows = connection.execute(
                "SELECT * FROM tasks WHERE status IN ('NEW', 'IN_PROGRESS') ORDER BY id"
            ).fetchall()
            return [dict(row) for row in rows]

    def completed_tasks(self) -> list[dict]:
        with self.connect() as connection:
            rows = connection.execute(
                "SELECT * FROM tasks WHERE status = 'DONE' ORDER BY completed_at DESC, id DESC"
            ).fetchall()
            return [dict(row) for row in rows]

    def events(self) -> list[dict]:
        with self.connect() as connection:
            rows = connection.execute("SELECT * FROM events ORDER BY id DESC").fetchall()
            return [dict(row) for row in rows]

    def reset(self) -> None:
        with self.connect() as connection:
            connection.execute("DELETE FROM events")
            connection.execute("DELETE FROM order_items")
            connection.execute("DELETE FROM order_drafts")
            connection.execute("DELETE FROM tasks")
            connection.execute("DELETE FROM sqlite_sequence WHERE name IN ('tasks', 'events', 'order_items')")
