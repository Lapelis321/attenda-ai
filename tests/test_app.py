import json
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest

from app import create_app


@pytest.fixture
def clock():
    return {"now": datetime(2026, 11, 13, 9, 0, tzinfo=timezone.utc)}


@pytest.fixture
def app(tmp_path, clock):
    return create_app({
        "TESTING": True,
        "DATABASE": tmp_path / "test.sqlite3",
        "TIME_PROVIDER": lambda: clock["now"],
    })


@pytest.fixture
def client(app):
    return app.test_client()


def create_task(client, table_id="table_1", task_type="DELIVER_ORDER"):
    return client.post("/api/tasks", json={"table_id": table_id, "type": task_type})


def start_and_complete(client, task_id):
    started = client.post(f"/api/tasks/{task_id}/start")
    completed = client.post(f"/api/tasks/{task_id}/complete")
    return started, completed


def test_pages_and_initial_state(client):
    assert client.get("/waiter").status_code == 200
    assert client.get("/admin").status_code == 200
    state = client.get("/api/state").get_json()
    assert state["active_tasks"] == []
    assert [table["id"] for table in state["tables"]] == ["table_1", "table_2"]


def test_duplicate_manager_event_reuses_active_task_and_get_is_read_only(client):
    first = create_task(client)
    second = create_task(client)
    assert first.status_code == 201 and first.get_json()["created"] is True
    assert second.status_code == 200 and second.get_json()["created"] is False
    before = client.get("/api/state").get_json()
    after = client.get("/api/state").get_json()
    assert len(before["active_tasks"]) == 1
    assert before["events"] == after["events"]


def test_distinct_types_coexist_and_manual_selection_is_client_only(client):
    delivery = create_task(client, "table_1", "DELIVER_ORDER").get_json()["task"]
    take_order = create_task(client, "table_1", "TAKE_ORDER").get_json()["task"]
    state = client.get("/api/state").get_json()
    assert {task["id"] for task in state["active_tasks"]} == {delivery["id"], take_order["id"]}
    assert state["recommended_task_id"] == delivery["id"]


def test_completion_is_idempotent_with_one_history_event(client):
    task = create_task(client).get_json()["task"]
    client.post(f"/api/tasks/{task['id']}/start")
    first = client.post(f"/api/tasks/{task['id']}/complete").get_json()
    second = client.post(f"/api/tasks/{task['id']}/complete").get_json()
    assert first["changed"] is True
    assert second["changed"] is False
    state = second["state"]
    completions = [event for event in state["events"] if event["kind"] == "TASK_COMPLETED"]
    assert len(state["completed_tasks"]) == 1
    assert len(completions) == 1
    assert completions[0]["origin"] == "WAITER_REPORTED"


def test_start_transition_is_idempotent(client):
    task = create_task(client, task_type="TAKE_ORDER").get_json()["task"]
    first = client.post(f"/api/tasks/{task['id']}/start").get_json()
    second = client.post(f"/api/tasks/{task['id']}/start").get_json()
    assert first["task"]["status"] == "IN_PROGRESS" and first["changed"] is True
    assert second["changed"] is False


def test_completion_requires_start_and_preserves_new_task(client):
    task = create_task(client).get_json()["task"]
    response = client.post(f"/api/tasks/{task['id']}/complete")
    assert response.status_code == 409
    assert response.get_json()["error"] == "Start this task before completing it."
    state = client.get("/api/state").get_json()
    assert state["active_tasks"][0]["status"] == "NEW"
    assert not any(event["kind"] == "TASK_COMPLETED" for event in state["events"])


def test_age_can_overtake_type_priority_and_warning_is_task_age(client, clock):
    old_take_order = create_task(client, "table_2", "TAKE_ORDER").get_json()["task"]
    clock["now"] += timedelta(minutes=25)
    delivery = create_task(client, "table_1", "DELIVER_ORDER").get_json()["task"]
    state = client.get("/api/state").get_json()
    assert state["recommended_task_id"] == old_take_order["id"]
    old = state["active_tasks"][0]
    assert old["priority"]["needs_attention"] is True
    assert old["priority"]["age_points"] == 25
    assert "task is at least five minutes old" in state["priority_policy"]["age_warning"]
    assert delivery["id"] != old_take_order["id"]


def test_priority_tie_break_is_stable_by_oldest_then_id(client):
    first = create_task(client, "table_1", "TAKE_ORDER").get_json()["task"]
    second = create_task(client, "table_2", "TAKE_ORDER").get_json()["task"]
    state = client.get("/api/state").get_json()
    assert [task["id"] for task in state["active_tasks"]] == [first["id"], second["id"]]


def test_reset_clears_demo_state_without_touching_table_config(client, app):
    table_path = app.config["TABLES_PATH"]
    before = table_path.read_text(encoding="utf-8")
    create_task(client)
    start_and_complete(client, 1)
    state = client.post("/api/reset", json={"confirm": "RESET_DEMO"}).get_json()["state"]
    assert state["active_tasks"] == state["completed_tasks"] == state["events"] == []
    assert table_path.read_text(encoding="utf-8") == before
    assert json.loads(before)["zones"][0]["id"] == "table_1"


def test_invalid_input_and_missing_task_are_explicit(client):
    assert client.post("/api/tasks", json={"table_id": "nope", "type": "DELIVER_ORDER"}).status_code == 400
    assert client.post("/api/tasks/999/complete").status_code == 404
    assert client.post("/api/tasks", data="not json", content_type="text/plain").status_code == 400
    assert client.post("/api/tasks", json=[]).status_code == 400
    assert client.post("/api/tasks", json={}).status_code == 400
    assert client.post("/api/tasks", json={"table_id": "table_1", "type": "UNKNOWN"}).status_code == 400
    assert client.post("/api/reset").status_code == 400
    assert client.post("/api/reset", json={"confirm": "wrong"}).status_code == 400


def test_rapid_concurrent_duplicates_reuse_one_task(app):
    def submit():
        with app.test_client() as concurrent_client:
            response = create_task(concurrent_client)
            return response.status_code, response.get_json()["task"]["id"], response.get_json()["created"]

    with ThreadPoolExecutor(max_workers=8) as pool:
        results = list(pool.map(lambda _: submit(), range(16)))
    assert {task_id for _, task_id, _ in results} == {1}
    assert sum(created for _, _, created in results) == 1
    assert {status for status, _, _ in results} == {200, 201}
    state = app.test_client().get("/api/state").get_json()
    assert len(state["active_tasks"]) == 1
    assert [event["kind"] for event in state["events"]] == ["TASK_CREATED"]


def test_sqlite_state_persists_across_app_restart(tmp_path, clock):
    database = tmp_path / "persistent.sqlite3"
    first_app = create_app({"TESTING": True, "DATABASE": database, "TIME_PROVIDER": lambda: clock["now"]})
    first_client = first_app.test_client()
    task = create_task(first_client, "table_2", "TAKE_ORDER").get_json()["task"]
    first_client.post(f"/api/tasks/{task['id']}/start")
    first_client.put(
        f"/api/tasks/{task['id']}/order-draft",
        json={"items": [{"dish_name": "Pizza", "quantity": 1, "notes": ""}]},
    )
    first_client.post(f"/api/tasks/{task['id']}/order-draft/confirm")
    first_client.post(f"/api/tasks/{task['id']}/complete")

    restarted_app = create_app({"TESTING": True, "DATABASE": database, "TIME_PROVIDER": lambda: clock["now"]})
    state = restarted_app.test_client().get("/api/state").get_json()
    assert state["active_tasks"] == []
    assert [item["id"] for item in state["completed_tasks"]] == [task["id"]]
    assert [event["kind"] for event in reversed(state["events"])] == [
        "TASK_CREATED", "TASK_STARTED", "ORDER_DRAFT_CONFIRMED", "TASK_COMPLETED"
    ]


def test_event_history_records_state_chain_once(client):
    task = create_task(client).get_json()["task"]
    start_and_complete(client, task["id"])
    client.post(f"/api/tasks/{task['id']}/start")
    client.post(f"/api/tasks/{task['id']}/complete")
    events = list(reversed(client.get("/api/state").get_json()["events"]))
    assert [(event["kind"], event["origin"]) for event in events] == [
        ("TASK_CREATED", "SIMULATED_KITCHEN"),
        ("TASK_STARTED", "WAITER_REPORTED"),
        ("TASK_COMPLETED", "WAITER_REPORTED"),
    ]


def test_api_unhandled_exception_returns_controlled_json(app):
    @app.get("/api/test-error")
    def test_error():
        raise RuntimeError("private database detail")

    response = app.test_client().get("/api/test-error")
    assert response.status_code == 500
    assert response.get_json() == {"error": "Attenda could not complete the request. Please retry."}
    assert b"private database detail" not in response.data


def test_missing_table_configuration_returns_controlled_api_error(tmp_path, clock):
    app = create_app({
        "TESTING": True,
        "DATABASE": tmp_path / "missing-config.sqlite3",
        "TABLES_PATH": Path(tmp_path / "missing-tables.json"),
        "TIME_PROVIDER": lambda: clock["now"],
    })
    response = app.test_client().get("/api/state")
    assert response.status_code == 500
    assert response.get_json() == {"error": "Attenda could not complete the request. Please retry."}


def start_take_order(client):
    task = create_task(client, task_type="TAKE_ORDER").get_json()["task"]
    client.post(f"/api/tasks/{task['id']}/start")
    return task


def test_order_draft_validation_and_task_gates(client):
    delivery = create_task(client).get_json()["task"]
    assert client.put(f"/api/tasks/{delivery['id']}/order-draft", json={"items": []}).status_code == 409
    take_order = create_task(client, "table_2", "TAKE_ORDER").get_json()["task"]
    assert client.put(f"/api/tasks/{take_order['id']}/order-draft", json={"items": [{"dish_name": "Pizza", "quantity": 1}]}).status_code == 409
    client.post(f"/api/tasks/{take_order['id']}/start")
    invalid = [
        None, {}, {"items": []}, {"items": [{}]},
        {"items": [{"dish_name": "", "quantity": 1}]},
        {"items": [{"dish_name": "Water", "quantity": True}]},
        {"items": [{"dish_name": "Water", "quantity": 0}]},
        {"items": [{"dish_name": "Water", "quantity": 1, "notes": "x" * 301}]},
    ]
    for payload in invalid:
        assert client.put(f"/api/tasks/{take_order['id']}/order-draft", json=payload).status_code == 400


def test_order_draft_edit_persist_confirm_and_complete(client, app, clock):
    task = start_take_order(client)
    first_items = [{"dish_name": "Pizza", "quantity": 2, "notes": "No olives"}]
    saved = client.put(f"/api/tasks/{task['id']}/order-draft", json={"items": first_items})
    assert saved.status_code == 200
    assert saved.get_json()["draft"]["items"] == first_items
    assert saved.get_json()["draft"]["confirmed"] is False
    assert client.post(f"/api/tasks/{task['id']}/complete").status_code == 409

    revised = [{"dish_name": "Pasta", "quantity": 1, "notes": ""}, {"dish_name": "Water", "quantity": 3, "notes": "Still"}]
    client.put(f"/api/tasks/{task['id']}/order-draft", json={"items": revised})
    restarted = create_app({"TESTING": True, "DATABASE": app.config["DATABASE"], "TIME_PROVIDER": lambda: clock["now"]})
    persisted = restarted.test_client().get("/api/state").get_json()["active_tasks"][0]["order_draft"]
    assert persisted["items"] == revised

    confirmed = restarted.test_client().post(f"/api/tasks/{task['id']}/order-draft/confirm")
    assert confirmed.status_code == 200 and confirmed.get_json()["changed"] is True
    again = restarted.test_client().post(f"/api/tasks/{task['id']}/order-draft/confirm")
    assert again.status_code == 200 and again.get_json()["changed"] is False
    completed = restarted.test_client().post(f"/api/tasks/{task['id']}/complete")
    assert completed.status_code == 200 and completed.get_json()["task"]["status"] == "DONE"
    events = completed.get_json()["state"]["events"]
    assert sum(event["kind"] == "ORDER_DRAFT_CONFIRMED" for event in events) == 1


def test_editing_confirmed_draft_requires_new_confirmation(client):
    task = start_take_order(client)
    url = f"/api/tasks/{task['id']}/order-draft"
    client.put(url, json={"items": [{"dish_name": "Pizza", "quantity": 1}]})
    client.post(f"{url}/confirm")
    edited = client.put(url, json={"items": [{"dish_name": "Pasta", "quantity": 2}]})
    assert edited.get_json()["draft"]["confirmed"] is False
    assert client.post(f"/api/tasks/{task['id']}/complete").status_code == 409


def test_reset_removes_order_draft_and_items(client, app):
    task = start_take_order(client)
    client.put(f"/api/tasks/{task['id']}/order-draft", json={"items": [{"dish_name": "Water", "quantity": 1}]})
    client.post("/api/reset", json={"confirm": "RESET_DEMO"})
    with app.extensions["task_store"].connect() as connection:
        assert connection.execute("SELECT COUNT(*) FROM order_drafts").fetchone()[0] == 0
        assert connection.execute("SELECT COUNT(*) FROM order_items").fetchone()[0] == 0
