"""Flask application factory for the Attenda M1 waiter/admin app."""

import json
from datetime import datetime, timezone
from pathlib import Path

from flask import Flask, jsonify, render_template, request
from werkzeug.exceptions import HTTPException

from .priority import rank_tasks
from .store import TaskStore


PROJECT_ROOT = Path(__file__).resolve().parent.parent
TABLES_PATH = PROJECT_ROOT / "config" / "tables.json"
RESET_CONFIRMATION = "RESET_DEMO"


def utc_now() -> datetime:
    return datetime.now(timezone.utc)


def create_app(test_config: dict | None = None) -> Flask:
    app = Flask(__name__, instance_relative_config=True)
    app.config.from_mapping(
        DATABASE=Path(app.instance_path) / "attenda.sqlite3",
        TIME_PROVIDER=utc_now,
        TABLES_PATH=TABLES_PATH,
    )
    if test_config:
        app.config.update(test_config)

    def now() -> datetime:
        value = app.config["TIME_PROVIDER"]()
        return value if value.tzinfo else value.replace(tzinfo=timezone.utc)

    store = TaskStore(Path(app.config["DATABASE"]), lambda: now().isoformat())
    store.initialize()
    app.extensions["task_store"] = store

    @app.errorhandler(Exception)
    def handle_error(error):
        if isinstance(error, HTTPException):
            return error
        app.logger.exception("Unhandled application error")
        if request.path.startswith("/api/"):
            return jsonify(error="Attenda could not complete the request. Please retry."), 500
        return "Attenda could not load this page.", 500

    def tables() -> list[dict]:
        with Path(app.config["TABLES_PATH"]).open(encoding="utf-8") as file:
            return json.load(file)["zones"]

    def table_by_id(table_id: str) -> dict | None:
        return next((table for table in tables() if table["id"] == table_id), None)

    def snapshot() -> dict:
        active = rank_tasks(store.active_tasks(), now())
        for task in active:
            task["order_draft"] = store.order_draft(task["id"]) if task["type"] == "TAKE_ORDER" else None
        return {
            "server_time": now().isoformat(),
            "active_tasks": active,
            "recommended_task_id": active[0]["id"] if active else None,
            "completed_tasks": store.completed_tasks(),
            "events": store.events(),
            "tables": tables(),
            "priority_policy": {
                "summary": "Task type base priority plus one point per elapsed task minute.",
                "age_warning": "Needs attention means this task is at least five minutes old; it is not guest waiting time.",
            },
        }

    @app.get("/")
    def index():
        return render_template("waiter.html")

    @app.get("/waiter")
    def waiter():
        return render_template("waiter.html")

    @app.get("/admin")
    def admin():
        return render_template("admin.html")

    @app.get("/api/state")
    def get_state():
        return jsonify(snapshot())

    @app.post("/api/tasks")
    def create_task():
        payload = request.get_json(silent=True)
        if not isinstance(payload, dict):
            return jsonify(error="Send a JSON object with table_id and type."), 400
        table = table_by_id(payload.get("table_id", ""))
        task_type = payload.get("type")
        expected_origin = {
            "DELIVER_ORDER": "SIMULATED_KITCHEN",
            "TAKE_ORDER": "MANAGER_DEMO",
        }.get(task_type)
        if not table or not expected_origin:
            return jsonify(error="Choose a configured table and supported task type."), 400
        task, created = store.create_or_reuse_task(
            table["id"], table["name"], task_type, expected_origin
        )
        return jsonify(task=task, created=created, state=snapshot()), 201 if created else 200

    @app.post("/api/tasks/<int:task_id>/start")
    def start_task(task_id: int):
        task, changed = store.transition(task_id, "IN_PROGRESS")
        if not task:
            return jsonify(error="Task not found."), 404
        return jsonify(task=task, changed=changed, state=snapshot())

    @app.post("/api/tasks/<int:task_id>/complete")
    def complete_task(task_id: int):
        task, changed = store.transition(task_id, "DONE")
        if not task:
            return jsonify(error="Task not found."), 404
        if task["status"] == "NEW":
            return jsonify(error="Start this task before completing it.", task=task, changed=False), 409
        if task["type"] == "TAKE_ORDER" and not changed and task["status"] == "IN_PROGRESS":
            return jsonify(error="Review and confirm the order draft before completing this task.", task=task, changed=False), 409
        return jsonify(task=task, changed=changed, state=snapshot())

    def order_task(task_id: int):
        task = store.task(task_id)
        if not task:
            return None, (jsonify(error="Task not found."), 404)
        if task["type"] != "TAKE_ORDER":
            return None, (jsonify(error="Order drafts are only available for take-order tasks."), 409)
        if task["status"] == "DONE":
            return None, (jsonify(error="Completed order drafts cannot be changed."), 409)
        return task, None

    @app.put("/api/tasks/<int:task_id>/order-draft")
    def save_order_draft(task_id: int):
        task, error = order_task(task_id)
        if error:
            return error
        if task["status"] != "IN_PROGRESS":
            return jsonify(error="Start the take-order task before editing its draft."), 409
        payload = request.get_json(silent=True)
        items = payload.get("items") if isinstance(payload, dict) else None
        if not isinstance(items, list) or not 1 <= len(items) <= 20:
            return jsonify(error="Add between 1 and 20 order items."), 400
        clean = []
        for item in items:
            if not isinstance(item, dict):
                return jsonify(error="Each order item must be an object."), 400
            name, notes, quantity = item.get("dish_name"), item.get("notes", ""), item.get("quantity")
            if not isinstance(name, str) or not name.strip() or len(name.strip()) > 100:
                return jsonify(error="Dish names must be 1 to 100 characters."), 400
            if type(quantity) is not int or not 1 <= quantity <= 99:
                return jsonify(error="Quantity must be a whole number from 1 to 99."), 400
            if not isinstance(notes, str) or len(notes.strip()) > 300:
                return jsonify(error="Notes must be at most 300 characters."), 400
            clean.append({"dish_name": name.strip(), "quantity": quantity, "notes": notes.strip()})
        return jsonify(draft=store.save_order_draft(task_id, clean), state=snapshot())

    @app.post("/api/tasks/<int:task_id>/order-draft/confirm")
    def confirm_order_draft(task_id: int):
        task, error = order_task(task_id)
        if error:
            return error
        if task["status"] != "IN_PROGRESS":
            return jsonify(error="Start the take-order task before confirming its draft."), 409
        draft, changed = store.confirm_order_draft(task_id)
        if not draft:
            return jsonify(error="Save at least one order item before confirmation."), 409
        return jsonify(draft=draft, changed=changed, state=snapshot())

    @app.post("/api/reset")
    def reset():
        payload = request.get_json(silent=True)
        if not isinstance(payload, dict) or payload.get("confirm") != RESET_CONFIRMATION:
            return jsonify(error="Confirm the demo reset before clearing tasks and history."), 400
        store.reset()
        return jsonify(state=snapshot())

    return app


def main() -> None:
    create_app().run(host="127.0.0.1", port=5000, debug=False)


if __name__ == "__main__":
    main()
