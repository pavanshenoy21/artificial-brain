// End-to-end tests of the UI against the in-memory mock backend (browser build).
// `npm run test:e2e`. First time on a new machine: `npx playwright install chromium`.
import { defineConfig } from "@playwright/test";
import fs from "node:fs";

// Cloud containers ship a Chromium at a fixed path; use it when present.
const cloudChromium = "/opt/pw-browsers/chromium";

export default defineConfig({
  testDir: "tests/e2e",
  timeout: 60_000,
  expect: { timeout: 8_000 },
  fullyParallel: true,
  workers: 3,
  reporter: [["list"]],
  use: {
    baseURL: "http://localhost:1420",
    viewport: { width: 1400, height: 860 },
    launchOptions: {
      ...(fs.existsSync(cloudChromium) ? { executablePath: cloudChromium } : {}),
      args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"],
    },
  },
  webServer: {
    command: "npx vite --port 1420 --strictPort",
    url: "http://localhost:1420",
    reuseExistingServer: true,
    timeout: 60_000,
  },
});
