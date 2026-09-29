/* The run: reload until registration opens → load the program → add each course, one at a time.
 * Progress is saved to chrome.storage after every step, so a page reload (planned or not) resumes where it left off. */
(function (AB) {
  'use strict';

  const { sleep, waitFor, waitForQuiet, click, setInputValue, BotError } = AB.dom;
  const P = AB.portal;
  const S = AB.swal;

  class ReloadNeeded extends Error {
    constructor(reason, { delayMs = 0, kind = 'reset' } = {}) {
      super(reason);
      this.name = 'ReloadNeeded';
      this.delayMs = delayMs;
      this.kind = kind; // 'open' = still waiting for registration, 'reset' = the portal lost its state
    }
  }

  const MAX_RESET_RELOADS = 8;

  let job = null;
  let progress = null;
  let signal = null;
  const cfg = () => job.config;
  // The program for this run: the one you entered, or (Program left empty) the one found open at the start.
  const target = () => progress?.resolvedProgram || cfg().program;

  // ---------- progress & log ----------

  const save = () => chrome.storage.local.set({ [AB.KEYS.progress]: progress });

  function log(level, msg) {
    console[level === 'error' ? 'error' : 'log'](`[Advising Bot] ${msg}`);
    if (!progress) return;
    progress.log.push({ t: Date.now(), level, msg });
    if (progress.log.length > 300) progress.log.splice(0, progress.log.length - 300);
  }

  function setCourse(c, status, message) {
    c.status = status;
    c.message = message || '';
    if (AB.TERMINAL.has(status)) log(status === 'failed' || status === 'not-found' ? 'warn' : 'info', `${c.text}: ${status}${message ? ` (${message})` : ''}`);
    return save();
  }

  function newProgress() {
    return {
      runId: job.runId,
      status: 'running',
      phase: 'open',
      startedAt: null,
      finishedAt: null,
      reloads: 0,
      resetReloads: 0,
      startReloadDone: false,
      openDeadline: null,
      notFoundReloadDone: false,
      current: null,
      courses: job.courses.map((c) => ({ ...c, status: 'pending', message: '', attempts: 0 })),
      log: [],
      error: null,
    };
  }

  // ---------- entry point ----------

  async function run(theJob, abortSignal) {
    job = theJob;
    signal = abortSignal;
    const stored = (await chrome.storage.local.get(AB.KEYS.progress))[AB.KEYS.progress];
    progress = stored && stored.runId === job.runId ? stored : newProgress();
    if (progress.status !== 'running') return;
    if (!progress.startedAt) {
      progress.startedAt = Date.now();
      log('info', `Run started${cfg().dryRun ? ' as a DRY RUN (answers No instead of Yes)' : ''}`);
    } else {
      log('info', `Page loaded (reload ${progress.reloads}), continuing`);
    }
    await save();
    S.start();

    try {
      if (progress.phase === 'open') await phaseOpen();
      if (progress.phase === 'program') await phaseProgram();
      if (progress.phase === 'courses') await phaseCourses();
      await finish('done');
    } catch (e) {
      if (e.name === 'AbortError') {
        log('info', 'Stopped by you');
        return finish('stopped');
      }
      if (e.name === 'ReloadNeeded') return reloadPage(e);
      console.error(e);
      progress.error = e.message;
      log('error', e.message);
      return finish('failed');
    }
  }

  async function finish(status) {
    progress.status = status;
    progress.finishedAt = Date.now();
    progress.current = null;
    if (status === 'done') log('info', `Finished: ${AB.summarize(progress)}`);
    await save();
  }

  async function reloadPage(e) {
    if (e.kind === 'reset' && ++progress.resetReloads > MAX_RESET_RELOADS) {
      progress.error = `The page kept resetting (${e.message}), so the bot gave up`;
      log('error', progress.error);
      return finish('failed');
    }
    progress.phase = 'open'; // after any reload: check the page, load the program, then continue with the courses
    progress.reloads++;
    log('info', `Reloading the page${e.delayMs ? ` in ${Math.round(e.delayMs / 100) / 10}s` : ''}: ${e.message}`);
    await save();
    try {
      if (e.delayMs) await sleep(e.delayMs, signal);
    } catch {
      log('info', 'Stopped by you');
      return finish('stopped');
    }
    AB.leaving = true; // this page is going away: don't start another run in it
    location.reload();
  }

  // ---------- phase 1: is registration open? ----------

  async function waitForState(timeout) {
    try {
      return await waitFor(
        () => {
          const s = P.pageState(target());
          return s.kind === 'loading' ? null : s;
        },
        { timeout, signal, what: 'the advising page to load' }
      );
    } catch (e) {
      if (e.name === 'AbortError') throw e;
      return { kind: 'loading', message: "the page didn't finish loading" };
    }
  }

  async function phaseOpen() {
    const st = await waitForState(45000);
    if (['blocked', 'probation', 'wrong-page', 'ambiguous'].includes(st.kind)) throw new BotError(st.message);
    // Remember what the page offered while your program is missing, for a clear error if it never appears.
    progress.lastOffered = st.kind === 'other-program' ? st.options.map((o) => o.label).join(', ') || AB.titleProgram(st.title) || st.title : null;
    if (st.kind === 'ready' || st.kind === 'selector') {
      if (st.kind === 'ready') log('info', `${target() || AB.titleProgram(st.title)} is loaded`);
      else if (st.message) log('info', `The selected program says "${st.message}"; switching to ${target()} to check it`);
      else log('info', `Select Advising offers ${target()}`);
      progress.phase = 'program';
      progress.startReloadDone = true;
      return save();
    }
    // Not open yet, or the portal is struggling: the page never refreshes by itself, so reload.
    const why = st.message || st.kind;
    if (!progress.startReloadDone) {
      progress.startReloadDone = true;
      throw new ReloadNeeded(`the page was loaded before registration opened (${why})`, { kind: 'open' });
    }
    throw notOpenYet(why);
  }

  // Reload and try again after the interval, until the deadline.
  function notOpenYet(why) {
    progress.openDeadline ??= Date.now() + cfg().openWaitMin * 60000;
    if (Date.now() > progress.openDeadline) {
      if (progress.lastOffered && target()) {
        return new BotError(`${target()} never appeared. The page offered ${progress.lastOffered}. Check the Program name.`);
      }
      return new BotError(`Registration didn't open within ${cfg().openWaitMin} min. Last message: ${why}`);
    }
    return new ReloadNeeded(`not open yet (${why})`, { kind: 'open', delayMs: cfg().reloadIntervalSec * 1000 });
  }

  // After choosing the program: it loads, or the page shows its own "not open" (or blocked) message.
  // The previous program's message stays on screen while ours loads, so only trust a message once loading is over.
  function waitForProgram(label, since) {
    let spinnerSeen = false;
    let messageSince = null;
    return waitFor(
      () => {
        if (P.spinnerVisible()) {
          spinnerSeen = true;
          messageSince = null;
          return null;
        }
        const titleOk = AB.titleShowsProgram(P.title(), label);
        if (titleOk && P.panel()) return { kind: 'ready' };
        const s = P.pageState(label);
        if (['not-open', 'blocked', 'probation', 'error'].includes(s.kind)) {
          messageSince ??= Date.now();
          // Once our title is up we're on the success path, so be slower to believe an error.
          const settledFor = titleOk ? 8000 : 1000;
          if (Date.now() - messageSince >= settledFor && (spinnerSeen || Date.now() - since >= 4000)) return s;
        } else {
          messageSince = null;
        }
        return null;
      },
      { timeout: 45000, signal, what: `${label} to load` }
    );
  }

  // ---------- phase 2: Select Advising → the program ----------

  // "Wait for the page to finish loading": spinner gone, then the panel stops changing (capped, because other
  // students' seat updates keep redrawing rows during the rush).
  async function settle({ quietMs = 500, maxMs = 3000 } = {}) {
    await waitFor(() => !P.spinnerVisible(), { timeout: 60000, signal, what: 'the loading spinner to go away' });
    await waitForQuiet(P.panel(), { quietMs, maxMs, signal });
  }

  async function phaseProgram() {
    const label = target();
    if (P.pageState(label).kind !== 'ready') {
      if (!P.findProgram(label)) throw notOpenYet(`${label} isn't offered yet`);
      await settle(); // let the default program finish loading before switching
      if (P.findProgram(label).checked) throw new ReloadNeeded(`${label} is ticked but didn't load`);
      const toggle = P.selectToggle();
      if (toggle) {
        log('info', 'Clicking "Select Advising"');
        click(toggle);
        await sleep(200, signal);
      }
      const option = P.findProgram(label); // the menu moves to <body> while open, so look it up again
      const ids = () => [P.availableRows(), P.selectedRows()].map((rows) => rows.map((r) => r.rowId).join(',')).join('|');
      const before = ids();
      log('info', `Choosing ${option.label}`);
      const chosenAt = Date.now();
      click(option.input);
      const outcome = await waitForProgram(label, chosenAt).catch((e) => {
        if (e.name === 'AbortError') throw e;
        return { kind: 'error', message: `${label} took too long to load` };
      });
      if (toggle?.getAttribute('aria-expanded') === 'true') click(toggle); // close the menu if it stayed open
      if (outcome.kind === 'blocked' || outcome.kind === 'probation') throw new BotError(outcome.message);
      if (outcome.kind !== 'ready') throw notOpenYet(outcome.message); // reload, then Select Advising → program again
      // The title changes first; the course lists arrive after it. Wait until they differ from the old program's.
      await waitFor(() => P.availableRows().length && ids() !== before, { timeout: 10000, signal, what: 'the course lists' }).catch((e) => {
        if (e.name === 'AbortError') throw e;
        log('warn', "The course lists didn't visibly change after switching programs");
      });
    }
    await waitFor(() => P.quickFilter() && P.displayedCount(P.availableGrid()) != null, {
      timeout: 30000,
      signal,
      what: 'the course list',
    });
    await settle({ maxMs: 5000 });
    if (!progress.resolvedProgram) {
      // From here on the run sticks to this program, even across reloads.
      progress.resolvedProgram = label || AB.titleProgram(P.title());
      if (!label) log('info', `Program is empty, so using the only open program: ${progress.resolvedProgram}`);
    }
    log('info', `${target()} loaded: ${P.displayedCount(P.availableGrid())} sections available`);
    progress.phase = 'courses';
    await save();
  }

  // ---------- phase 3: the courses ----------

  async function phaseCourses() {
    for (const c of progress.courses) {
      if (AB.TERMINAL.has(c.status)) continue;
      progress.current = c.text;
      await save();
      const attemptsBefore = c.attempts;
      await handleCourse(c);
      progress.current = null;
      await save();
      // After a Yes, wait for the page to finish loading; otherwise nothing is loading, so a short pause is enough.
      if (c.attempts > attemptsBefore) await settle();
      else await settle({ quietMs: 150, maxMs: 1000 });
    }

    // A course missing from the list could be a stale list after switching programs: reload once and look again.
    const missing = progress.courses.filter((c) => c.status === 'not-found');
    if (missing.length && !progress.notFoundReloadDone) {
      progress.notFoundReloadDone = true;
      missing.forEach((c) => {
        c.status = 'pending';
      });
      throw new ReloadNeeded(`${missing.map((c) => c.text).join(', ')} not found, reloading once to double-check`);
    }

    // Final pass: trust Selected Sections over anything we inferred.
    const selected = await selectedList();
    for (const c of progress.courses) {
      if (c.status === 'added' || c.status === 'already' || c.status === 'dry-run') continue;
      const hit = selected.find((s) => s.code === c.code && (!c.section || s.section === c.section));
      if (hit) await setCourse(c, 'added', `${hit.label} (found in Selected Sections at the end)`);
    }
    const input = P.quickFilter();
    if (input?.value) setInputValue(input, '');
  }

  const selectedList = async () => (await P.collectRows(P.selectedGrid(), AB.parseSelectedLabel, signal)).filter((r) => r.code);

  // Close anything left open before touching the next course.
  async function clearPopups() {
    for (let i = 0; i < 5; i++) {
      const d = S.current();
      if (!d || d.toast) return;
      if (d.kind === 'use-here' || d.kind === 'system-updated') throw new ReloadNeeded(`the portal said "${d.title}"`);
      if (d.kind === 'data-changed') {
        await S.answer(d, 'confirm', signal);
        await settle();
      } else if (['add-confirm', 'confirm-advising', 'question'].includes(d.kind) && d.cancel) {
        await S.answer(d, 'cancel', signal);
      } else if (d.confirm) {
        log('info', `Closing popup: ${d.title || d.text}`);
        await S.answer(d, 'confirm', signal);
      } else {
        return;
      }
    }
  }

  async function handleCourse(c) {
    for (;;) {
      await clearPopups();

      // a. Already in Selected Sections? After a reload mid-add, give the portal a moment to show it.
      let selected = await selectedList();
      if (c.status === 'adding' && !selected.some((s) => s.code === c.code)) {
        await sleep(3000, signal);
        selected = await selectedList();
      }
      const hit = selected.find((s) => s.code === c.code);
      if (hit) {
        if (!c.section || hit.section === c.section) return setCourse(c, c.status === 'adding' ? 'added' : 'already', hit.label);
        return setCourse(c, 'skipped', `another section is already selected: ${hit.label}`);
      }
      if (c.status === 'adding' && c.attempts >= cfg().maxAttempts) {
        return setCourse(c, 'failed', c.message || 'no result from the portal');
      }

      // b. Search: type the entry exactly as written, e.g. CSE705-[01].
      c.status = 'searching';
      await save();
      const rows = await search(c);
      const matches = rows.filter((r) => r.code === c.code && (!c.section || r.section === c.section));
      if (!matches.length) return setCourse(c, 'not-found', `${c.text} isn't in Available Courses`);

      // c. Pick the row: the exact section, or the first one with free seats (the count can lag, so fall back to the first).
      const row = c.section ? matches[0] : matches.find((r) => r.seats > 0) || matches[0];

      // d. + → popup → Yes, then e. wait for the result.
      const outcome = await addRow(c, row);
      if (outcome !== 'retry') return;
    }
  }

  async function search(c) {
    const input = await waitFor(() => P.quickFilter(), { timeout: 10000, signal, what: 'the search box' });
    const grid = P.availableGrid();
    const want = c.text.toUpperCase();
    for (let attempt = 1; ; attempt++) {
      log('info', `Searching ${c.text}`);
      setInputValue(input, c.text);
      await waitFor(
        () => {
          const n = P.displayedCount(grid);
          const rows = P.availableRows();
          if (n === 0) return rows.length === 0;
          return rows.length > 0 && rows.every((r) => r.label.toUpperCase().includes(want));
        },
        { timeout: 5000, signal, what: `the search for ${c.text}` }
      ).catch((e) => {
        if (e.name === 'AbortError') throw e;
      });
      await waitForQuiet(grid, { quietMs: 200, maxMs: 1500, signal });
      const rows = await P.collectRows(grid, AB.parseAvailableLabel, signal);
      if (rows.some((r) => r.code === c.code) || attempt >= 3) return rows;
      await sleep(700, signal); // the list may still be arriving
    }
  }

  async function addRow(c, row) {
    const grid = P.availableGrid();
    await P.scrollToRow(grid, row.rowIndex, signal);
    const button = await waitFor(() => P.addButton(row.rowId), { timeout: 5000, signal, what: `the + button of ${row.label}` });
    const selectedBefore = P.displayedCount(P.selectedGrid());
    const clickedAt = Date.now();
    log('info', `Clicking + on ${row.label}`);
    click(button);

    // The first popup after the click: the confirm dialog, or a warning toast from the portal's own checks.
    const first = await waitFor(() => S.since(clickedAt)[0], { timeout: 6000, signal, what: 'the confirmation popup' }).catch((e) => {
      if (e.name === 'AbortError') throw e;
      return null;
    });
    if (!first) {
      await setCourse(c, 'failed', 'nothing happened after clicking +');
      return 'done';
    }
    if (first.toast) {
      await setCourse(c, 'failed', first.title || first.text);
      return 'done';
    }
    const d = await waitFor(() => S.current(), { timeout: 3000, signal, what: 'the popup' }).catch(() => null);
    if (!d) return 'retry';
    if (d.kind === 'use-here' || d.kind === 'system-updated') throw new ReloadNeeded(`the portal said "${d.title}"`);
    if (d.kind === 'data-changed') {
      await S.answer(d, 'confirm', signal);
      await settle();
      return 'retry';
    }
    if (d.kind !== 'add-confirm') {
      if (d.cancel) await S.answer(d, 'cancel', signal);
      else if (d.confirm) await S.answer(d, 'confirm', signal);
      await setCourse(c, 'failed', `unexpected popup: ${d.title || d.text}`);
      return 'done';
    }

    // Safety: only ever say Yes to the exact section we meant. The popup writes CSE705-[01] as "CSE705-01".
    if (!AB.isAddConfirmFor(d.title, c.code, row.section)) {
      await S.answer(d, 'cancel', signal);
      await setCourse(c, 'failed', `the popup named a different section: "${d.title}"`);
      return 'done';
    }
    const name = AB.popupSectionName(c.code, row.section);
    if (cfg().dryRun) {
      await S.answer(d, 'cancel', signal);
      await setCourse(c, 'dry-run', `would add ${row.label}; answered No`);
      return 'done';
    }

    c.attempts++;
    c.status = 'adding';
    c.message = `adding ${row.label}`;
    c.rowId = row.rowId;
    await save();
    const yesAt = Date.now();
    log('info', `Yes: adding ${name}${c.attempts > 1 ? ` (attempt ${c.attempts})` : ''}`);
    await S.answer(d, 'confirm', signal);
    return waitResult(c, row, yesAt, selectedBefore);
  }

  const transient = (msg) => /\b5\d\d\b|http failure|timed? ?out|gateway|try again|not (yet )?(started|open)/i.test(msg);

  async function waitResult(c, row, since, selectedBefore) {
    const deadline = since + cfg().resultTimeoutSec * 1000;
    for (;;) {
      let titleMissingSince = null;
      const r = await waitFor(
        () => {
          if (P.selectedRows().some((s) => s.rowId === row.rowId)) return { kind: 'added' };
          const n = P.displayedCount(P.selectedGrid());
          if (S.since(since, (e) => e.kind === 'success-toast').length && selectedBefore != null && n > selectedBefore) {
            return { kind: 'added' };
          }
          const d = S.current();
          if (d && !d.toast && d.kind !== 'add-confirm') return { kind: 'popup', d };
          // HTTP 400 makes the portal re-initialise the page (back to the first program).
          if (!AB.titleShowsProgram(P.title(), target())) {
            titleMissingSince ??= Date.now();
            if (Date.now() - titleMissingSince > 800) return { kind: 'reset' };
          } else {
            titleMissingSince = null;
          }
          return null;
        },
        { timeout: Math.max(1000, deadline - Date.now()), signal, what: 'the result' }
      ).catch((e) => {
        if (e.name === 'AbortError') throw e;
        return { kind: 'timeout' };
      });

      if (r.kind === 'added') {
        // AG Grid draws the row a moment before its text, so wait until the label can be read.
        const shown = await waitFor(() => P.selectedRows().find((s) => s.rowId === row.rowId && s.code), { timeout: 2000, signal, what: 'the new row' }).catch((e) => {
          if (e.name === 'AbortError') throw e;
          return null;
        });
        await setCourse(c, 'added', shown?.label || row.label);
        return 'done';
      }
      if (r.kind === 'reset') throw new ReloadNeeded('the portal re-initialised the page');
      if (r.kind === 'timeout') {
        const hit = (await selectedList()).find((s) => s.code === c.code);
        if (hit) {
          await setCourse(c, 'added', hit.label);
          return 'done';
        }
        if (c.attempts < cfg().maxAttempts) {
          log('warn', `No result for ${c.text} within ${cfg().resultTimeoutSec}s, trying again`);
          await settle();
          return 'retry';
        }
        await setCourse(c, 'failed', `no result from the portal within ${cfg().resultTimeoutSec}s`);
        return 'done';
      }

      const d = r.d;
      if (d.kind === 'use-here' || d.kind === 'system-updated') throw new ReloadNeeded(`the portal said "${d.title}"`);
      if (d.kind === 'data-changed') {
        await S.answer(d, 'confirm', signal);
        continue;
      }
      if (d.kind === 'confirm-advising') {
        await S.answer(d, 'cancel', signal);
        continue;
      }
      if (d.kind === 'question') {
        // The server's repeat / retake prompt.
        if (cfg().acceptRepeatRetake) {
          log('info', `The portal asked "${d.title}", answering Yes`);
          await S.answer(d, 'confirm', signal);
          continue;
        }
        await S.answer(d, 'cancel', signal);
        await setCourse(c, 'skipped', `the portal asked "${d.title}"; answered No`);
        return 'done';
      }
      const msg = d.title || d.text || 'error';
      if (d.confirm) await S.answer(d, 'confirm', signal);
      if (transient(msg) && c.attempts < cfg().maxAttempts) {
        log('warn', `${c.text}: ${msg}, trying again`);
        c.status = 'pending'; // the portal said no, so there is nothing to wait for
        await settle();
        return 'retry';
      }
      await setCourse(c, 'failed', msg);
      return 'done';
    }
  }

  AB.runner = {
    run,
    note: (msg) => console.debug(`[Advising Bot] ${msg}`),
  };
})(globalThis.AB);
