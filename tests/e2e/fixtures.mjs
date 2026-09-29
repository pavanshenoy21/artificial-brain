// Shared setup: every test gets a fresh page (fresh mock vault, empty
// localStorage) and fails if the page logs an error it didn't expect.
import { test as base, expect } from "@playwright/test";

export const test = base.extend({
  errors: async ({ page }, use) => {
    const errors = [];
    page.on("pageerror", e => errors.push(`pageerror: ${e.message}`));
    page.on("console", m => {
      if (m.type() === "error" && !/favicon|GPU stall|GL Driver|WebGL context lost/.test(m.text())) errors.push(m.text());
    });
    await use(errors);
    expect(errors, "no errors in the page").toEqual([]);
  },
});
export { expect };

// Open the app and wait until the vault has loaded.
export async function openApp(page, query = "") {
  await page.goto("/" + query);
  await page.waitForFunction(() => window.brain?.app?.loaded === true);
}

export const byTitle = (page, title) =>
  page.evaluate(t => [...window.brain.app.items.values()].find(n => n.title === t) || null, title);

export const idOf = async (page, title) => (await byTitle(page, title))?.id;

// Turn on the browser preview's fake AI (deterministic, no network).
export async function aiOn(page) {
  await page.evaluate(async () => {
    const s = await window.brain.api.getSettings();
    s.ai.provider = "groq";
    s.ai.base_url = "https://api.groq.com/openai/v1";
    const r = await window.brain.api.saveSettings(s);
    window.brain.app.settings = r;
    window.brain.app.emit("settings", r);
  });
}
