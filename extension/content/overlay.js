/* A small status panel on the page (Shadow DOM, so the portal's CSS can't touch it). */
(function (AB) {
  'use strict';

  const ICON = {
    pending: '•',
    searching: '…',
    adding: '⏳',
    added: '✔',
    already: '✔',
    'dry-run': '✓',
    failed: '✖',
    'not-found': '✖',
    skipped: '–',
  };

  const CSS = `
    :host { all: initial; }
    .box { position: fixed; left: 16px; bottom: 16px; z-index: 2147483000; width: 330px; max-height: 60vh; overflow: auto;
      font: 13px/1.4 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; color: #1f2937; background: #fff;
      border: 1px solid #d1d5db; border-radius: 10px; box-shadow: 0 8px 24px rgba(0,0,0,.18); }
    header { display: flex; align-items: center; gap: 8px; padding: 8px 10px; border-bottom: 1px solid #e5e7eb; }
    header b { flex: 1; font-size: 13px; }
    .badge { font-size: 11px; font-weight: 700; padding: 2px 6px; border-radius: 4px; letter-spacing: .02em; }
    .dry { background: #fef3c7; color: #92400e; }
    .live { background: #fee2e2; color: #b91c1c; }
    button { font: inherit; cursor: pointer; border-radius: 6px; border: 1px solid #d1d5db; background: #f9fafb; padding: 2px 8px; }
    .body { padding: 8px 10px; }
    .status { font-weight: 600; margin-bottom: 6px; }
    .hint { color: #6b7280; font-size: 12px; margin-bottom: 6px; }
    ul { list-style: none; margin: 0 0 6px; padding: 0; }
    li { display: grid; grid-template-columns: 16px auto; column-gap: 6px; padding: 2px 0; }
    li .msg { grid-column: 2; color: #6b7280; font-size: 12px; word-break: break-word; }
    .ok { color: #047857; } .bad { color: #b91c1c; } .busy { color: #1d4ed8; }
    .log { color: #6b7280; font-size: 12px; border-top: 1px dashed #e5e7eb; padding-top: 6px; word-break: break-word; }
    .actions { display: flex; gap: 8px; margin-top: 8px; }
    .stop { background: #dc2626; border-color: #dc2626; color: #fff; font-weight: 700; padding: 4px 14px; }
    .collapsed .body { display: none; }
  `;

  let host = null;
  let root = null;
  let state = { job: null, progress: null };
  let ticker = null;
  let collapsed = false;
  let dismissedRunId = null;
  let stopHandler = () => {};

  const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[ch]);

  function mount() {
    if (host?.isConnected) return;
    host = document.createElement('advising-bot-overlay');
    root = host.attachShadow({ mode: 'open' });
    root.innerHTML = `<style>${CSS}</style><div class="box"></div>`;
    root.addEventListener('click', (e) => {
      const action = e.target.closest('[data-action]')?.dataset.action;
      if (action === 'stop') stopHandler();
      if (action === 'toggle') {
        collapsed = !collapsed;
        draw();
      }
      if (action === 'close') {
        dismissedRunId = state.job?.runId;
        draw();
      }
    });
    document.documentElement.appendChild(host);
  }

  function statusLine(job, p) {
    if (p?.runId === job.runId) {
      if (p.status === 'running') return { cls: 'busy', text: p.current ? `Running: ${p.current}` : 'Running…' };
      if (p.status === 'done') return { cls: 'ok', text: `Done: ${AB.summarize(p)}` };
      if (p.status === 'stopped') return { cls: 'bad', text: 'Stopped' };
      if (p.status === 'failed') return { cls: 'bad', text: `Failed: ${p.error || ''}` };
    }
    if (job.state === 'armed') {
      const left = job.startAt - Date.now();
      return { cls: '', text: left > 0 ? `Armed: starts at ${AB.fmtTime(job.startAt)} (in ${AB.fmtCountdown(left)})` : 'Starting…' };
    }
    return { cls: 'bad', text: 'Stopped' };
  }

  function draw() {
    const { job, progress } = state;
    if (!job || dismissedRunId === job.runId) {
      host?.remove();
      host = null;
      return;
    }
    mount();
    const p = progress?.runId === job.runId ? progress : null;
    const active = job.state === 'armed' && (!p || p.status === 'running');
    const courses = p?.courses || job.courses.map((c) => ({ ...c, status: 'pending', message: '' }));
    const line = statusLine(job, p);
    const last = p?.log?.[p.log.length - 1];
    const cls = (s) => (['added', 'already', 'dry-run'].includes(s) ? 'ok' : ['failed', 'not-found'].includes(s) ? 'bad' : s === 'adding' || s === 'searching' ? 'busy' : '');
    root.querySelector('.box').className = `box${collapsed ? ' collapsed' : ''}`;
    root.querySelector('.box').innerHTML = `
      <header>
        <b>Advising Bot</b>
        <span class="badge ${job.config.dryRun ? 'dry' : 'live'}">${job.config.dryRun ? 'DRY RUN' : 'LIVE'}</span>
        <button data-action="toggle" title="${collapsed ? 'Expand' : 'Collapse'}">${collapsed ? '▴' : '▾'}</button>
      </header>
      <div class="body">
        <div class="status ${line.cls}">${esc(line.text)}</div>
        ${active ? '<div class="hint">Keep this tab open and visible, and don\'t open the advising page in another tab.</div>' : ''}
        <ul>${courses
          .map((c) => `<li><span class="${cls(c.status)}">${ICON[c.status] || '•'}</span><span>${esc(c.text)}</span>${c.message ? `<span class="msg">${esc(c.message)}</span>` : ''}</li>`)
          .join('')}</ul>
        ${last ? `<div class="log">${esc(AB.fmtTime(last.t))} ${esc(last.msg)}</div>` : ''}
        <div class="actions">${active ? '<button class="stop" data-action="stop">STOP</button>' : '<button data-action="close">Close</button>'}</div>
      </div>`;
  }

  function update(job, progress) {
    state = { job, progress };
    clearInterval(ticker);
    const p = progress?.runId === job?.runId ? progress : null;
    if (job?.state === 'armed' && !p) ticker = setInterval(draw, 500);
    draw();
  }

  AB.overlay = {
    update,
    onStop(fn) {
      stopHandler = fn;
    },
  };
})(globalThis.AB);
