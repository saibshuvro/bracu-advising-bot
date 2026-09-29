(async function () {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const LIMITS = { reloadIntervalSec: [1, 60], openWaitMin: [1, 60], resultTimeoutSec: [5, 120], maxAttempts: [1, 5], keepAliveMin: [0, 60], preflightMin: [0, 10] };
  const NUMBERS = Object.keys(LIMITS);
  const CHECKBOXES = ['dryRun', 'bringToFront', 'acceptRepeatRetake'];
  const ICON = { pending: '•', searching: '…', adding: '⏳', added: '✔', already: '✔', 'dry-run': '✓', failed: '✖', 'not-found': '✖', skipped: '–' };
  const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[ch]);
  const send = (msg) => chrome.runtime.sendMessage(msg).catch((e) => ({ ok: false, error: e.message }));

  const pad = (n) => String(n).padStart(2, '0');
  const toLocalInput = (ms) => {
    const d = new Date(ms);
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  };
  const fromLocalInput = (v) => (v ? new Date(v).getTime() : null); // no zone suffix, so it's read as local time

  // ---------- form ----------

  const stored = (await chrome.storage.local.get(AB.KEYS.config))[AB.KEYS.config] || {};
  const initial = { ...AB.DEFAULT_CONFIG, ...stored };
  $('program').value = initial.program;
  $('courses').value = initial.coursesText;
  $('startAt').value = toLocalInput(initial.startAt && initial.startAt > Date.now() ? initial.startAt : Math.ceil((Date.now() + 5 * 60000) / 60000) * 60000);
  CHECKBOXES.forEach((k) => ($(k).checked = !!initial[k]));
  NUMBERS.forEach((k) => ($(k).value = initial[k]));

  function readForm() {
    const c = { program: $('program').value.trim(), coursesText: $('courses').value, startAt: fromLocalInput($('startAt').value) };
    CHECKBOXES.forEach((k) => (c[k] = $(k).checked));
    NUMBERS.forEach((k) => {
      const n = Number($(k).value);
      const [min, max] = LIMITS[k];
      c[k] = Number.isFinite(n) && $(k).value !== '' ? Math.min(max, Math.max(min, n)) : AB.DEFAULT_CONFIG[k];
    });
    c.maxAttempts = Math.round(c.maxAttempts);
    return c;
  }
  const saveForm = () => chrome.storage.local.set({ [AB.KEYS.config]: readForm() });

  function validateCourses() {
    const result = AB.parseCourseList($('courses').value);
    $('coursesError').textContent = result.errors.join('\n');
    return result;
  }

  $('form').addEventListener('input', () => {
    saveForm();
    validateCourses();
  });
  validateCourses();

  async function start(now) {
    $('formError').textContent = '';
    $('formNote').textContent = '';
    const c = readForm();
    await saveForm();
    const { entries, errors } = validateCourses();
    if (errors.length) return ($('formError').textContent = 'Fix the course list first.');
    if (!entries.length) return ($('formError').textContent = 'Add at least one course.');
    if (!now && !(c.startAt > Date.now() + 5000)) return ($('formError').textContent = 'Pick a start time at least a few seconds in the future.');
    if (!c.dryRun) {
      const when = now ? 'right now' : `at ${AB.fmtDateTime(c.startAt)}`;
      if (!confirm(`Dry run is OFF.\n\nThe bot will really add ${entries.length} course(s) ${when}. Continue?`)) return;
    }
    const res = await send({ type: now ? 'RUN_NOW' : 'ARM', config: c });
    if (!res?.ok) $('formError').textContent = res?.error || 'Something went wrong.';
    else if (res.warning) $('formError').textContent = res.warning;
    else if (res.reloadedTab) $('formNote').textContent = "The advising tab couldn't hear the extension (it was open before the extension was reloaded), so it was reloaded. The bot continues there.";
  }

  $('form').addEventListener('submit', (e) => {
    e.preventDefault();
    start(false);
  });
  $('runNow').addEventListener('click', () => start(true));
  $('stop').addEventListener('click', () => send({ type: 'STOP' }));

  // ---------- run status ----------

  let job = null;
  let progress = null;
  const data = await chrome.storage.local.get([AB.KEYS.job, AB.KEYS.progress]);
  job = data[AB.KEYS.job] || null;
  progress = data[AB.KEYS.progress] || null;
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (AB.KEYS.job in changes) job = changes[AB.KEYS.job].newValue || null;
    if (AB.KEYS.progress in changes) progress = changes[AB.KEYS.progress].newValue || null;
    render();
  });
  setInterval(render, 1000);
  render();

  function render() {
    const p = job && progress?.runId === job.runId ? progress : null;
    const armed = job?.state === 'armed';
    let text = 'Idle';
    let cls = '';
    if (armed && !p) [text, cls] = [`Armed: ${AB.fmtCountdown(job.startAt - Date.now())}`, 'armed'];
    else if (armed && p?.status === 'running') [text, cls] = ['Running', 'running'];
    else if (p?.status === 'done') [text, cls] = ['Done', 'done'];
    else if (p?.status === 'failed') [text, cls] = ['Failed', 'failed'];
    else if (p?.status === 'stopped' || job?.state === 'stopped') [text, cls] = ['Stopped', 'failed'];
    $('state').textContent = text;
    $('state').className = `pill ${cls}`;
    $('stop').hidden = !armed;
    $('arm').hidden = armed;
    $('runNow').hidden = armed;

    $('run').hidden = !job;
    if (!job) return;
    const mode = `${job.config.dryRun ? 'DRY RUN' : 'LIVE'}${job.pageName ? ` on ${job.pageName}` : ''}`;
    let status;
    if (!p) status = `${mode}: starts ${AB.fmtDateTime(job.startAt)}${armed ? ` (in ${AB.fmtCountdown(job.startAt - Date.now())})` : ''}`;
    else if (p.status === 'running') status = `${mode}: running since ${AB.fmtTime(p.startedAt)}${p.current ? `, now on ${p.current}` : ''}`;
    else status = `${mode}: ${p.status}${p.error ? `: ${p.error}` : ''}. ${AB.summarize(p)}`;
    $('runStatus').textContent = status;

    const courses = p?.courses || job.courses.map((c) => ({ ...c, status: 'pending', message: '' }));
    $('runCourses').innerHTML = courses
      .map((c) => {
        const tone = ['added', 'already', 'dry-run'].includes(c.status) ? 'ok' : ['failed', 'not-found'].includes(c.status) ? 'bad' : '';
        return `<li><span class="${tone}">${ICON[c.status] || '•'} ${esc(c.text)}</span> <span class="muted">${esc(c.status)}</span>${c.message ? `<span class="msg">${esc(c.message)}</span>` : ''}</li>`;
      })
      .join('');
    const lines = (p?.log || []).slice(-60);
    $('runLog').innerHTML = lines.map((l) => `<li>${esc(AB.fmtTime(l.t))} ${esc(l.msg)}</li>`).join('');
  }

  // ---------- check page ----------

  const ok = (t) => `<li class="ok">✔ ${esc(t)}</li>`;
  const bad = (t) => `<li class="bad">✖ ${esc(t)}</li>`;
  const warn = (t) => `<li class="warn">! ${esc(t)}</li>`;

  $('check').addEventListener('click', async () => {
    $('report').hidden = false;
    $('reportList').innerHTML = '<li>Checking…</li>';
    const program = $('program').value.trim();
    const res = await send({ type: 'CHECK', program });
    if (!res?.ok) return ($('reportList').innerHTML = bad(res?.error || 'Check failed'));
    const r = res.report;
    const items = [];
    if (res.reloadedTab) items.push(warn('The tab was reloaded first: it was open before the extension was (re)loaded, so it couldn\'t hear the extension.'));
    if (!r) {
      items.push(bad("The advising tab isn't responding. Reload it and try again."));
    } else {
      items.push(r.state === 'wrong-page' ? bad(r.message) : ok(`The tab is on ${r.page}`));
      const labels = r.programOptions.map((o) => `${o.label}${o.checked ? ' (selected)' : ''}`).join(', ');
      if (r.state === 'ready') items.push(ok(program ? `${program} is loaded` : `${r.loadedProgram} is loaded (Program is empty, so the bot will use it)`));
      else if (r.state === 'ambiguous') items.push(bad(r.message));
      else if (r.state === 'selector') {
        items.push(ok(`Select Advising offers: ${labels}`));
        if (r.message) items.push(warn(`The selected program shows "${r.message}". That's normal: the bot switches to ${program} first, then checks whether it's open.`));
      }
      else if (r.state === 'not-open') items.push(warn(`Not open yet: "${r.message}". Fine before your slot; the bot reloads at the start time.`));
      else if (r.state === 'other-program') items.push(warn(r.message));
      else if (r.state === 'loading') items.push(warn('The page is still loading'));
      else if (r.state !== 'wrong-page') items.push(bad(r.message || r.state));
      if (r.state === 'ready') {
        items.push(r.quickFilter ? ok('Search box found') : bad('Search box not found'));
        if (!r.available) items.push(bad('Available Courses table not found'));
        else {
          items.push(ok(`Available Courses: ${r.available.count} sections (${r.available.drawn} drawn, ${r.available.parsed} read OK${r.available.sample ? `, e.g. ${r.available.sample}` : ''})`));
          items.push(r.available.addButton ? ok('+ buttons found') : bad('+ button not found'));
        }
        items.push(r.selected ? ok(`Selected Sections: ${r.selected.labels.join(', ') || 'none yet'}`) : bad('Selected Sections table not found'));
      }
      items.push(r.visibility === 'visible' ? ok('The tab is visible') : warn('The tab is in the background (it will be brought to the front before the start)'));
    }
    const clock = res.clock;
    if (!clock || clock.error) items.push(warn(`Couldn't compare clocks: ${clock?.error || 'no answer'}`));
    else {
      const s = clock.offsetMs / 1000;
      const pm = (clock.plusMinusMs / 1000).toFixed(1);
      if (Math.abs(clock.offsetMs) <= 1500) items.push(ok(`Your clock matches the portal's (±${pm} s)`));
      else items.push(warn(`Your clock is ${Math.abs(s).toFixed(1)} s ${s > 0 ? 'behind' : 'ahead of'} the portal (±${pm} s). Fix the system clock.`));
    }
    $('reportList').innerHTML = items.join('');
  });

  $('copySnapshot').addEventListener('click', async () => {
    const res = await send({ type: 'SNAPSHOT' });
    if (!res?.ok) return ($('copyDone').textContent = res?.error || 'Failed');
    try {
      await navigator.clipboard.writeText(res.html);
    } catch {
      const ta = Object.assign(document.createElement('textarea'), { value: res.html });
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      ta.remove();
    }
    $('copyDone').textContent = `Copied ${res.html.length.toLocaleString()} characters. Paste them into a file for debugging.`;
  });
})();
