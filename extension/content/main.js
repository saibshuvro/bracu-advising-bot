/* Content-script entry point: knows which tab it is, owns the precise start timer, and starts or resumes the run. */
(function (AB) {
  'use strict';

  const P = AB.portal;
  let tabId = null;
  let job = null;
  let progress = null;
  let controller = null;
  let running = false;
  let startTimer = null;
  let lastPath = location.pathname;

  const mine = () => !!job && tabId != null && job.tabId === tabId;
  const onJobPage = () => P.isPagePath(job.pagePath); // the page the tab was on when you armed it

  function evaluate() {
    AB.overlay.update(mine() && onJobPage() ? job : null, progress);
    if (!mine() || job.state !== 'armed') {
      clearTimeout(startTimer);
      controller?.abort();
      return;
    }
    if (progress?.runId === job.runId) {
      if (progress.status === 'running' && !running) startRun(); // resume after a reload
      return;
    }
    if (!running) scheduleStart(job.startAt);
  }

  // The tab wandered off the page (the portal is a single-page app): go back to it.
  function goToPage() {
    if (AB.leaving) return;
    AB.leaving = true;
    location.assign(job.pagePath || AB.PAGES[0].path);
  }

  // setTimeout for the long wait, then a short spin so the run starts within a few ms of the chosen time.
  function scheduleStart(at) {
    clearTimeout(startTimer);
    const tick = () => {
      const left = at - Date.now();
      if (left <= 0) return startRun();
      if (left > 2000) startTimer = setTimeout(tick, Math.min(left - 1500, 30000));
      else if (left > 25) startTimer = setTimeout(tick, left - 20);
      else {
        while (Date.now() < at) {
          /* spin the last few milliseconds */
        }
        startRun();
      }
    };
    tick();
  }

  async function startRun() {
    if (running || AB.leaving || !mine() || job.state !== 'armed') return;
    if (!onJobPage()) return goToPage();
    running = true;
    clearTimeout(startTimer);
    controller = new AbortController();
    try {
      await AB.runner.run(job, controller.signal);
    } catch (e) {
      console.error('[Advising Bot]', e);
    } finally {
      running = false;
      controller = null;
    }
  }

  function onMessage(msg, _sender, sendResponse) {
    switch (msg?.type) {
      case 'EVALUATE':
        evaluate();
        sendResponse({ ok: true });
        break;
      case 'CHECK':
        sendResponse(P.check(msg.program || job?.config?.program || AB.DEFAULT_CONFIG.program));
        break;
      case 'SNAPSHOT':
        sendResponse({ html: P.snapshot() });
        break;
      case 'PING':
        sendResponse({ ok: true, tabId, path: location.pathname, visibility: document.visibilityState });
        break;
      default:
        return false;
    }
    return false;
  }

  async function boot() {
    const res = await chrome.runtime.sendMessage({ type: 'HELLO' }).catch(() => null);
    tabId = res?.tabId ?? null;
    const data = await chrome.storage.local.get([AB.KEYS.job, AB.KEYS.progress]);
    job = data[AB.KEYS.job] || null;
    progress = data[AB.KEYS.progress] || null;
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local') return;
      if (AB.KEYS.job in changes) job = changes[AB.KEYS.job].newValue || null;
      if (AB.KEYS.progress in changes) progress = changes[AB.KEYS.progress].newValue || null;
      evaluate();
    });
    chrome.runtime.onMessage.addListener(onMessage);
    AB.overlay.onStop(() => {
      controller?.abort();
      chrome.runtime.sendMessage({ type: 'STOP' }).catch(() => {});
    });
    document.addEventListener('visibilitychange', () => {
      if (mine() && job.state === 'armed' && !running && progress?.runId !== job.runId) scheduleStart(job.startAt);
    });
    // The portal is a single-page app: notice when it navigates to or away from the page.
    setInterval(() => {
      if (location.pathname !== lastPath) {
        lastPath = location.pathname;
        evaluate();
      }
    }, 1000);
    evaluate();
  }

  boot();
})(globalThis.AB);
