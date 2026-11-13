const { defineConfig } = require("@playwright/test");

module.exports = defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  workers: 1,
  timeout: 30_000,
  expect: { timeout: 6_000 },
  reporter: [["line"]],
  use: {
    baseURL: "http://127.0.0.1:5000",
    browserName: "chromium",
    channel: "msedge",
    headless: true,
    trace: "retain-on-failure"
  },
  webServer: {
    command: ".\\.venv\\Scripts\\python.exe -m app.web",
    url: "http://127.0.0.1:5000/api/state",
    reuseExistingServer: true,
    timeout: 20_000
  }
});
