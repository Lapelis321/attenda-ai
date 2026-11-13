const ui = Object.fromEntries([
  "connection", "error", "error-message", "retry", "action-status", "table-select",
  "deliver", "take-order", "reset", "active-count", "history-count", "active-list",
  "history-list", "event-list"
].map(id => [id, document.querySelector(`#${id}`)]));

let state = null;
let pendingAction = null;
let retryAction = null;
let renderedSignature = "";
let toastTimer = null;
const actionButtons = [ui.deliver, ui["take-order"], ui.reset];

function setActionStatus(message = "", kind = "") {
  clearTimeout(toastTimer);
  ui["action-status"].textContent = message;
  if (kind) ui["action-status"].dataset.state = kind;
  else delete ui["action-status"].dataset.state;
  if (message && kind === "success") toastTimer = setTimeout(() => setActionStatus(), 3500);
}
function setConnected(connected) {
  ui.connection.textContent = connected ? "Connected" : "Disconnected";
  ui.connection.classList.toggle("online", connected);
  if (connected && !retryAction) ui.error.hidden = true;
}
function showError(message) {
  ui["error-message"].textContent = message;
  ui.error.hidden = false;
  setActionStatus(message, "error");
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
function record(primary, detail) {
  const div = document.createElement("div");
  div.className = "record";
  const heading = document.createElement("p");
  const strong = document.createElement("strong");
  strong.textContent = primary;
  heading.append(strong);
  const secondary = document.createElement("p");
  secondary.className = "muted";
  secondary.textContent = detail;
  div.append(heading, secondary);
  return div;
}
function render() {
  if (!state) return;
  if (!ui["table-select"].options.length) {
    state.tables.forEach(table => ui["table-select"].add(new Option(table.name, table.id)));
  }
  const signature = JSON.stringify([state.active_tasks, state.completed_tasks, state.events]);
  if (signature === renderedSignature) return;
  renderedSignature = signature;
  ui["active-count"].textContent = state.active_tasks.length;
  ui["history-count"].textContent = state.completed_tasks.length;
  ui["active-list"].replaceChildren(...state.active_tasks.map(task => record(task.table_name, `${task.type.replaceAll("_", " ")} · ${task.status.replaceAll("_", " ")} · ${task.origin.replaceAll("_", " ")}`)));
  ui["history-list"].replaceChildren(...state.completed_tasks.map(task => record(task.table_name, `${task.type.replaceAll("_", " ")} · DONE · WAITER REPORTED`)));
  ui["event-list"].replaceChildren(...state.events.map(event => record(event.message, `${event.origin.replaceAll("_", " ")} · ${event.created_at}`)));
  for (const id of ["active-list", "history-list", "event-list"]) if (!ui[id].children.length) ui[id].textContent = "No records yet.";
}
function setPending(button, loading) {
  pendingAction = button;
  actionButtons.forEach(candidate => { candidate.disabled = Boolean(button); });
  if (button) {
    button.dataset.defaultLabel = button.textContent;
    button.textContent = loading;
    button.setAttribute("aria-busy", "true");
  }
}
function clearPending() {
  if (pendingAction) {
    pendingAction.textContent = pendingAction.dataset.defaultLabel;
    pendingAction.removeAttribute("aria-busy");
  }
  pendingAction = null;
  actionButtons.forEach(button => { button.disabled = false; });
}
async function refresh({announceRecovery = true} = {}) {
  try {
    const wasDisconnected = ui.connection.textContent === "Disconnected";
    state = await api("/api/state");
    setConnected(true);
    if (wasDisconnected && announceRecovery) setActionStatus("Reconnected. Admin state is up to date.", "success");
    render();
  } catch (error) {
    setConnected(error.status !== 0);
    showError(`${error.message} No action was confirmed.`);
  }
}
async function mutate(action) {
  if (pendingAction) return;
  retryAction = action;
  ui.error.hidden = true;
  setPending(action.button, action.loading);
  setActionStatus(action.loading, "loading");
  try {
    const result = await api(action.url, {
      method: "POST",
      headers: action.body ? {"Content-Type": "application/json"} : undefined,
      body: action.body ? JSON.stringify(action.body) : undefined
    });
    state = result.state;
    setConnected(true);
    retryAction = null;
    setActionStatus(action.success(result), "success");
    render();
  } catch (error) {
    setConnected(error.status !== 0);
    showError(`${error.message} Nothing was changed locally.`);
  } finally {
    clearPending();
  }
}
function taskAction(type, button) {
  const tableName = ui["table-select"].selectedOptions[0]?.textContent || "selected table";
  return {
    url: "/api/tasks",
    body: {table_id: ui["table-select"].value, type},
    button,
    loading: "Sending…",
    success: result => result.created ? `Task sent to ${tableName}.` : `Active task already exists for ${tableName}.`
  };
}
ui.deliver.addEventListener("click", () => mutate(taskAction("DELIVER_ORDER", ui.deliver)));
ui["take-order"].addEventListener("click", () => mutate(taskAction("TAKE_ORDER", ui["take-order"])));
ui.reset.addEventListener("click", () => {
  if (!window.confirm("Clear all demo tasks and history? Table configuration will remain.")) return;
  mutate({
    url: "/api/reset",
    body: {confirm: "RESET_DEMO"},
    button: ui.reset,
    loading: "Resetting…",
    success: () => "Demo reset complete."
  });
});
ui.retry.addEventListener("click", () => retryAction ? mutate(retryAction) : refresh());

refresh({announceRecovery: false});
setInterval(() => refresh({announceRecovery: false}), 1500);
