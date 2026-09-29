/* Advising Bot: helpers shared by the background worker, the popup, the content scripts and the Node tests.
 * A classic script (content scripts can't import modules): it fills globalThis.AB and is also require()-able. */
(function (root) {
  'use strict';

  const AB = root.AB || (root.AB = {});

  AB.KEYS = { config: 'config', job: 'job', progress: 'progress' };

  // The advising pages the bot runs on. They share one page component, the same Select Advising menu and the same
  // Advising Panel; only the title differs ("Advising for MENGGCSE (POSTGRADUATE ) - Phase Two").
  AB.PAGES = [
    { path: '/student/advising/self-registration', name: 'Self Registration' },
    { path: '/student/advising/phase-one', name: 'Pre-Registration Phase One' },
    { path: '/student/advising/phase-two', name: 'Pre-Registration Phase Two' },
  ];
  AB.pageFor = (pathname) => AB.PAGES.find((p) => p.path === String(pathname).replace(/\/+$/, '')) || null;
  AB.PAGE_NAMES = AB.PAGES.map((p) => p.name).join(', ');
  AB.TAB_URL_PATTERNS = AB.PAGES.flatMap((p) => [
    `https://connect.bracu.ac.bd${p.path}*`,
    `http://localhost${p.path}*`, // local mock portal (development only)
  ]);

  AB.DEFAULT_CONFIG = Object.freeze({
    program: '', // empty = use the only open program; otherwise exactly this one, e.g. MENGGCSE(POSTGRADUATE)
    coursesText: '',
    startAt: null, // epoch ms
    dryRun: true,
    reloadIntervalSec: 4, // while registration isn't open yet
    openWaitMin: 5, // give up reloading after this long
    resultTimeoutSec: 45, // the portal itself gives up after 40 s
    maxAttempts: 2, // Yes clicks per course
    keepAliveMin: 10, // reload while armed to keep the SSO session alive (0 = off)
    preflightMin: 2, // reload + login check this long before the start
    bringToFront: true,
    acceptRepeatRetake: false,
  });

  // Course statuses that are final for a run.
  AB.TERMINAL = new Set(['added', 'already', 'failed', 'skipped', 'not-found', 'dry-run']);

  AB.normText = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();

  const CODE = '[A-Z]{2,4}\\d{3}[A-Z]?';
  const esc = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  // "CSE705-[01]" (exact section) or "CSE705" (any section). Case and spaces don't matter.
  AB.parseCourseEntry = function (raw) {
    const s = String(raw ?? '').toUpperCase().replace(/\s+/g, '');
    const m = s.match(new RegExp(`^(${CODE})(?:-\\[([0-9A-Z]{1,3})\\])?$`));
    if (!m) return { ok: false, error: `"${AB.normText(raw)}" doesn't look like CSE705-[01] or CSE705` };
    const code = m[1];
    let section = m[2] ?? null;
    if (section && /^\d$/.test(section)) section = `0${section}`;
    return { ok: true, entry: { text: section ? `${code}-[${section}]` : code, code, section } };
  };

  // One course per line (commas and semicolons also separate). "#" starts a comment.
  AB.parseCourseList = function (text) {
    const entries = [];
    const errors = [];
    String(text ?? '')
      .split(/\r?\n/)
      .map((line) => line.replace(/#.*/, ''))
      .flatMap((line) => line.split(/[,;]/))
      .map((part) => part.trim())
      .filter(Boolean)
      .forEach((part) => {
        const r = AB.parseCourseEntry(part);
        if (!r.ok) return errors.push(r.error);
        if (entries.some((e) => e.code === r.entry.code)) {
          return errors.push(`${r.entry.code} is listed twice (the portal allows one section per course)`);
        }
        entries.push(r.entry);
      });
    return { entries, errors };
  };

  // Available Courses label, e.g. "CSE705-[01](8)-TBA". The number is seats left (capacity − consumed), can be negative.
  AB.parseAvailableLabel = function (label) {
    const m = AB.normText(label).match(new RegExp(`^(${CODE})-\\[([^\\]]+)\\]\\((-?\\d+)\\)-(.*)$`));
    return m ? { code: m[1], section: m[2], seats: Number(m[3]), faculty: m[4].trim() } : null;
  };

  // Selected Sections label, e.g. "CSE722-[01]  -SDF".
  AB.parseSelectedLabel = function (label) {
    const m = AB.normText(label).match(new RegExp(`^(${CODE})-\\[([^\\]]+)\\]\\s*-(.*)$`));
    return m ? { code: m[1], section: m[2], faculty: m[3].trim() } : null;
  };

  // The add-confirm popup names the section without brackets: "Do you want to add this section CSE705-01 ?"
  AB.popupSectionName = (code, section) => `${code}-${section}`;
  AB.isAddConfirmFor = function (title, code, section) {
    const re = new RegExp(`Do you want to add this section\\s+${esc(code)}-${esc(section)}\\s*\\?`, 'i');
    return re.test(AB.normText(title));
  };

  // "MENGGCSE(POSTGRADUATE)" → { shortCode: "MENGGCSE", academicType: "POSTGRADUATE" }
  AB.splitProgram = function (label) {
    const m = String(label ?? '').toUpperCase().replace(/\s+/g, '').match(/^([^()]+)\(([^()]+)\)$/);
    return m ? { shortCode: m[1], academicType: m[2] } : null;
  };
  AB.sameProgram = (a, b) =>
    String(a ?? '').replace(/\s+/g, '').toUpperCase() === String(b ?? '').replace(/\s+/g, '').toUpperCase();

  // Page title after a program loads: "Advising for MENGGCSE\n (POSTGRADUATE ) - Self Registration" (or "- Phase Two")
  // → "MENGGCSE(POSTGRADUATE)". Null before a program has loaded ("Advising for Self Registration").
  AB.titleProgram = function (title) {
    const m = AB.normText(title).match(/Advising for\s+(\S+)\s*\(\s*([^)]+?)\s*\)/i);
    return m ? `${m[1]}(${m[2]})`.toUpperCase() : null;
  };

  // Does the title show this program? With an empty label (auto mode): does it show any program?
  AB.titleShowsProgram = function (title, label) {
    if (!AB.normText(label)) return !!AB.titleProgram(title);
    const p = AB.splitProgram(label);
    if (!p) return false;
    const re = new RegExp(`Advising for\\s+${esc(p.shortCode)}\\s*\\(\\s*${esc(p.academicType)}\\s*\\)`, 'i');
    return re.test(AB.normText(title));
  };

  AB.summarize = function (progress) {
    if (!progress?.courses?.length) return 'No courses';
    const count = {};
    for (const c of progress.courses) count[c.status] = (count[c.status] || 0) + 1;
    const words = {
      added: 'added',
      already: 'already selected',
      'dry-run': 'checked (dry run)',
      failed: 'failed',
      skipped: 'skipped',
      'not-found': 'not found',
      pending: 'not reached',
      searching: 'not reached',
      adding: 'unconfirmed',
    };
    return Object.entries(count)
      .map(([status, n]) => `${n} ${words[status] || status}`)
      .join(', ');
  };

  const pad = (n, w = 2) => String(n).padStart(w, '0');
  AB.fmtTime = (ms) => {
    const d = new Date(ms);
    return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  };
  AB.fmtDateTime = (ms) => {
    const d = new Date(ms);
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${AB.fmtTime(ms)}`;
  };
  AB.fmtCountdown = (ms) => {
    const s = Math.max(0, Math.ceil(ms / 1000));
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    return `${h ? `${h}:` : ''}${pad(m)}:${pad(s % 60)}`;
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = AB;
})(typeof globalThis !== 'undefined' ? globalThis : this);
