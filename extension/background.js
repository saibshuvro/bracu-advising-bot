/* Background service worker: arming, alarms, the advising tab, keep-awake and notifications.
 * The run itself happens in the content script (content/runner.js). */
importScripts('shared/config.js');

const { KEYS } = AB;
const ALARMS = ['keepalive', 'preflight', 'preflight-check', 'prepare', 'start'];

const NO_TAB = `Open the advising page first (${AB.PAGE_NAMES}).`;
const MANY_TABS = 'More than one advising tab is open. Close the extra ones: the portal kicks out duplicates.';

const read = async (key) => (await chrome.storage.local.get(key))[key];
const write = (obj) => chrome.storage.local.set(obj);

// ---------- messages from the popup and the content script ----------

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  handle(msg, sender).then(sendResponse, (e) => sendResponse({ ok: false, error: e.message }));
  return true;
});

async function handle(msg, sender) {
  switch (msg?.type) {
    case 'HELLO':
      return { tabId: sender.tab?.id ?? null };
    case 'ARM':
      return arm(msg.config, false);
    case 'RUN_NOW':
      return arm(msg.config, true);
    case 'STOP':
      return stop('Stopped by you');
    case 'CHECK':
      return checkPage(msg.program);
    case 'SNAPSHOT':
      return snapshot();
    default:
      return { ok: false, error: `Unknown message ${msg?.type}` };
  }
}

async function findTabs() {
  const tabs = await chrome.tabs.query({ url: AB.TAB_URL_PATTERNS });
  return tabs.map((t) => ({ id: t.id, windowId: t.windowId, url: t.url, title: t.title }));
}

async function advisingTab() {
  const job = await read(KEYS.job);
  if (job?.state === 'armed') {
    const tab = await chrome.tabs.get(job.tabId).catch(() => null);
    if (tab) return tab;
  }
  const tabs = await findTabs();
  if (!tabs.length) throw new Error(NO_TAB);
  if (tabs.length > 1) throw new Error(MANY_TABS);
  return tabs[0];
}

// ---------- arm / run now / stop ----------

async function arm(config, now) {
  const merged = { ...AB.DEFAULT_CONFIG, ...config };
  const parsed = AB.parseCourseList(merged.coursesText);
  if (parsed.errors.length) throw new Error(parsed.errors.join('\n'));
  if (!parsed.entries.length) throw new Error('Add at least one course.');
  merged.program = AB.normText(merged.program);
  if (merged.program && !AB.splitProgram(merged.program)) throw new Error('The program should look like MENGGCSE(POSTGRADUATE), or leave it empty to use the only open program.');
  const tabs = await findTabs();
  if (!tabs.length) throw new Error(NO_TAB);
  if (tabs.length > 1) throw new Error(MANY_TABS);
  const startAt = now ? Date.now() : Number(merged.startAt);
  if (!now && !(startAt > Date.now() + 5000)) throw new Error('Pick a start time at least a few seconds in the future.');

  // What does the page offer right now? Refuse a guess (empty Program, several programs); warn about a name the page doesn't show.
  let warning = '';
  const connected = await ensureConnected(tabs[0].id, { reload: false });
  if (connected) {
    const r = await tabMessage(tabs[0].id, { type: 'CHECK', program: merged.program });
    if (r?.state === 'ambiguous') throw new Error(r.message);
    const offered = r?.programOptions?.map((o) => o.label).join(', ') || r?.loadedProgram || '';
    if (merged.program && offered && r.state === 'other-program') {
      warning = `The page shows ${offered}, not ${merged.program}. Check the Program name (the bot will keep waiting for it).`;
    }
  }

  const old = await read(KEYS.job);
  if (old?.state === 'armed') await stop('Replaced by a new run');

  const job = {
    runId: `run-${Date.now()}`,
    state: 'armed',
    tabId: tabs[0].id,
    windowId: tabs[0].windowId,
    startAt,
    createdAt: Date.now(),
    runNow: now,
    pagePath: AB.pageFor(new URL(tabs[0].url).pathname)?.path,
    pageName: AB.pageFor(new URL(tabs[0].url).pathname)?.name,
    config: { ...merged, startAt },
    courses: parsed.entries,
  };
  await chrome.storage.local.remove(KEYS.progress);
  await write({ [KEYS.job]: job, [KEYS.config]: config });
  await setUpArmed(job);
  if (now && job.config.bringToFront) await bringToFront(job);
  if (connected) tabMessage(job.tabId, { type: 'EVALUATE' });
  else await chrome.tabs.reload(job.tabId).catch(() => {}); // the fresh script picks the job up from storage
  return { ok: true, job, reloadedTab: !connected, warning };
}

async function stop(reason) {
  const job = await read(KEYS.job);
  if (!job) return { ok: true };
  if (job.state === 'armed') await write({ [KEYS.job]: { ...job, state: 'stopped' } });
  const p = await read(KEYS.progress);
  if (p?.runId === job.runId && p.status === 'running') {
    const log = [...(p.log || []), { t: Date.now(), level: 'info', msg: reason }];
    await write({ [KEYS.progress]: { ...p, status: 'stopped', finishedAt: Date.now(), log } });
  }
  await release(job);
  setBadge('', '#6b7280');
  return { ok: true };
}

async function setUpArmed(job) {
  await clearAlarms();
  const c = job.config;
  const T = job.startAt;
  const at = (name, when) => {
    if (when > Date.now() + 1000) chrome.alarms.create(name, { when });
  };
  if (c.keepAliveMin > 0 && T - Date.now() > (c.keepAliveMin + 3) * 60000) {
    chrome.alarms.create('keepalive', { delayInMinutes: c.keepAliveMin, periodInMinutes: c.keepAliveMin });
  }
  if (c.preflightMin > 0) at('preflight', T - c.preflightMin * 60000);
  at('prepare', T - 60000);
  at('start', T);
  try {
    chrome.power.requestKeepAwake('display');
  } catch {}
  chrome.tabs.update(job.tabId, { autoDiscardable: false }).catch(() => {});
  setBadge('ON', '#2563eb');
}

async function release(job) {
  await clearAlarms();
  try {
    chrome.power.releaseKeepAwake();
  } catch {}
  if (job?.tabId) chrome.tabs.update(job.tabId, { autoDiscardable: true }).catch(() => {});
}

async function clearAlarms() {
  await Promise.all(ALARMS.map((name) => chrome.alarms.clear(name)));
}

// ---------- alarms ----------

chrome.alarms.onAlarm.addListener(async (alarm) => {
  const job = await read(KEYS.job);
  if (!job || job.state !== 'armed') return clearAlarms();
  const p = await read(KEYS.progress);
  const running = p?.runId === job.runId && p.status === 'running';
  switch (alarm.name) {
    case 'keepalive':
      // A reload keeps the SSO session alive; never within 3 minutes of the start.
      if (!running && Date.now() < job.startAt - 3 * 60000) chrome.tabs.reload(job.tabId).catch(() => {});
      break;
    case 'preflight':
      if (!running) {
        chrome.tabs.reload(job.tabId).catch(() => {});
        chrome.alarms.create('preflight-check', { when: Date.now() + 30000 });
      }
      break;
    case 'preflight-check':
      await preflightCheck(job);
      break;
    case 'prepare':
    case 'start':
      if (job.config.bringToFront) await bringToFront(job);
      if (running || (await ensureConnected(job.tabId))) tabMessage(job.tabId, { type: 'EVALUATE' });
      break;
  }
});

async function preflightCheck(job) {
  const tab = await chrome.tabs.get(job.tabId).catch(() => null);
  if (!tab) return notify('Advising tab is gone', `Open ${job.pageName || 'the advising page'} again and re-arm the bot.`, true);
  if (/^https:\/\/sso\.bracu\.ac\.bd\//.test(tab.url || '')) {
    return notify('Log in to Connect again!', `Your session expired. Log in before ${AB.fmtTime(job.startAt)} so the bot can start.`, true);
  }
  const report = await tabMessage(job.tabId, { type: 'CHECK', program: job.config.program });
  if (!report) return notify('Advising Bot can\'t see the page', `The advising tab isn't responding. Reload it and check it shows ${job.pageName || 'the advising page'}.`, true);
  if (report.state === 'wrong-page' || report.state === 'blocked' || report.state === 'probation') {
    return notify('Advising Bot pre-flight problem', report.message || report.state, true);
  }
}

async function bringToFront(job) {
  const tab = await chrome.tabs.get(job.tabId).catch(() => null);
  if (!tab) return;
  const win = await chrome.windows.get(tab.windowId).catch(() => null);
  if (win?.state === 'minimized') await chrome.windows.update(tab.windowId, { state: 'normal' }).catch(() => {});
  await chrome.tabs.update(tab.id, { active: true }).catch(() => {});
  await chrome.windows.update(tab.windowId, { focused: true }).catch(() => {});
}

// ---------- the run finishing, the tab going away ----------

chrome.storage.onChanged.addListener(async (changes, area) => {
  if (area !== 'local' || !(KEYS.progress in changes)) return;
  const p = changes[KEYS.progress].newValue;
  const old = changes[KEYS.progress].oldValue;
  if (!p || p.status === old?.status) return;
  const job = await read(KEYS.job);
  if (!job || job.runId !== p.runId || job.state !== 'armed') return; // stop() cleans up by itself
  if (p.status === 'running') return setBadge('RUN', '#16a34a');
  await write({ [KEYS.job]: { ...job, state: 'finished' } });
  await release(job);
  if (p.status === 'done') {
    setBadge('✓', '#16a34a');
    notify(job.config.dryRun ? 'Dry run finished' : 'Advising Bot finished', `${AB.summarize(p)}\n${courseLines(p)}`, true);
  } else {
    setBadge('!', '#dc2626');
    notify(p.status === 'failed' ? 'Advising Bot failed' : 'Advising Bot stopped', `${p.error || AB.summarize(p)}\n${courseLines(p)}`, true);
  }
});

const courseLines = (p) => p.courses.map((c) => `${c.text}: ${c.status}`).join(', ');

chrome.tabs.onRemoved.addListener(async (tabId) => {
  const job = await read(KEYS.job);
  if (job?.state === 'armed' && job.tabId === tabId) {
    await stop('The advising tab was closed');
    notify('Advising Bot stopped', 'The advising tab was closed. Open it again and re-arm.', true);
  }
});

chrome.tabs.onUpdated.addListener(async (tabId, info) => {
  if (!info.url || !/^https:\/\/sso\.bracu\.ac\.bd\//.test(info.url)) return;
  const job = await read(KEYS.job);
  if (job?.state === 'armed' && job.tabId === tabId) {
    notify('Log in to Connect again!', 'The advising tab went to the login page. The bot continues after you log in and the page is back.', true);
  }
});

// Alarms don't always survive a browser restart; rebuild them (or give up if the tab is gone).
async function restore() {
  const job = await read(KEYS.job);
  if (job?.state !== 'armed') return;
  const tab = await chrome.tabs.get(job.tabId).catch(() => null);
  if (!tab) {
    await stop('Chrome restarted and the advising tab is gone');
    return notify('Advising Bot disarmed', 'Chrome restarted, so the advising tab is gone. Open the page and arm again.', true);
  }
  const existing = await chrome.alarms.getAll();
  if (!existing.some((a) => a.name === 'start') && job.startAt > Date.now() + 1000) await setUpArmed(job);
}
chrome.runtime.onStartup.addListener(restore);
restore();

// ---------- check page, snapshot, clock ----------

// A tab opened before the extension was (re)loaded keeps a disconnected content script that can't hear us, and
// Chrome only gives the tab the new one when it reloads. So check first, and reload the tab if needed; the fresh
// script then picks the job up from storage.
async function ensureConnected(tabId, { reload = true } = {}) {
  for (let i = 0; i < 4; i++) {
    const pong = await tabMessage(tabId, { type: 'PING' });
    if (pong?.ok && pong.tabId === tabId) return true;
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (!tab) return false;
    if (tab.status !== 'loading' && i >= 1) break; // loaded, yet silent: the script is disconnected
    await new Promise((r) => setTimeout(r, 1000)); // maybe it's just mid-reload
  }
  if (reload) await chrome.tabs.reload(tabId).catch(() => {});
  return false;
}

async function waitConnected(tabId, timeoutMs = 30000) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const pong = await tabMessage(tabId, { type: 'PING' });
    if (pong?.ok && pong.tabId === tabId) return true;
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

async function tabMessage(tabId, msg) {
  try {
    return await chrome.tabs.sendMessage(tabId, msg);
  } catch {
    return null;
  }
}

async function checkPage(program) {
  const tab = await advisingTab();
  const reloadedTab = !(await ensureConnected(tab.id));
  if (reloadedTab) await waitConnected(tab.id);
  const report = await tabMessage(tab.id, { type: 'CHECK', program });
  const clock = await clockOffset(new URL(tab.url).origin + '/').catch((e) => ({ error: e.message }));
  return { ok: true, tab: { id: tab.id, url: tab.url }, report, clock, reloadedTab };
}

async function snapshot() {
  const tab = await advisingTab();
  if (!(await ensureConnected(tab.id))) await waitConnected(tab.id);
  const res = await tabMessage(tab.id, { type: 'SNAPSHOT' });
  if (!res) throw new Error('The advising tab isn\'t responding. Reload it and try again.');
  return { ok: true, html: res.html };
}

// The portal's HTTP Date header has 1 s resolution: good enough to catch a clock that is seconds off.
async function clockOffset(url) {
  const samples = [];
  for (let i = 0; i < 3; i++) {
    const t0 = Date.now();
    const res = await fetch(url, { method: 'HEAD', cache: 'no-store' });
    const t1 = Date.now();
    const server = Date.parse(res.headers.get('date'));
    if (Number.isFinite(server)) samples.push({ offset: server + 500 - (t0 + t1) / 2, rtt: t1 - t0 });
  }
  if (!samples.length) throw new Error('The portal sent no Date header');
  const best = samples.sort((a, b) => a.rtt - b.rtt)[0];
  return { offsetMs: Math.round(best.offset), plusMinusMs: Math.round(500 + best.rtt / 2) };
}

// ---------- badge & notifications ----------

function setBadge(text, color) {
  chrome.action.setBadgeText({ text });
  chrome.action.setBadgeBackgroundColor({ color });
}

function notify(title, message, important = false) {
  chrome.notifications.create(`ab-${Date.now()}`, {
    type: 'basic',
    iconUrl: 'icons/icon128.png',
    title,
    message: String(message).slice(0, 500),
    priority: 2,
    requireInteraction: important,
  });
}
