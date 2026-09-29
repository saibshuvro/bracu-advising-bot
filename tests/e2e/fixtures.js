const path = require('path');
const { test: base, expect, chromium } = require('@playwright/test');

const MOCK = 'http://localhost:8787';
const EXTENSION = path.join(__dirname, '..', '..', 'extension');

// Extensions need Playwright's own Chromium (branded Chrome ignores --load-extension).
const test = base.extend({
  context: async ({}, use) => {
    const context = await chromium.launchPersistentContext('', {
      channel: 'chromium',
      viewport: { width: 1400, height: 900 },
      args: [`--disable-extensions-except=${EXTENSION}`, `--load-extension=${EXTENSION}`],
    });
    await use(context);
    await context.close();
  },
  sw: async ({ context }, use) => {
    let [sw] = context.serviceWorkers();
    if (!sw) sw = await context.waitForEvent('serviceworker');
    await use(sw);
  },
  extensionId: async ({ sw }, use) => {
    await use(new URL(sw.url()).host);
  },
});

async function resetMock(overrides = {}) {
  const res = await fetch(`${MOCK}/__mock/reset`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(overrides),
  });
  expect(res.ok).toBeTruthy();
}

const mockEvents = async () => (await fetch(`${MOCK}/__mock/events`)).json();

async function openPortal(context, path = '/student/advising/self-registration') {
  const page = await context.newPage();
  page.on('console', (m) => {
    if (process.env.DEBUG_CONSOLE) console.log(`[page] ${m.text()}`);
  });
  await page.goto(MOCK + path);
  return page;
}

async function openPopup(context, extensionId) {
  const popup = await context.newPage();
  popup.on('dialog', (d) => d.accept()); // the "Dry run is OFF" confirmation
  await popup.goto(`chrome-extension://${extensionId}/popup/popup.html`);
  return popup;
}

const localInput = (ms) => {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
};

// Fill the popup form. Fast defaults so tests don't wait on production timings.
async function fillPopup(popup, opts) {
  const o = {
    program: 'MENGGCSE(POSTGRADUATE)',
    dryRun: false,
    reloadIntervalSec: 1,
    openWaitMin: 1,
    resultTimeoutSec: 10,
    maxAttempts: 2,
    keepAliveMin: 0,
    preflightMin: 0,
    ...opts,
  };
  await popup.fill('#program', o.program);
  await popup.fill('#courses', o.courses);
  if (o.startAt) await popup.fill('#startAt', localInput(o.startAt));
  await popup.setChecked('#dryRun', o.dryRun);
  await popup.locator('details:has(#reloadIntervalSec)').evaluate((d) => (d.open = true));
  if (o.acceptRepeatRetake !== undefined) await popup.setChecked('#acceptRepeatRetake', o.acceptRepeatRetake);
  for (const k of ['reloadIntervalSec', 'openWaitMin', 'resultTimeoutSec', 'maxAttempts', 'keepAliveMin', 'preflightMin']) {
    await popup.fill(`#${k}`, String(o[k]));
  }
}

const storage = (sw, key) => sw.evaluate((k) => chrome.storage.local.get(k).then((r) => r[k] || null), key);

async function waitForRunEnd(sw, timeout = 90_000) {
  let progress = null;
  await expect
    .poll(
      async () => {
        progress = await storage(sw, 'progress');
        return progress?.status;
      },
      { timeout, intervals: [250] }
    )
    .toMatch(/^(done|failed|stopped)$/);
  return progress;
}

const statuses = (progress) => Object.fromEntries(progress.courses.map((c) => [c.text, c.status]));

module.exports = { test, expect, resetMock, mockEvents, openPortal, openPopup, fillPopup, storage, waitForRunEnd, statuses };
