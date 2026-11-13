const ids = [
  "connection", "error", "error-message", "retry", "action-status", "task-card", "idle",
  "task-number", "attention", "table-name", "task-title", "task-description", "task-source",
  "task-age", "task-summary", "recommendation-reminder", "show-steps", "steps", "task-action",
  "confirmation-note", "queue-toggle", "queue-panel", "queue-count", "task-list", "order-editor",
  "order-context", "order-items", "empty-order", "add-item", "save-draft", "confirm-draft",
  "draft-state", "draft-guidance", "back-to-task", "order-item-template", "confirmed-state",
  "up-next", "up-next-count", "up-next-list", "confirmed-summary", "edit-draft"
];
const ui = Object.fromEntries(ids.map(id => [id, document.querySelector(`#${id}`)]));

let state = null;
let selectedTaskId = null;
let pendingTaskId = null;
let lastAction = null;
let toastTimer = null;
let draftDirty = false;
let editorTaskId = null;
let pollTimer = null;
let offline = false;
const disclosureByTask = new Map();
const draftLoadedForTask = new Map();

const copy = {
  DELIVER_ORDER: {
    title: "Deliver order",
    description: task => `Collect the prepared dishes and bring them to ${task.table_name}.`,
    start: "Start delivery",
    complete: "Mark delivered",
    started: "Delivery started",
    completed: "Delivery recorded",
    steps: [
      "Check the table number.",
      "Verify the prepared dishes and instructions.",
      "Bring the food to the table.",
      "Mark the delivery after the dishes reach the table."
    ],
    note: "Mark delivered only after the dishes reach the table."
  },
  TAKE_ORDER: {
    title: "Take order",
    description: task => `Greet the guests at ${task.table_name} and record what they confirm.`,
    start: "Start taking order",
    complete: "Mark order taken",
    continue: "Continue order",
    started: "Order editor ready",
    completed: "Order task completed",
    steps: [
      "Greet the guests.",
      "Ask what they would like.",
      "Clarify anything unclear; ask an authorized colleague about allergens.",
      "Read the order back before confirming the draft."
    ],
    note: "Confirm the draft before marking the order taken."
  }
};

const sourceCopy = {
  SIMULATED_KITCHEN: "Simulated kitchen",
  MANAGER_DEMO: "Manager demo",
  WAITER_REPORTED: "Waiter reported"
};

function currentTask() {
  return state?.active_tasks.find(task => task.id === selectedTaskId) || state?.active_tasks[0] || null;
}

function setText(node, value) {
  if (node && node.textContent !== value) node.textContent = value;
}

function setActionStatus(message = "", kind = "", persistent = false) {
  clearTimeout(toastTimer);
  setText(ui["action-status"], message);
  if (kind) ui["action-status"].dataset.state = kind;
  else delete ui["action-status"].dataset.state;
  if (message && !persistent && kind === "success") {
    toastTimer = setTimeout(() => setActionStatus(), 4500);
  }
}

function showError(message) {
  setActionStatus();
  setText(ui["error-message"], message);
  ui.error.hidden = false;
}

function clearError() {
  ui.error.hidden = true;
}

function setConnection(mode) {
  const labels = { connected: "Connected", reconnecting: "Reconnecting…", offline: "Offline" };
  setText(ui.connection, labels[mode]);
  ui.connection.dataset.state = mode;
  offline = mode === "offline";
}

class ApiError extends Error {
  constructor(message, status = 0) {
    super(message);
    this.status = status;
  }
}

async function api(url, options) {
  let response;
  try {
    response = await fetch(url, options);
  } catch {
    throw new ApiError("Connection lost. Updates are paused.");
  }
  let payload = null;
  try { payload = await response.json(); } catch { /* handled below */ }
  if (!response.ok) throw new ApiError(payload?.error || `Attenda returned ${response.status}. Please retry.`, response.status);
  if (!payload) throw new ApiError("Attenda returned an unreadable response. Please retry.", response.status);
  return payload;
}

function ageLabel(task) {
  const minutes = task.priority.age_points;
  if (minutes < 1) return "Created just now";
  if (minutes === 1) return "Created 1 min ago";
  return `Created ${minutes} min ago`;
}

function statusLabel(status) {
  return status === "IN_PROGRESS" ? "In progress" : "New";
}

function createQueueRow(id) {
  const li = document.createElement("li");
  const button = document.createElement("button");
  const main = document.createElement("span");
  const table = document.createElement("strong");
  const action = document.createElement("span");
  const status = document.createElement("span");
  const detail = document.createElement("span");
  li.dataset.taskId = id;
  button.type = "button";
  button.className = "task-select";
  main.className = "queue-main";
  action.className = "queue-action";
  status.className = "task-status";
  detail.className = "queue-detail";
  main.append(table, action);
  button.append(main, status, detail);
  li.append(button);
  return li;
}

function createPreviewRow(id) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "up-next-row";
  button.dataset.taskId = id;
  const table = document.createElement("strong");
  const action = document.createElement("span");
  const status = document.createElement("span");
  action.className = "up-next-action";
  status.className = "up-next-status";
  button.append(table, action, status);
  return button;
}

function reconcileUpNext(tasks, selectedId) {
  const preview = tasks.filter(task => task.id !== selectedId).slice(0, 2);
  const queueExpanded = !ui["queue-panel"].hidden;
  ui["up-next"].hidden = preview.length === 0 || editorTaskId !== null || queueExpanded;
  setText(ui["up-next-count"], preview.length === 1 ? "1 task" : `${preview.length} tasks`);
  const wanted = new Set(preview.map(task => String(task.id)));
  for (const row of [...ui["up-next-list"].children]) {
    if (!wanted.has(row.dataset.taskId)) row.remove();
  }
  preview.forEach((task, index) => {
    let row = ui["up-next-list"].querySelector(`[data-task-id="${task.id}"]`);
    if (!row) row = createPreviewRow(task.id);
    setText(row.querySelector("strong"), task.table_name);
    setText(row.querySelector(".up-next-action"), copy[task.type].title);
    setText(row.querySelector(".up-next-status"), statusLabel(task.status));
    if (ui["up-next-list"].children[index] !== row) {
      ui["up-next-list"].insertBefore(row, ui["up-next-list"].children[index] || null);
    }
  });
}

function reconcileQueue(tasks, selectedId, recommendedId) {
  const wanted = new Set(tasks.map(task => String(task.id)));
  for (const li of [...ui["task-list"].children]) {
    if (!wanted.has(li.dataset.taskId)) li.remove();
  }
  tasks.forEach((item, index) => {
    let li = ui["task-list"].querySelector(`li[data-task-id="${item.id}"]`);
    if (!li) li = createQueueRow(item.id);
    const button = li.firstElementChild;
    button.dataset.taskId = item.id;
    button.setAttribute("aria-current", String(item.id === selectedId));
    setText(button.querySelector("strong"), item.table_name);
    setText(button.querySelector(".queue-action"), copy[item.type].title);
    const relationship = item.id === selectedId ? "Current" : item.id === recommendedId ? "Recommended" : "";
    setText(button.querySelector(".task-status"), `${relationship}${relationship ? " · " : ""}${statusLabel(item.status)}`);
    setText(button.querySelector(".queue-detail"), ageLabel(item));
    button.classList.toggle("needs-attention", item.priority.needs_attention);
    if (ui["task-list"].children[index] !== li) {
      ui["task-list"].insertBefore(li, ui["task-list"].children[index] || null);
    }
  });
}

function renderConfirmedSummary(task) {
  const items = task.order_draft?.items || [];
  const wanted = new Set(items.map((_, index) => String(index)));
  for (const row of [...ui["confirmed-summary"].children]) {
    if (!wanted.has(row.dataset.index)) row.remove();
  }
  items.forEach((item, index) => {
    let row = ui["confirmed-summary"].querySelector(`[data-index="${index}"]`);
    if (!row) {
      row = document.createElement("li");
      row.dataset.index = index;
      const itemText = document.createElement("span");
      const notes = document.createElement("small");
      row.append(itemText, notes);
    }
    setText(row.firstElementChild, `${item.quantity} × ${item.dish_name}`);
    setText(row.lastElementChild, item.notes || "No notes");
    row.lastElementChild.hidden = !item.notes;
    if (ui["confirmed-summary"].children[index] !== row) {
      ui["confirmed-summary"].insertBefore(row, ui["confirmed-summary"].children[index] || null);
    }
  });
}

function addOrderItem(item = { dish_name: "", quantity: 1, notes: "" }, focus = false) {
  const row = ui["order-item-template"].content.firstElementChild.cloneNode(true);
  row.querySelector('[name="dish_name"]').value = item.dish_name || "";
  row.querySelector('[name="quantity"]').value = item.quantity || 1;
  row.querySelector('[name="notes"]').value = item.notes || "";
  ui["order-items"].append(row);
  if (focus) row.querySelector('[name="dish_name"]').focus();
}

function loadDraft(task) {
  const signature = JSON.stringify(task.order_draft || null);
  if (draftLoadedForTask.get(task.id) === signature || document.activeElement?.closest("#order-editor")) return;
  ui["order-items"].replaceChildren();
  (task.order_draft?.items || []).forEach(item => addOrderItem(item));
  draftLoadedForTask.set(task.id, signature);
  draftDirty = false;
}

function draftItems() {
  return [...ui["order-items"].querySelectorAll(".order-item")].map(row => ({
    dish_name: row.querySelector('[name="dish_name"]').value.trim(),
    quantity: Number(row.querySelector('[name="quantity"]').value),
    notes: row.querySelector('[name="notes"]').value.trim()
  }));
}

function renderEditor(task) {
  const editorOpen = editorTaskId === task.id;
  ui["task-summary"].hidden = editorOpen;
  ui["order-editor"].hidden = !editorOpen;
  if (!editorOpen) return;
  loadDraft(task);
  const itemCount = ui["order-items"].children.length;
  ui["empty-order"].hidden = itemCount > 0;
  setText(ui["order-context"], `${task.table_name} / Take order`);
  const confirmed = Boolean(task.order_draft?.confirmed) && !draftDirty;
  setText(ui["draft-state"], draftDirty ? "Unsaved changes" : confirmed ? "Draft confirmed" : task.order_draft ? "Draft saved" : "Not saved");
  ui["save-draft"].disabled = !(itemCount > 0 && draftDirty && pendingTaskId === null);
  ui["confirm-draft"].disabled = pendingTaskId !== null || draftDirty || !task.order_draft || confirmed;
  if (!itemCount) setText(ui["draft-guidance"], "Add an item to begin.");
  else if (draftDirty) setText(ui["draft-guidance"], "Save your changes before reviewing the draft.");
  else if (!task.order_draft) setText(ui["draft-guidance"], "Save the draft before reviewing it.");
  else if (confirmed) setText(ui["draft-guidance"], "Draft confirmed. Return to the task to mark the order taken.");
  else setText(ui["draft-guidance"], "Review the saved items, then confirm the draft.");
}

function render() {
  if (!state) return;
  const tasks = state.active_tasks;
  if (!tasks.some(task => task.id === selectedTaskId)) selectedTaskId = state.recommended_task_id;
  const task = currentTask();
  ui["task-card"].hidden = !task;
  ui.idle.hidden = Boolean(task);
  setText(ui["queue-count"], `All tasks (${tasks.length})`);
  reconcileQueue(tasks, task?.id, state.recommended_task_id);
  reconcileUpNext(tasks, task?.id);
  if (!task) {
    document.querySelector(".waiter-shell").dataset.ready = "true";
    return;
  }

  const c = copy[task.type];
  const editorOpen = editorTaskId === task.id;
  const relationship = task.id === state.recommended_task_id ? "Recommended task" : "Current task";
  setText(ui["task-number"], `${relationship} · ${statusLabel(task.status)}`);
  ui.attention.hidden = !task.priority.needs_attention;
  setText(ui["table-name"], task.table_name);
  setText(ui["task-title"], c.title);
  setText(ui["task-description"], c.description(task));
  setText(ui["task-source"], sourceCopy[task.origin] || task.origin);
  setText(ui["task-age"], ageLabel(task));
  const confirmed = task.type === "TAKE_ORDER" && Boolean(task.order_draft?.confirmed);
  ui["confirmed-state"].hidden = !confirmed;
  if (confirmed) renderConfirmedSummary(task);
  setText(ui["confirmation-note"], confirmed ? "" : c.note);
  ui["confirmation-note"].hidden = confirmed;

  const recommended = tasks.find(item => item.id === state.recommended_task_id);
  ui["recommendation-reminder"].hidden = task.id === state.recommended_task_id;
  if (recommended && !ui["recommendation-reminder"].hidden) {
    setText(ui["recommendation-reminder"], `Recommended: ${recommended.table_name} — ${copy[recommended.type].title}`);
  }

  const open = disclosureByTask.get(task.id) || false;
  ui.steps.hidden = !open;
  ui["show-steps"].setAttribute("aria-expanded", String(open));
  setText(ui["show-steps"].firstElementChild, open ? "Hide steps" : "Show steps");
  const signature = c.steps.join("|");
  if (ui.steps.dataset.signature !== signature) {
    ui.steps.replaceChildren(...c.steps.map(text => {
      const item = document.createElement("li");
      item.textContent = text;
      return item;
    }));
    ui.steps.dataset.signature = signature;
  }

  let actionLabel = task.status === "NEW" ? c.start : c.complete;
  if (task.type === "TAKE_ORDER" && task.status === "IN_PROGRESS" && !task.order_draft?.confirmed) actionLabel = c.continue;
  if (pendingTaskId === task.id) actionLabel = task.status === "NEW" ? "Starting…" : "Saving…";
  setText(ui["task-action"], actionLabel);
  ui["task-action"].disabled = pendingTaskId !== null;
  ui["task-action"].hidden = editorOpen;
  renderEditor(task);
  document.querySelector(".waiter-shell").dataset.ready = "true";
}

async function refresh({ announceRecovery = true } = {}) {
  const wasOffline = offline;
  if (wasOffline) setConnection("reconnecting");
  try {
    state = await api("/api/state");
    setConnection("connected");
    if (!lastAction) clearError();
    if (wasOffline && announceRecovery) setActionStatus("Reconnected. Tasks are up to date.", "success");
    render();
  } catch (error) {
    setConnection("offline");
    showError(`${error.message} Retry when the local server is available.`);
  }
}

function schedulePoll(delay = offline ? 6000 : 2000) {
  clearTimeout(pollTimer);
  pollTimer = setTimeout(async () => {
    if (!document.hidden && pendingTaskId === null) await refresh({ announceRecovery: false });
    schedulePoll();
  }, delay);
}

ui["show-steps"].addEventListener("click", () => {
  const task = currentTask();
  if (task) {
    disclosureByTask.set(task.id, ui.steps.hidden);
    render();
  }
});

ui["queue-toggle"].addEventListener("click", () => {
  ui["queue-panel"].hidden = !ui["queue-panel"].hidden;
  ui["queue-toggle"].setAttribute("aria-expanded", String(!ui["queue-panel"].hidden));
  render();
});

ui["task-list"].addEventListener("click", event => {
  const button = event.target.closest("[data-task-id]");
  if (!button) return;
  if (draftDirty) {
    showError("Save the current order draft before selecting another task.");
    return;
  }
  editorTaskId = null;
  selectedTaskId = Number(button.dataset.taskId);
  clearError();
  render();
});

ui["up-next-list"].addEventListener("click", event => {
  const button = event.target.closest("[data-task-id]");
  if (!button) return;
  selectedTaskId = Number(button.dataset.taskId);
  editorTaskId = null;
  clearError();
  render();
  requestAnimationFrame(() => ui["task-action"].focus());
});

async function taskMutation(task, endpoint) {
  if (pendingTaskId !== null) return;
  const c = copy[task.type];
  pendingTaskId = task.id;
  lastAction = { taskId: task.id, endpoint };
  clearError();
  setActionStatus(endpoint === "start" ? `Starting ${c.title.toLowerCase()}…` : "Saving completion…", "loading", true);
  render();
  try {
    const result = await api(`/api/tasks/${task.id}/${endpoint}`, { method: "POST" });
    state = result.state;
    setConnection("connected");
    lastAction = null;
    setActionStatus(endpoint === "start" ? c.started : c.completed, "success");
    if (endpoint === "start" && task.type === "TAKE_ORDER") editorTaskId = task.id;
  } catch (error) {
    setConnection(error.status === 0 ? "offline" : "connected");
    if (error.status !== 0) lastAction = null;
    showError(`${error.message} The task was not changed.`);
  } finally {
    pendingTaskId = null;
    render();
  }
}

ui["task-action"].addEventListener("click", () => {
  const task = currentTask();
  if (!task) return;
  if (task.type === "TAKE_ORDER" && task.status === "IN_PROGRESS" && !task.order_draft?.confirmed) {
    editorTaskId = task.id;
    render();
    requestAnimationFrame(() => ui["add-item"].focus());
    return;
  }
  taskMutation(task, task.status === "NEW" ? "start" : "complete");
});

ui["back-to-task"].addEventListener("click", () => {
  if (draftDirty) {
    showError("Save your changes before returning to the task.");
    return;
  }
  editorTaskId = null;
  clearError();
  render();
  requestAnimationFrame(() => ui["task-action"].focus());
});

ui["edit-draft"].addEventListener("click", () => {
  const task = currentTask();
  if (!task || task.type !== "TAKE_ORDER") return;
  editorTaskId = task.id;
  clearError();
  setActionStatus();
  render();
  requestAnimationFrame(() => ui["order-items"].querySelector("input")?.focus());
});

ui["add-item"].addEventListener("click", () => {
  addOrderItem(undefined, true);
  draftDirty = true;
  render();
});

ui["order-items"].addEventListener("input", () => {
  draftDirty = true;
  render();
});

ui["order-items"].addEventListener("click", event => {
  if (!event.target.matches(".remove-item")) return;
  event.target.closest(".order-item").remove();
  draftDirty = true;
  render();
});

ui["order-editor"].addEventListener("click", event => {
  if (!event.target.dataset.dish) return;
  addOrderItem({ dish_name: event.target.dataset.dish, quantity: 1, notes: "" });
  draftDirty = true;
  render();
});

ui["save-draft"].addEventListener("click", async () => {
  const task = currentTask();
  if (!task || pendingTaskId !== null) return;
  const items = draftItems();
  if (!items.length || items.some(item => !item.dish_name || !Number.isInteger(item.quantity) || item.quantity < 1 || item.quantity > 99)) {
    showError("Enter an item name and a whole quantity from 1 to 99 for every item.");
    return;
  }
  pendingTaskId = task.id;
  clearError();
  setActionStatus("Saving typed order draft…", "loading", true);
  render();
  try {
    const result = await api(`/api/tasks/${task.id}/order-draft`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ items })
    });
    state = result.state;
    setConnection("connected");
    draftLoadedForTask.set(task.id, JSON.stringify(result.draft));
    draftDirty = false;
    setActionStatus();
  } catch (error) {
    if (error.status === 0) setConnection("offline");
    showError(`${error.message} The draft was not saved.`);
  } finally {
    pendingTaskId = null;
    render();
  }
});

ui["confirm-draft"].addEventListener("click", async () => {
  const task = currentTask();
  if (!task || pendingTaskId !== null) return;
  pendingTaskId = task.id;
  clearError();
  setActionStatus("Confirming reviewed draft…", "loading", true);
  render();
  try {
    const result = await api(`/api/tasks/${task.id}/order-draft/confirm`, { method: "POST" });
    state = result.state;
    setConnection("connected");
    draftLoadedForTask.set(task.id, JSON.stringify(result.draft));
    draftDirty = false;
    editorTaskId = null;
    setActionStatus();
  } catch (error) {
    if (error.status === 0) setConnection("offline");
    showError(`${error.message} The draft was not confirmed.`);
  } finally {
    pendingTaskId = null;
    render();
  }
});

ui.retry.addEventListener("click", async () => {
  const failedTask = lastAction && state?.active_tasks.find(task => task.id === lastAction.taskId);
  if (failedTask) taskMutation(failedTask, lastAction.endpoint);
  else {
    lastAction = null;
    setConnection("reconnecting");
    await refresh();
  }
});

refresh({ announceRecovery: false });
schedulePoll();
