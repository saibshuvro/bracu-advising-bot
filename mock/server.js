/* Local stand-in for connect.bracu.ac.bd's advising pages (Self Registration, Phase One, Phase Two), for testing the extension safely.
 *   node mock/server.js            → http://localhost:8787/student/advising/self-registration
 * Tests reconfigure it with POST /__mock/reset and read what happened with GET /__mock/events. */
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = Number(process.env.PORT || 8787);
const NM = path.join(__dirname, '..', 'node_modules');

const STATIC = {
  '/student/advising/self-registration': [path.join(__dirname, 'self-registration.html'), 'text/html'],
  '/student/advising/phase-one': [path.join(__dirname, 'self-registration.html'), 'text/html'], // same page component
  '/student/advising/phase-two': [path.join(__dirname, 'self-registration.html'), 'text/html'],
  '/mock.js': [path.join(__dirname, 'mock.js'), 'text/javascript'],
  '/mock.css': [path.join(__dirname, 'mock.css'), 'text/css'],
  '/assets/media/misc/not_available.svg': [path.join(__dirname, 'not_available.svg'), 'image/svg+xml'],
  '/vendor/ag-grid-community.js': [path.join(NM, 'ag-grid-community/dist/ag-grid-community.min.noStyle.js'), 'text/javascript'],
  '/vendor/ag-grid.css': [path.join(NM, 'ag-grid-community/styles/ag-grid.css'), 'text/css'],
  '/vendor/ag-theme-alpine.css': [path.join(NM, 'ag-grid-community/styles/ag-theme-alpine.css'), 'text/css'],
  '/vendor/sweetalert2.js': [path.join(NM, 'sweetalert2/dist/sweetalert2.all.min.js'), 'text/javascript'],
};

const CS = 19826;
const MENG = 71656;

function section(sectionId, courseCode, sectionName, capacity, consumedSeat, faculties, extra = {}) {
  const courseId = Number(courseCode.replace(/\D/g, '')) * 10 + (/[A-Z]$/.test(courseCode) ? courseCode.charCodeAt(courseCode.length - 1) - 64 : 0);
  return { sectionId, courseId, courseCode, sectionName, capacity, consumedSeat, faculties, courseCredit: 3, prerequisiteCourses: null, courseEquivalences: null, ...extra };
}

function defaultState() {
  const meng = [
    section(5001, 'CSE700A', '01', 100, 22, 'TBA'),
    section(5002, 'CSE700B', '01', 100, 11, 'TBA'),
    section(5003, 'CSE705', '01', 30, 22, 'TBA'),
    section(5004, 'CSE705', '02', 30, 10, 'MHR'),
    section(5005, 'CSE706', '01', 30, 24, 'AAR'),
    section(5006, 'CSE708', '01', 40, 6, 'KYK'),
    section(5007, 'CSE711', '01', 30, 30, 'GRA'),
    section(5008, 'CSE713', '01', 30, 28, 'AAR'),
    section(5009, 'CSE722', '01', 30, 12, 'SDF'),
    section(5010, 'CSE723', '01', 30, 12, 'GAL'),
    section(5011, 'CSE772', '01', 30, 12, 'STAR'),
  ];
  // A course with many sections, so its rows don't all fit in the grid's 360 px (tests scrolling).
  for (let i = 1; i <= 12; i++) meng.push(section(5100 + i, 'CSE799', String(i).padStart(2, '0'), 20, i === 12 ? 5 : 20, `F${i}`));
  // Filler so the unfiltered list is long.
  for (let i = 0; i < 25; i++) meng.push(section(5200 + i, `CSE${730 + i}`, '01', 30, 10, 'TBA'));
  const cs = [
    section(4001, 'CSE110', '01', 40, 10, 'ABC'),
    section(4002, 'CSE220', '01', 40, 10, 'DEF'),
    section(4003, 'CSE705', '01', 40, 10, 'UG1'), // same code in the other program: must not be picked
  ];
  return {
    openAt: 0, // epoch ms; before this, no advising session is active
    programs: [
      { id: CS, shortCode: 'CS', academicType: 'UNDERGRADUATE', active: true, minLoad: 3, maxLoad: 15 },
      { id: MENG, shortCode: 'MENGGCSE', academicType: 'POSTGRADUATE', active: true, minLoad: 3, maxLoad: 12 },
    ],
    sections: { [CS]: cs, [MENG]: meng },
    selected: { [CS]: [], [MENG]: [] }, // sectionIds
    bootDelayMs: 300, // Angular + Keycloak start-up
    loadDelayMs: 300, // loading a program
    addDelayMs: 500, // server processing an add (result arrives "over SSE")
    refillDelayMs: 400, // loadSchedules after a success
    fallbackMs: 40000, // the portal's own give-up timer when no result arrives
    results: {}, // sectionId → list of scripted outcomes: "ADDED", "ERROR:msg", "REPEAT:msg", "HTTP400", "HTTP500", "NONE"
    conflicts: [], // sectionIds that fail the portal's class-schedule clash check
    interrupts: [], // [{ afterAdds, type: 'use-here' | 'system-updated' | 'data-changed' }]
    noise: false, // other students' seat updates redrawing rows every ~300 ms
  };
}

let state = defaultState();
let events = [];

const send = (res, status, body, type = 'application/json') => {
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(type === 'application/json' ? JSON.stringify(body) : body);
};
const readBody = (req) =>
  new Promise((resolve) => {
    let data = '';
    req.on('data', (c) => (data += c));
    req.on('end', () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch {
        resolve({});
      }
    });
  });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const program = (id) => state.programs.find((p) => p.id === Number(id));
const selectedSections = (pid) => state.selected[pid].map((id) => state.sections[pid].find((s) => s.sectionId === id));
const credits = (pid) => selectedSections(pid).reduce((sum, s) => sum + s.courseCredit, 0);

function decide(pid, sectionId) {
  const queue = state.results[sectionId];
  if (queue?.length) {
    const next = queue.length > 1 ? queue.shift() : queue[0];
    const [status, ...rest] = String(next).split(':');
    return { status, message: rest.join(':') };
  }
  const s = state.sections[pid].find((x) => x.sectionId === sectionId);
  if (!s) return { status: 'ERROR', message: 'Section not found' };
  if (s.capacity - s.consumedSeat <= 0) return { status: 'ERROR', message: `No seat available in ${s.courseCode}-${s.sectionName}` };
  if (credits(pid) + s.courseCredit > program(pid).maxLoad) return { status: 'ERROR', message: 'Credit limit exceeded' };
  return { status: 'ADDED' };
}

function applyAdd(pid, sectionId) {
  const s = state.sections[pid].find((x) => x.sectionId === sectionId);
  if (!state.selected[pid].includes(sectionId)) {
    state.selected[pid].push(sectionId);
    s.consumedSeat++;
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const p = url.pathname.replace(/\/+$/, '') || '/';

  if (STATIC[p] && req.method === 'GET') {
    const [file, type] = STATIC[p];
    return fs.readFile(file, (err, buf) => (err ? send(res, 500, String(err), 'text/plain') : send(res, 200, buf, type)));
  }
  if (req.method === 'HEAD') return send(res, 200, '', 'text/plain');

  // ----- test control -----
  if (p === '/__mock/reset' && req.method === 'POST') {
    const overrides = await readBody(req);
    state = { ...defaultState(), ...overrides };
    if (overrides.selected) state.selected = { ...defaultState().selected, ...overrides.selected };
    events = [];
    return send(res, 200, { ok: true });
  }
  if (p === '/__mock/events') return send(res, 200, events);
  if (p === '/__mock/state') return send(res, 200, state);

  // ----- what the page calls (a simplified version of /api/adv/v1/...) -----
  if (p === '/__mock/api/event' && req.method === 'POST') {
    events.push({ ...(await readBody(req)), serverAt: Date.now() });
    return send(res, 200, { ok: true });
  }
  if (p === '/__mock/api/config') {
    return send(res, 200, { bootDelayMs: state.bootDelayMs, loadDelayMs: state.loadDelayMs, refillDelayMs: state.refillDelayMs, fallbackMs: state.fallbackMs, conflicts: state.conflicts, interrupts: state.interrupts, noise: state.noise });
  }
  if (p === '/__mock/api/active-sessions') {
    const now = Date.now();
    return send(res, 200, now >= state.openAt ? state.programs.filter((x) => x.active && now >= (x.activeFrom || 0)) : []);
  }
  // getSelfRegistrationSession: a listed program can still be closed (openFrom in the future).
  if (p === '/__mock/api/session') {
    const prog = program(url.searchParams.get('program'));
    if (!prog || Date.now() < (prog.openFrom || 0)) {
      return send(res, 200, { error: 'Advising has not been scheduled or has been expired. Please try after scheduled.' });
    }
    return send(res, 200, { ok: true });
  }
  if (p === '/__mock/api/offered') {
    const pid = Number(url.searchParams.get('program'));
    return send(res, 200, state.sections[pid] || []);
  }
  if (p === '/__mock/api/selected') {
    const pid = Number(url.searchParams.get('program'));
    return send(res, 200, { sections: selectedSections(pid), credits: credits(pid) });
  }
  if (p === '/__mock/api/add' && req.method === 'POST') {
    const { program: pid, sectionId, repeat } = await readBody(req);
    await sleep(state.addDelayMs);
    const outcome = repeat ? { status: 'ADDED' } : decide(pid, sectionId);
    if (outcome.status === 'ADDED') applyAdd(pid, sectionId);
    events.push({ type: 'server-add', sectionId, repeat: !!repeat, outcome: outcome.status, serverAt: Date.now() });
    return send(res, 200, outcome);
  }
  if (p.startsWith('/student/')) return send(res, 200, '<!DOCTYPE html><title>Other page</title><p>Another page of the portal</p>', 'text/html');
  send(res, 404, { error: 'not found' });
});

server.listen(PORT, () => console.log(`Mock portal: http://localhost:${PORT}/student/advising/self-registration`));
