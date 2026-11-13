const { test, expect } = require("@playwright/test");
const fs = require("fs");
const path = require("path");

const qaDir = path.resolve(__dirname, "..", "qa", "waiter-recovery");
const finalQaDir = path.resolve(__dirname, "..", "qa", "m1-final");
fs.mkdirSync(finalQaDir, {recursive: true});

async function resetAndSeed(request) {
  await expect((await request.post("/api/reset", {data: {confirm: "RESET_DEMO"}})).ok()).toBeTruthy();
  const snapshot = await (await request.get("/api/state")).json();
  const [first, second] = snapshot.tables;
  const deliver = await request.post("/api/tasks", {
    data: { table_id: first.id, type: "DELIVER_ORDER" }
  });
  const takeOrder = await request.post("/api/tasks", {
    data: { table_id: second.id, type: "TAKE_ORDER" }
  });
  const secondOrder = await request.post("/api/tasks", {
    data: { table_id: first.id, type: "TAKE_ORDER" }
  });
  expect(deliver.status()).toBe(201);
  expect(takeOrder.status()).toBe(201);
  expect(secondOrder.status()).toBe(201);
  return {
    deliver: (await deliver.json()).task,
    takeOrder: (await takeOrder.json()).task,
    secondOrder: (await secondOrder.json()).task
  };
}

async function installLayoutShiftObserver(page) {
  await page.addInitScript(() => {
    window.__attendaLayoutShift = 0;
    window.__attendaLayoutShiftEntries = [];
    new PerformanceObserver(list => {
      for (const entry of list.getEntries()) {
        if (!entry.hadRecentInput) {
          const sources = entry.sources.map(source => {
            const node = source.node;
            return {
              node: node ? `${node.tagName.toLowerCase()}${node.id ? `#${node.id}` : ""}${node.className && typeof node.className === "string" ? `.${node.className.trim().replace(/\\s+/g, ".")}` : ""}` : "unknown",
              previousRect: source.previousRect,
              currentRect: source.currentRect
            };
          });
          window.__attendaLayoutShift += entry.value;
          window.__attendaLayoutShiftEntries.push({ value: entry.value, sources });
        }
      }
    }).observe({ type: "layout-shift", buffered: true });
  });
}

async function expectNoHorizontalOverflow(page) {
  const dimensions = await page.evaluate(() => ({
    documentWidth: document.documentElement.scrollWidth,
    viewportWidth: document.documentElement.clientWidth
  }));
  expect(dimensions.documentWidth).toBeLessThanOrEqual(dimensions.viewportWidth);
}

test.describe("waiter recovery slice in Microsoft Edge", () => {
  test("360 x 800: recommended task, sync, and editable order workflow", async ({ page, request }) => {
    const seeded = await resetAndSeed(request);
    await installLayoutShiftObserver(page);
    await page.setViewportSize({ width: 360, height: 800 });
    await page.goto("/waiter");

    await expect(page.locator("#connection")).toHaveText("Connected");
    await expect(page.locator("#table-name")).toHaveText(seeded.deliver.table_name);
    await expect(page.locator("#task-title")).toHaveText("Deliver order");
    await expect(page.locator("#task-action")).toHaveText("Start delivery");
    await expect(page.locator("#up-next-list .up-next-row")).toHaveCount(2);
    await expect(page.locator("#up-next")).toBeVisible();
    await expect(page.locator("#queue-count")).toHaveText("All tasks (3)");
    await expectNoHorizontalOverflow(page);

    await page.screenshot({
      path: path.join(qaDir, "targeted-a-main-up-next-360x800.png"),
      fullPage: true
    });

    const cardBeforePoll = await page.locator("#task-card").boundingBox();
    await page.waitForTimeout(2300);
    const cardAfterPoll = await page.locator("#task-card").boundingBox();
    expect(Math.abs(cardAfterPoll.x - cardBeforePoll.x)).toBeLessThanOrEqual(1);
    expect(Math.abs(cardAfterPoll.width - cardBeforePoll.width)).toBeLessThanOrEqual(1);

    await page.locator("#queue-toggle").click();
    await expect(page.locator("#up-next")).toBeHidden();
    const selectedQueueButton = page.locator(`#task-list button[data-task-id="${seeded.takeOrder.id}"]`);
    await selectedQueueButton.click();
    await expect(selectedQueueButton).toHaveAttribute("aria-current", "true");
    await expect(selectedQueueButton.locator(".task-status")).toContainText("Current");
    await expect(page.locator(`#task-list button[data-task-id="${seeded.deliver.id}"] .task-status`)).toContainText("Recommended");
    await expect(page.locator("#task-number")).toContainText("Current task");
    await expect(page.locator("#recommendation-reminder")).toContainText(`${seeded.deliver.table_name} — Deliver order`);
    await expect(page.locator("#table-name")).toHaveText(seeded.takeOrder.table_name);
    await page.screenshot({
      path: path.join(qaDir, "targeted-b-expanded-queue-360x800.png"),
      fullPage: true
    });

    await page.locator("#task-action").click();
    await expect(page.locator("#order-editor")).toBeVisible();
    const prematureCompletion = await request.post(`/api/tasks/${seeded.takeOrder.id}/complete`);
    expect(prematureCompletion.status()).toBe(409);
    await page.getByRole("button", { name: "Add item", exact: true }).click();
    const orderRow = page.locator(".order-item").first();
    await orderRow.locator('[name="dish_name"]').fill("Margherita");
    await orderRow.locator('[name="quantity"]').fill("2");
    await orderRow.locator('[name="notes"]').fill("One without basil");
    await page.getByRole("button", { name: "Add water" }).click();
    const waterRow = page.locator(".order-item").nth(1);
    await waterRow.locator('[name="quantity"]').fill("3");
    await waterRow.locator('[name="notes"]').fill("Still water");
    await expect(page.locator("#draft-state")).toHaveText("Unsaved changes");

    const focusTarget = waterRow.locator('[name="notes"]');
    await focusTarget.focus();
    await page.waitForTimeout(2300);
    await expect(focusTarget).toBeFocused();
    await expect(focusTarget).toHaveValue("Still water");

    await page.screenshot({
      path: path.join(qaDir, "targeted-c-order-editor-360x800.png"),
      fullPage: true
    });
    await page.locator("#save-draft").click();
    await expect(page.locator("#draft-state")).toHaveText("Draft saved");
    await expect(page.locator("#confirm-draft")).toBeEnabled();
    await page.locator("#confirm-draft").click();
    await expect(page.locator("#order-editor")).toBeHidden();
    await expect(page.locator("#task-action")).toHaveText("Mark order taken");
    await expect(page.locator("#confirmed-state")).toBeVisible();
    await expect(page.locator("#confirmation-note")).toBeHidden();
    await expect(page.locator("#confirmed-summary li")).toHaveCount(2);
    await expect(page.locator("#confirmed-summary")).toContainText("2 × Margherita");
    await expect(page.locator("#confirmed-summary")).toContainText("One without basil");
    await expect(page.locator("#confirmed-summary")).toContainText("3 × Water");
    await expect(page.locator("#confirmed-state")).toContainText("Nothing was sent to a kitchen or POS.");

    await page.locator("#edit-draft").click();
    await expect(page.locator("#order-editor")).toBeVisible();
    const editedNotes = page.locator(".order-item").first().locator('[name="notes"]');
    await editedNotes.fill("One without basil, extra hot");
    await page.locator("#save-draft").click();
    await expect(page.locator("#draft-state")).toHaveText("Draft saved");
    await page.locator("#back-to-task").click();
    await expect(page.locator("#confirmed-state")).toBeHidden();
    await expect(page.locator("#task-action")).toHaveText("Continue order");
    const recheckGuard = await request.post(`/api/tasks/${seeded.takeOrder.id}/complete`);
    expect(recheckGuard.status()).toBe(409);
    await page.locator("#task-action").click();
    await page.locator("#confirm-draft").click();
    await expect(page.locator("#order-editor")).toBeHidden();
    await expect(page.locator("#confirmed-summary")).toContainText("One without basil, extra hot");

    await page.screenshot({
      path: path.join(qaDir, "targeted-d-confirmed-order-summary-360x800.png"),
      fullPage: true
    });

    let state = await (await request.get("/api/state")).json();
    let orderTask = state.active_tasks.find(task => task.id === seeded.takeOrder.id);
    expect(orderTask.order_draft.confirmed).toBe(true);
    expect(orderTask.order_draft.items).toEqual([
      { dish_name: "Margherita", quantity: 2, notes: "One without basil, extra hot" },
      { dish_name: "Water", quantity: 3, notes: "Still water" }
    ]);
    await page.locator("#task-action").click();
    await expect(page.locator(`#task-list button[data-task-id="${seeded.takeOrder.id}"]`)).toHaveCount(0);
    state = await (await request.get("/api/state")).json();
    expect(state.active_tasks.some(task => task.id === seeded.takeOrder.id)).toBe(false);
    const layout = await page.evaluate(() => ({
      cls: window.__attendaLayoutShift,
      entries: window.__attendaLayoutShiftEntries
    }));
    console.log(`LAYOUT_SHIFT ${JSON.stringify(layout)}`);
    expect(layout.cls).toBeLessThanOrEqual(0.01);
    await expectNoHorizontalOverflow(page);
  });

  test("360 x 800: offline recovery, actionable conflict, toast geometry, and admin synchronization", async ({ page, request, context }) => {
    const seeded = await resetAndSeed(request);
    await installLayoutShiftObserver(page);
    await page.setViewportSize({ width: 360, height: 800 });
    await page.goto("/waiter");

    await page.route(`**/api/tasks/${seeded.deliver.id}/start`, async route => {
      await route.fulfill({
        status: 409,
        contentType: "application/json",
        body: JSON.stringify({ error: "Resolve this task with the manager before starting it." })
      });
    });
    await page.locator("#task-action").click();
    await expect(page.locator("#connection")).toHaveText("Connected");
    await expect(page.locator("#error-message")).toContainText("Resolve this task with the manager before starting it.");
    await expect(page.locator("#error-message")).toContainText("The task was not changed.");
    await page.unroute(`**/api/tasks/${seeded.deliver.id}/start`);

    await page.locator("#retry").click();
    await expect(page.locator("#error")).toBeHidden();
    await page.locator("#task-action").click();
    await expect(page.locator("#task-action")).toHaveText("Mark delivered");
    await expect(page.locator("#action-status")).toHaveText("Delivery started");
    const geometry = await page.evaluate(() => {
      const status = document.querySelector("#action-status").getBoundingClientRect();
      const action = document.querySelector("#task-action").getBoundingClientRect();
      return { overlaps: !(status.bottom <= action.top || status.top >= action.bottom || status.right <= action.left || status.left >= action.right) };
    });
    expect(geometry.overlaps).toBe(false);

    await context.setOffline(true);
    await expect(page.locator("#connection")).toHaveText("Offline", { timeout: 6_000 });
    await expect(page.locator("#error-message")).toContainText("Updates are paused");
    await context.setOffline(false);
    await page.locator("#retry").click();
    await expect(page.locator("#connection")).toHaveText("Connected");
    await expect(page.locator("#error")).toBeHidden();
    await expect(page.locator("#task-action")).toHaveText("Mark delivered");

    const admin = await context.newPage();
    await admin.goto("/admin");
    await expect(admin.locator("#active-count")).toHaveText("3");
    await page.locator("#task-action").click();
    await expect(admin.locator("#history-count")).toHaveText("1", { timeout: 5_000 });
    await expect(admin.locator("#active-count")).toHaveText("2");

    const layout = await page.evaluate(() => ({ cls: window.__attendaLayoutShift, entries: window.__attendaLayoutShiftEntries }));
    console.log(`LAYOUT_SHIFT_OFFLINE ${JSON.stringify(layout)}`);
    expect(layout.cls).toBeLessThanOrEqual(0.01);
    await expectNoHorizontalOverflow(page);
  });

  test("1280 x 800: stable navigation and polling synchronization", async ({ page, request }) => {
    const seeded = await resetAndSeed(request);
    await installLayoutShiftObserver(page);
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto("/waiter");

    await expect(page.locator("#connection")).toHaveText("Connected");
    await page.locator("#queue-toggle").click();
    await expect(page.locator("#task-list .task-select")).toHaveCount(3);
    await page.locator(`#task-list button[data-task-id="${seeded.takeOrder.id}"]`).click();
    await expect(page.locator("#table-name")).toHaveText(seeded.takeOrder.table_name);
    await expect(page.locator("#recommendation-reminder")).toContainText(seeded.deliver.table_name);

    const snapshot = await (await request.get("/api/state")).json();
    const third = snapshot.tables.find(table => table.id !== seeded.deliver.table_id);
    const created = await request.post("/api/tasks", {
      data: { table_id: third.id, type: "DELIVER_ORDER" }
    });
    expect(created.status()).toBe(201);
    await expect(page.locator("#queue-count")).toHaveText("All tasks (4)", { timeout: 5_000 });
    await expect(page.locator("#table-name")).toHaveText(seeded.takeOrder.table_name);

    const cardBeforePoll = await page.locator("#task-card").boundingBox();
    await page.waitForTimeout(2300);
    const cardAfterPoll = await page.locator("#task-card").boundingBox();
    expect(Math.abs(cardAfterPoll.x - cardBeforePoll.x)).toBeLessThanOrEqual(1);
    expect(Math.abs(cardAfterPoll.width - cardBeforePoll.width)).toBeLessThanOrEqual(1);
    expect(await page.evaluate(() => window.__attendaLayoutShift)).toBeLessThanOrEqual(0.01);
    await expectNoHorizontalOverflow(page);
  });

  test("workflow conflicts stay HTTP 409 without being reported as offline", async ({ page, request }) => {
    const seeded = await resetAndSeed(request);
    const conflict = await request.post(`/api/tasks/${seeded.deliver.id}/complete`);
    expect(conflict.status()).toBe(409);
    await expect((await conflict.json()).error).toBe("Start this task before completing it.");

    await page.setViewportSize({ width: 360, height: 800 });
    await page.goto("/waiter");
    await expect(page.locator("#connection")).toHaveText("Connected");
    await expect(page.locator("#task-action")).toHaveText("Start delivery");
  });

  test("admin keeps a reachable-server error distinct from disconnection", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto("/admin");
    await expect(page.locator("#connection")).toHaveText("Connected");
    await page.route("**/api/tasks", route => route.fulfill({
      status: 409,
      contentType: "application/json",
      body: JSON.stringify({error: "Resolve the active task before creating another."})
    }));
    await page.locator("#deliver").click();
    await expect(page.locator("#error-message")).toContainText("Resolve the active task");
    await expect(page.locator("#connection")).toHaveText("Connected");
  });

  test("manager and waiter complete the full M1 journey in separate Edge contexts", async ({ browser }) => {
    test.setTimeout(75_000);
    const browserErrors = [];
    const missingResources = [];
    const managerContext = await browser.newContext({
      baseURL: "http://127.0.0.1:5000",
      viewport: {width: 1280, height: 800}
    });
    const waiterContext = await browser.newContext({
      baseURL: "http://127.0.0.1:5000",
      viewport: {width: 360, height: 800}
    });
    const manager = await managerContext.newPage();
    const waiter = await waiterContext.newPage();
    manager.on("console", message => {
      if (message.type() === "error") browserErrors.push(`manager: ${message.text()} @ ${message.location().url}`);
    });
    waiter.on("console", message => {
      if (message.type() === "error") browserErrors.push(`waiter: ${message.text()} @ ${message.location().url}`);
    });
    manager.on("response", response => {
      if (response.status() === 404) missingResources.push(`manager: ${response.url()}`);
    });
    waiter.on("response", response => {
      if (response.status() === 404) missingResources.push(`waiter: ${response.url()}`);
    });
    await installLayoutShiftObserver(waiter);

    try {
      await Promise.all([manager.goto("/admin"), waiter.goto("/waiter")]);
      await expect(manager.locator("#connection")).toHaveText("Connected");
      await expect(waiter.locator("#connection")).toHaveText("Connected");

      manager.once("dialog", dialog => dialog.accept());
      await manager.locator("#reset").click();
      await expect(manager.locator("#action-status")).toHaveText("Demo reset complete.");
      await expect(manager.locator("#active-count")).toHaveText("0");
      await expect(manager.locator("#history-count")).toHaveText("0");
      await expect(waiter.locator("#idle")).toBeVisible({timeout: 5_000});
      await expect(manager.locator("#table-select option")).toHaveCount(2);

      const badRequest = await managerContext.request.post("/api/tasks", {
        data: {table_id: "missing", type: "DELIVER_ORDER"}
      });
      expect(badRequest.status()).toBe(400);
      expect((await badRequest.json()).error).toContain("configured table");
      const missingTask = await managerContext.request.post("/api/tasks/999999/start");
      expect(missingTask.status()).toBe(404);
      expect((await missingTask.json()).error).toBe("Task not found.");

      await manager.locator("#table-select").selectOption("table_1");
      await manager.locator("#deliver").click();
      await expect(manager.locator("#action-status")).toHaveText("Task sent to Table 1.");
      await expect(manager.locator("#active-count")).toHaveText("1");
      await expect(waiter.locator("#table-name")).toHaveText("Table 1", {timeout: 5_000});
      await expect(waiter.locator("#task-title")).toHaveText("Deliver order");
      await waiter.locator("#task-action").click();
      await expect(waiter.locator("#task-action")).toHaveText("Mark delivered");
      await waiter.locator("#task-action").click();
      await expect(manager.locator("#history-count")).toHaveText("1", {timeout: 5_000});
      await expect(manager.locator("#active-count")).toHaveText("0");

      const completedDelivery = await manager.evaluate(async () => {
        const state = await (await fetch("/api/state")).json();
        const task = state.completed_tasks.find(candidate => candidate.type === "DELIVER_ORDER");
        const repeated = await fetch(`/api/tasks/${task.id}/complete`, {method: "POST"});
        const payload = await repeated.json();
        const after = await (await fetch("/api/state")).json();
        return {
          status: repeated.status,
          changed: payload.changed,
          completionEvents: after.events.filter(event => event.task_id === task.id && event.kind === "TASK_COMPLETED").length
        };
      });
      expect(completedDelivery).toEqual({status: 200, changed: false, completionEvents: 1});

      await manager.locator("#table-select").selectOption("table_2");
      await manager.locator("#take-order").click();
      await expect(manager.locator("#action-status")).toHaveText("Task sent to Table 2.");
      await manager.locator("#take-order").click();
      await expect(manager.locator("#action-status")).toHaveText("Active task already exists for Table 2.");
      await manager.locator("#table-select").selectOption("table_1");
      await manager.locator("#deliver").click();
      await expect(manager.locator("#active-count")).toHaveText("2");

      await expect(waiter.locator("#queue-count")).toHaveText("All tasks (2)", {timeout: 5_000});
      await expect(waiter.locator("#up-next-list .up-next-row")).toHaveCount(1);
      await waiter.locator("#queue-toggle").click();
      const takeOrderRow = waiter.locator('#task-list button[data-task-id]').filter({hasText: "Take order"});
      await takeOrderRow.click();
      await expect(takeOrderRow).toHaveAttribute("aria-current", "true");
      await expect(waiter.locator("#task-number")).toContainText("Current task");
      await expect(waiter.locator("#recommendation-reminder")).toContainText("Table 1 — Deliver order");

      const selectedTaskId = Number(await takeOrderRow.getAttribute("data-task-id"));
      const premature = await waiterContext.request.post(`/api/tasks/${selectedTaskId}/complete`);
      expect(premature.status()).toBe(409);
      expect((await premature.json()).error).toBe("Start this task before completing it.");

      await waiter.locator("#task-action").click();
      await expect(waiter.locator("#order-editor")).toBeVisible();
      await waiter.locator("#add-item").click();
      let rows = waiter.locator(".order-item");
      await rows.nth(0).locator('[name="dish_name"]').fill("Pizza");
      await rows.nth(0).locator('[name="quantity"]').fill("2");
      await rows.nth(0).locator('[name="notes"]').fill("One without olives");
      await waiter.locator("#add-item").click();
      rows = waiter.locator(".order-item");
      await rows.nth(1).locator('[name="dish_name"]').fill("Pasta");
      await rows.nth(1).locator('[name="quantity"]').fill("1");
      await rows.nth(1).locator('[name="notes"]').fill("Sauce on the side");
      await waiter.locator("#save-draft").click();
      await expect(waiter.locator("#draft-state")).toHaveText("Draft saved");

      await waiter.reload();
      await expect(waiter.locator("#connection")).toHaveText("Connected");
      await waiter.locator("#up-next-list .up-next-row").filter({hasText: "Take order"}).click();
      await expect(waiter.locator("#task-title")).toHaveText("Take order");
      await waiter.locator("#task-action").click();
      await expect(waiter.locator(".order-item")).toHaveCount(2);
      await expect(waiter.locator(".order-item").nth(0).locator('[name="dish_name"]')).toHaveValue("Pizza");
      await expect(waiter.locator(".order-item").nth(1).locator('[name="dish_name"]')).toHaveValue("Pasta");
      await waiter.locator("#confirm-draft").click();
      await expect(waiter.locator("#confirmed-summary")).toContainText("2 × Pizza");
      await expect(waiter.locator("#confirmed-summary")).toContainText("1 × Pasta");
      await expect(waiter.locator("#confirmed-state")).toContainText("Nothing was sent to a kitchen or POS.");

      await waiter.locator("#edit-draft").click();
      await waiter.locator(".order-item").nth(1).locator('[name="quantity"]').fill("3");
      await waiter.locator(".order-item").nth(1).locator('[name="notes"]').fill("Sauce on the side, no parmesan");
      await waiter.locator("#save-draft").click();
      await expect(waiter.locator("#draft-state")).toHaveText("Draft saved");
      await waiter.locator("#back-to-task").click();
      await expect(waiter.locator("#confirmed-state")).toBeHidden();
      const invalidated = await waiterContext.request.post(`/api/tasks/${selectedTaskId}/complete`);
      expect(invalidated.status()).toBe(409);
      expect((await invalidated.json()).error).toContain("confirm the order draft");
      await waiter.locator("#task-action").click();
      await waiter.locator("#confirm-draft").click();
      await expect(waiter.locator("#confirmed-summary")).toContainText("3 × Pasta");
      await expect(waiter.locator("#confirmed-summary")).toContainText("no parmesan");
      await waiter.locator("#task-action").click();
      await expect(manager.locator("#history-count")).toHaveText("2", {timeout: 5_000});

      await expect(waiter.locator("#task-title")).toHaveText("Deliver order");
      await waiter.locator("#task-action").click();
      await waiter.locator("#task-action").click();
      await expect(waiter.locator("#idle")).toBeVisible();
      await expect(manager.locator("#history-count")).toHaveText("3", {timeout: 5_000});
      await expect(manager.locator("#active-count")).toHaveText("0");
      await expectNoHorizontalOverflow(waiter);

      await waiter.screenshot({path: path.join(finalQaDir, "waiter-final-360x800.png"), fullPage: true});
      await manager.screenshot({path: path.join(finalQaDir, "manager-final-1280x800.png"), fullPage: true});

      manager.once("dialog", dialog => dialog.accept());
      await manager.locator("#reset").click();
      await expect(manager.locator("#active-count")).toHaveText("0");
      await expect(manager.locator("#history-count")).toHaveText("0");
      await expect(manager.locator("#table-select option")).toHaveCount(2);
      await expect(manager.locator("#table-select option").nth(0)).toHaveText("Table 1");
      await expect(manager.locator("#table-select option").nth(1)).toHaveText("Table 2");

      const layout = await waiter.evaluate(() => ({
        cls: window.__attendaLayoutShift,
        entries: window.__attendaLayoutShiftEntries
      }));
      console.log(`LAYOUT_SHIFT_FULL_JOURNEY ${JSON.stringify(layout)}`);
      console.log(`MISSING_RESOURCES_FULL_JOURNEY ${JSON.stringify(missingResources)}`);
      expect(layout.cls).toBeLessThanOrEqual(0.01);
      expect(browserErrors).toEqual([]);
    } finally {
      await waiterContext.close();
      await managerContext.close();
    }
  });
});
