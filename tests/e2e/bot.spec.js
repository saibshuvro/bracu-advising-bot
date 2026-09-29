const { test, expect, resetMock, mockEvents, openPortal, openPopup, fillPopup, storage, waitForRunEnd, statuses } = require('./fixtures');

const CS = 19826;
const MENG = 71656;
const PROGRAMS = {
  cs: { id: CS, shortCode: 'CS', academicType: 'UNDERGRADUATE', active: true, minLoad: 3, maxLoad: 15 },
  meng: { id: MENG, shortCode: 'MENGGCSE', academicType: 'POSTGRADUATE', active: true, minLoad: 3, maxLoad: 12 },
};

const serverAdds = async () => (await mockEvents()).filter((e) => e.type === 'server-add').map((e) => [e.sectionId, e.outcome]);
const eventsOf = async (type) => (await mockEvents()).filter((e) => e.type === type);

// Whatever else happens, the bot must never touch these.
test.afterEach(async () => {
  const forbidden = (await mockEvents()).filter((e) => ['confirm-advising-click', 'drop-click', 'actions-click'].includes(e.type));
  expect(forbidden).toEqual([]);
});

async function runNow(context, extensionId, sw, opts) {
  const portal = await openPortal(context);
  await expect(portal.locator('app-toolbar h1.page-heading')).toBeVisible();
  const popup = await openPopup(context, extensionId);
  await fillPopup(popup, opts);
  await popup.click('#runNow');
  const progress = await waitForRunEnd(sw);
  return { portal, popup, progress };
}

async function arm(context, extensionId, opts) {
  const popup = await openPopup(context, extensionId);
  await fillPopup(popup, opts);
  await popup.click('#arm');
  await expect(popup.locator('#formError')).toHaveText('');
  return popup;
}

test('adds each course in order, typing the entry exactly as written', async ({ context, extensionId, sw }) => {
  await resetMock();
  const { progress } = await runNow(context, extensionId, sw, { courses: 'CSE705-[01]\ncse706 - [1]\nCSE708' });
  expect(progress.status).toBe('done');
  expect(statuses(progress)).toEqual({ 'CSE705-[01]': 'added', 'CSE706-[01]': 'added', CSE708: 'added' });
  expect(await serverAdds()).toEqual([
    [5003, 'ADDED'],
    [5005, 'ADDED'],
    [5006, 'ADDED'],
  ]);
  expect((await eventsOf('search')).map((e) => e.value)).toEqual(['CSE705-[01]', 'CSE706-[01]', 'CSE708', '']);
  expect(progress.courses[0].message).toBe('CSE705-[01] -TBA'); // label read back from Selected Sections
});

test('an exact section picks only that section when a course has several', async ({ context, extensionId, sw }) => {
  await resetMock();
  const { progress } = await runNow(context, extensionId, sw, { courses: 'CSE705-[02]' });
  expect(statuses(progress)).toEqual({ 'CSE705-[02]': 'added' });
  expect(await serverAdds()).toEqual([[5004, 'ADDED']]);
});

test('a bare code takes the first section with free seats, scrolling the grid to reach it', async ({ context, extensionId, sw }) => {
  await resetMock(); // CSE799-[01]..[11] are full, only [12] has seats, and it is below the fold
  const { progress } = await runNow(context, extensionId, sw, { courses: 'CSE799' });
  expect(statuses(progress)).toEqual({ CSE799: 'added' });
  expect(await serverAdds()).toEqual([[5112, 'ADDED']]);
});

test('a bare CSE700 never picks CSE700A or CSE700B', async ({ context, extensionId, sw }) => {
  await resetMock();
  const { progress } = await runNow(context, extensionId, sw, { courses: 'CSE700' });
  expect(statuses(progress)).toEqual({ CSE700: 'not-found' });
  expect(await serverAdds()).toEqual([]);
  expect((await eventsOf('page-load')).length).toBe(2); // one reload to double-check a missing course
});

test('waits for the page to finish loading after each Yes (slow refill, busy grid)', async ({ context, extensionId, sw }) => {
  await resetMock({ addDelayMs: 1200, refillDelayMs: 1500, noise: true });
  const { progress } = await runNow(context, extensionId, sw, { courses: 'CSE705-[01]\nCSE706-[01]\nCSE708' });
  expect(statuses(progress)).toEqual({ 'CSE705-[01]': 'added', 'CSE706-[01]': 'added', CSE708: 'added' });
  expect(await serverAdds()).toHaveLength(3);
});

test('page opened before registration: reloads at the start time until it opens', async ({ context, extensionId, sw }) => {
  const T = Math.ceil((Date.now() + 10_000) / 1000) * 1000;
  await resetMock({ openAt: T + 3000 });
  const portal = await openPortal(context);
  await expect(portal.getByText('Advising has not been scheduled')).toBeVisible();
  await arm(context, extensionId, { courses: 'CSE705-[01]', startAt: T, reloadIntervalSec: 1 });
  const progress = await waitForRunEnd(sw);
  expect(statuses(progress)).toEqual({ 'CSE705-[01]': 'added' });
  expect((await eventsOf('page-load')).length).toBeGreaterThanOrEqual(3);
  expect(progress.startedAt).toBeGreaterThanOrEqual(T);
});

test('the program opens later than the other one: keeps reloading until it is offered', async ({ context, extensionId, sw }) => {
  const T = Math.ceil((Date.now() + 10_000) / 1000) * 1000;
  await resetMock({ programs: [PROGRAMS.cs, { ...PROGRAMS.meng, activeFrom: T + 3000 }] });
  await openPortal(context);
  await arm(context, extensionId, { courses: 'CSE705-[01]', startAt: T, reloadIntervalSec: 1 });
  const progress = await waitForRunEnd(sw);
  expect(statuses(progress)).toEqual({ 'CSE705-[01]': 'added' });
  expect(await serverAdds()).toEqual([[5003, 'ADDED']]); // not CS's own CSE705 (4003)
});

test('the default program shows "not scheduled or expired": switches to MENGGCSE first, no reload', async ({ context, extensionId, sw }) => {
  await resetMock({ programs: [{ ...PROGRAMS.cs, openFrom: Date.now() + 3_600_000 }, PROGRAMS.meng] });
  const portal = await openPortal(context);
  await expect(portal.getByText('Advising has not been scheduled')).toBeVisible();
  await expect(portal.locator('button[ngbdropdowntoggle]')).toBeVisible();
  const popup = await openPopup(context, extensionId);
  await popup.fill('#program', 'MENGGCSE(POSTGRADUATE)');
  await popup.click('#check');
  await expect(popup.locator('#reportList')).toContainText('Select Advising offers: CS(UNDERGRADUATE) (selected), MENGGCSE(POSTGRADUATE)');
  await expect(popup.locator('#reportList')).toContainText('the bot switches to MENGGCSE(POSTGRADUATE) first');
  await fillPopup(popup, { courses: 'CSE705-[01]\nCSE752-[01]', dryRun: true });
  await popup.click('#runNow');
  const progress = await waitForRunEnd(sw);
  expect(statuses(progress)).toEqual({ 'CSE705-[01]': 'dry-run', 'CSE752-[01]': 'dry-run' });
  expect((await eventsOf('page-load')).length).toBe(1);
  expect((await eventsOf('program-change')).map((e) => e.program)).toEqual(['MENGGCSE']);
});

test('MENGGCSE opens a few seconds after the start: select it, see "not open", reload, select it again', async ({ context, extensionId, sw }) => {
  const T = Math.ceil((Date.now() + 10_000) / 1000) * 1000;
  await resetMock({ programs: [{ ...PROGRAMS.cs, openFrom: T + 3_600_000 }, { ...PROGRAMS.meng, openFrom: T + 4000 }] });
  await openPortal(context);
  await arm(context, extensionId, { courses: 'CSE705-[01]', startAt: T, reloadIntervalSec: 1 });
  const progress = await waitForRunEnd(sw);
  expect(statuses(progress)).toEqual({ 'CSE705-[01]': 'added' });
  expect((await eventsOf('program-change')).length).toBeGreaterThanOrEqual(2); // chose MENGGCSE on every attempt
  expect((await eventsOf('page-load')).length).toBeGreaterThanOrEqual(2);
  expect(progress.log.some((l) => /not open yet/.test(l.msg))).toBe(true);
});

test('works the same on the Pre-Registration Phase Two page', async ({ context, extensionId, sw }) => {
  await resetMock({ programs: [{ ...PROGRAMS.cs, openFrom: Date.now() + 3_600_000 }, PROGRAMS.meng] });
  const portal = await openPortal(context, '/student/advising/phase-two');
  await expect(portal.locator('app-toolbar h1.page-heading')).toHaveText('Advising for Phase Two');
  const popup = await openPopup(context, extensionId);
  await popup.fill('#program', 'MENGGCSE(POSTGRADUATE)');
  await popup.click('#check');
  await expect(popup.locator('#reportList')).toContainText('The tab is on Pre-Registration Phase Two');
  await fillPopup(popup, { courses: 'CSE705-[01]\nCSE706-[01]' });
  await popup.click('#runNow');
  await expect(popup.locator('#runStatus')).toContainText('LIVE on Pre-Registration Phase Two');
  const progress = await waitForRunEnd(sw);
  expect(statuses(progress)).toEqual({ 'CSE705-[01]': 'added', 'CSE706-[01]': 'added' });
  await expect(portal.locator('app-toolbar h1.page-heading')).toContainText('(POSTGRADUATE ) - Phase Two');
  expect(portal.url()).toContain('/student/advising/phase-two');
  expect(await serverAdds()).toEqual([
    [5003, 'ADDED'],
    [5005, 'ADDED'],
  ]);
});

test('Arm refuses when Self Registration and Phase Two are both open', async ({ context, extensionId }) => {
  await resetMock();
  await openPortal(context);
  await openPortal(context, '/student/advising/phase-two');
  const popup = await openPopup(context, extensionId);
  await fillPopup(popup, { courses: 'CSE705-[01]', startAt: Date.now() + 60_000 });
  await popup.click('#arm');
  await expect(popup.locator('#formError')).toContainText('More than one advising tab');
});

test('Program left empty and only one program open: uses it', async ({ context, extensionId, sw }) => {
  await resetMock({ programs: [PROGRAMS.meng] });
  const { progress } = await runNow(context, extensionId, sw, { program: '', courses: 'CSE705-[01]' });
  expect(statuses(progress)).toEqual({ 'CSE705-[01]': 'added' });
  expect(progress.log.map((l) => l.msg)).toContain('Program is empty, so using the only open program: MENGGCSE(POSTGRADUATE)');
  expect(await eventsOf('toggle-click')).toEqual([]);
});

test('Program left empty but several programs open: refuses to guess', async ({ context, extensionId }) => {
  await resetMock();
  const portal = await openPortal(context);
  await expect(portal.locator('app-advising-panel')).toBeVisible();
  const popup = await openPopup(context, extensionId);
  await fillPopup(popup, { program: '', courses: 'CSE705-[01]' });
  await popup.click('#runNow');
  await expect(popup.locator('#formError')).toContainText('Several programs are open (CS(UNDERGRADUATE), MENGGCSE(POSTGRADUATE)). Enter the one to use in Program.');
  expect(await eventsOf('add-click')).toEqual([]);
});

test('a wrong Program name: warns at once, never clicks, then says what the page offered', async ({ context, extensionId, sw }) => {
  test.setTimeout(150_000);
  await resetMock({ programs: [PROGRAMS.meng] });
  const portal = await openPortal(context);
  await expect(portal.locator('app-advising-panel')).toBeVisible();
  const popup = await openPopup(context, extensionId);
  await fillPopup(popup, { program: 'MENGGCSE(UNDERGRADUATE)', courses: 'CSE705-[01]', openWaitMin: 1, reloadIntervalSec: 4 });
  await popup.click('#runNow');
  await expect(popup.locator('#formError')).toContainText('The page shows MENGGCSE(POSTGRADUATE), not MENGGCSE(UNDERGRADUATE)');
  const progress = await waitForRunEnd(sw, 120_000);
  expect(progress.status).toBe('failed');
  expect(progress.error).toBe('MENGGCSE(UNDERGRADUATE) never appeared. The page offered MENGGCSE(POSTGRADUATE). Check the Program name.');
  expect(await eventsOf('add-click')).toEqual([]);
  expect(await eventsOf('toggle-click')).toEqual([]);
});

test('only one program open: no Select Advising button, goes straight to the courses', async ({ context, extensionId, sw }) => {
  await resetMock({ programs: [PROGRAMS.meng] });
  const { progress } = await runNow(context, extensionId, sw, { courses: 'CSE705-[01]' });
  expect(statuses(progress)).toEqual({ 'CSE705-[01]': 'added' });
  expect(await eventsOf('toggle-click')).toEqual([]);
});

test('already selected, or another section selected: nothing is added or dropped', async ({ context, extensionId, sw }) => {
  await resetMock({ selected: { [MENG]: [5003, 5009] } });
  const { progress } = await runNow(context, extensionId, sw, { courses: 'CSE705-[01]\nCSE722-[02]' });
  expect(statuses(progress)).toEqual({ 'CSE705-[01]': 'already', 'CSE722-[02]': 'skipped' });
  expect(await serverAdds()).toEqual([]);
});

test('portal warnings (time clash, credit limit) fail that course and move on', async ({ context, extensionId, sw }) => {
  await resetMock({ conflicts: [5005], selected: { [MENG]: [5009, 5010] } }); // 6 of 12 credits taken
  const { progress } = await runNow(context, extensionId, sw, { courses: 'CSE706-[01]\nCSE705-[01]\nCSE708\nCSE713-[01]' });
  expect(statuses(progress)).toEqual({ 'CSE706-[01]': 'failed', 'CSE705-[01]': 'added', CSE708: 'added', 'CSE713-[01]': 'failed' });
  expect(progress.courses[0].message).toMatch(/conflict/i);
  expect(progress.courses[3].message).toBe('Credit limit exceeded');
  expect(await serverAdds()).toEqual([
    [5003, 'ADDED'],
    [5006, 'ADDED'],
  ]);
});

test('a server error dialog is recorded and closed, then the next course is added', async ({ context, extensionId, sw }) => {
  await resetMock(); // CSE711-[01] has no seats
  const { portal, progress } = await runNow(context, extensionId, sw, { courses: 'CSE711-[01]\nCSE708' });
  expect(statuses(progress)).toEqual({ 'CSE711-[01]': 'failed', CSE708: 'added' });
  expect(progress.courses[0].message).toBe('No seat available in CSE711-01');
  await expect(portal.locator('.swal2-popup.swal2-icon-error')).toHaveCount(0);
});

test('a 5xx error is retried and the retry succeeds', async ({ context, extensionId, sw }) => {
  await resetMock({ results: { 5006: ['HTTP500', 'ADDED'] } });
  const { progress } = await runNow(context, extensionId, sw, { courses: 'CSE708' });
  expect(statuses(progress)).toEqual({ CSE708: 'added' });
  expect(progress.courses[0].attempts).toBe(2);
  expect(await serverAdds()).toEqual([
    [5006, 'HTTP500'],
    [5006, 'ADDED'],
  ]);
});

test('no result at all: waits, then tries again', async ({ context, extensionId, sw }) => {
  await resetMock({ results: { 5006: ['NONE', 'ADDED'] }, fallbackMs: 2000 });
  const { progress } = await runNow(context, extensionId, sw, { courses: 'CSE708', resultTimeoutSec: 5 });
  expect(statuses(progress)).toEqual({ CSE708: 'added' });
  expect(await serverAdds()).toEqual([
    [5006, 'NONE'],
    [5006, 'ADDED'],
  ]);
});

test('HTTP 400 resets the page: reloads, picks the program again and finishes without duplicates', async ({ context, extensionId, sw }) => {
  await resetMock({ results: { 5003: ['HTTP400', 'ADDED'] } });
  const { progress } = await runNow(context, extensionId, sw, { courses: 'CSE705-[01]\nCSE706-[01]' });
  expect(statuses(progress)).toEqual({ 'CSE705-[01]': 'added', 'CSE706-[01]': 'added' });
  expect(await serverAdds()).toEqual([
    [5003, 'HTTP400'],
    [5003, 'ADDED'],
    [5005, 'ADDED'],
  ]);
  expect((await eventsOf('page-load')).length).toBe(2);
});

test('"Use Here" popup: reloads and resumes without adding anything twice', async ({ context, extensionId, sw }) => {
  await resetMock({ interrupts: [{ afterAdds: 1, type: 'use-here', timing: 'before-refresh' }] });
  const { progress } = await runNow(context, extensionId, sw, { courses: 'CSE705-[01]\nCSE706-[01]' });
  expect(statuses(progress)).toEqual({ 'CSE705-[01]': 'added', 'CSE706-[01]': 'added' });
  expect(await serverAdds()).toEqual([
    [5003, 'ADDED'],
    [5005, 'ADDED'],
  ]);
});

test('"Advising data has changed" popup: answers Ok and carries on', async ({ context, extensionId, sw }) => {
  await resetMock({ interrupts: [{ afterAdds: 1, type: 'data-changed' }] });
  const { progress } = await runNow(context, extensionId, sw, { courses: 'CSE705-[01]\nCSE706-[01]' });
  expect(statuses(progress)).toEqual({ 'CSE705-[01]': 'added', 'CSE706-[01]': 'added' });
  expect(await eventsOf('interrupt')).toHaveLength(1);
});

test('a repeat / retake prompt is answered No by default', async ({ context, extensionId, sw }) => {
  await resetMock({ results: { 5006: ['REPEAT:You completed CSE708 before. Do you want to repeat it?'] } });
  const { progress } = await runNow(context, extensionId, sw, { courses: 'CSE708' });
  expect(statuses(progress)).toEqual({ CSE708: 'skipped' });
  expect((await eventsOf('repeat-answer')).map((e) => e.answer)).toEqual(['no']);
});

test('a repeat / retake prompt is answered Yes when allowed', async ({ context, extensionId, sw }) => {
  await resetMock({ results: { 5006: ['REPEAT:You completed CSE708 before. Do you want to repeat it?'] } });
  const { progress } = await runNow(context, extensionId, sw, { courses: 'CSE708', acceptRepeatRetake: true });
  expect(statuses(progress)).toEqual({ CSE708: 'added' });
  expect(await serverAdds()).toEqual([
    [5006, 'REPEAT'],
    [5006, 'ADDED'],
  ]);
});

test('dry run opens every confirm popup and answers No', async ({ context, extensionId, sw }) => {
  await resetMock();
  const { progress } = await runNow(context, extensionId, sw, { courses: 'CSE705-[01]\nCSE706-[01]', dryRun: true });
  expect(statuses(progress)).toEqual({ 'CSE705-[01]': 'dry-run', 'CSE706-[01]': 'dry-run' });
  expect((await eventsOf('confirm-answer')).map((e) => e.answer)).toEqual(['no', 'no']);
  expect(await serverAdds()).toEqual([]);
});

test('Stop halts the run', async ({ context, extensionId, sw }) => {
  await resetMock({ addDelayMs: 4000 });
  await openPortal(context);
  const popup = await openPopup(context, extensionId);
  await fillPopup(popup, { courses: 'CSE705-[01]\nCSE706-[01]\nCSE708' });
  await popup.click('#runNow');
  await expect.poll(async () => (await storage(sw, 'progress'))?.courses?.[0]?.status, { timeout: 30_000 }).toBe('adding');
  await popup.click('#stop');
  const progress = await waitForRunEnd(sw);
  expect(progress.status).toBe('stopped');
  expect((await storage(sw, 'job')).state).toBe('stopped');
  await new Promise((r) => setTimeout(r, 6000));
  expect((await serverAdds()).length).toBeLessThanOrEqual(1);
  expect((await eventsOf('add-click')).length).toBe(1);
});

test('starts within 300 ms of the scheduled time', async ({ context, extensionId, sw }) => {
  await resetMock();
  const portal = await openPortal(context);
  await expect(portal.locator('app-advising-panel')).toBeVisible();
  const T = Math.ceil((Date.now() + 10_000) / 1000) * 1000;
  await arm(context, extensionId, { courses: 'CSE708', startAt: T });
  const progress = await waitForRunEnd(sw);
  const job = await storage(sw, 'job');
  expect(job.startAt).toBe(T);
  expect(progress.startedAt - T).toBeGreaterThanOrEqual(0);
  expect(progress.startedAt - T).toBeLessThan(300);
  expect(statuses(progress)).toEqual({ CSE708: 'added' });
});

test('the armed tab wandered off the page: at the start time it goes back and runs', async ({ context, extensionId, sw }) => {
  await resetMock();
  const portal = await openPortal(context);
  await expect(portal.locator('app-advising-panel')).toBeVisible();
  const T = Math.ceil((Date.now() + 10_000) / 1000) * 1000;
  await arm(context, extensionId, { courses: 'CSE708', startAt: T });
  await portal.goto('http://localhost:8787/student/dashboard');
  const progress = await waitForRunEnd(sw);
  expect(statuses(progress)).toEqual({ CSE708: 'added' });
  expect(portal.url()).toContain('/student/advising/self-registration');
});

// After the extension is reloaded, open tabs keep a disconnected script until they reload. Arm / Run now / Check
// page ping the tab first and reload it if nothing answers.
test('a tab whose bot script is silent gets reloaded; a live one is left alone', async ({ context, extensionId, sw }) => {
  await resetMock();
  const portal = await openPortal(context);
  await expect(portal.locator('app-toolbar h1')).toBeVisible();
  const other = await openPopup(context, extensionId); // an extension page: no content script to answer
  const ids = {
    portal: await sw.evaluate(async () => (await chrome.tabs.query({ url: 'http://localhost/student/advising/*' }))[0].id),
    other: await other.evaluate(async () => (await chrome.tabs.getCurrent()).id),
  };
  expect(await sw.evaluate((id) => ensureConnected(id), ids.portal)).toBe(true);
  const reloaded = other.waitForEvent('load');
  expect(await sw.evaluate((id) => ensureConnected(id), ids.other)).toBe(false);
  await reloaded; // the silent tab was reloaded
  expect((await eventsOf('page-load')).length).toBe(1); // the live advising tab was not
});

test('while armed, the keep-alive alarm reloads the tab', async ({ context, extensionId, sw }) => {
  await resetMock();
  await openPortal(context);
  const popup = await arm(context, extensionId, { courses: 'CSE708', startAt: Date.now() + 5 * 60_000, keepAliveMin: 0.2 });
  await expect.poll(async () => (await eventsOf('page-load')).length, { timeout: 25_000 }).toBeGreaterThanOrEqual(2);
  await popup.click('#stop');
  expect((await storage(sw, 'job')).state).toBe('stopped');
  expect(await serverAdds()).toEqual([]);
});

test('the pre-flight alarm reloads the tab shortly before the start', async ({ context, extensionId, sw }) => {
  await resetMock();
  await openPortal(context);
  const T = Date.now() + 40_000;
  const popup = await arm(context, extensionId, { courses: 'CSE708', startAt: T, preflightMin: 0.5 }); // 30 s before T
  await expect.poll(async () => (await eventsOf('page-load')).length, { timeout: 20_000 }).toBeGreaterThanOrEqual(2);
  expect(Date.now()).toBeLessThan(T);
  await popup.click('#stop');
  expect((await storage(sw, 'progress'))).toBeNull(); // stopped before it started
});

test('Check page reports what it found', async ({ context, extensionId }) => {
  await resetMock();
  const portal = await openPortal(context);
  await expect(portal.locator('app-advising-panel')).toBeVisible();
  const popup = await openPopup(context, extensionId);
  await popup.fill('#program', 'MENGGCSE(POSTGRADUATE)');
  await popup.click('#check');
  await expect(popup.locator('#reportList')).toContainText('Select Advising offers: CS(UNDERGRADUATE) (selected), MENGGCSE(POSTGRADUATE)');
  await expect(popup.locator('#reportList')).toContainText("Your clock matches the portal's");
  // Switch to MENGGCSE by hand, like the user would, and check again.
  await portal.click('button[ngbdropdowntoggle]');
  await portal.click('text=MENGGCSE(POSTGRADUATE)');
  await expect(portal.locator('app-toolbar h1')).toContainText('MENGGCSE');
  await expect(portal.locator('ngx-spinner .ngx-spinner-overlay')).toHaveCount(0);
  await popup.click('#check');
  const report = popup.locator('#reportList');
  await expect(report).toContainText('MENGGCSE(POSTGRADUATE) is loaded');
  await expect(report).toContainText('Search box found');
  await expect(report).toContainText('+ buttons found');
  await expect(report).toContainText('Available Courses: 48 sections');
  await expect(report).not.toContainText('✖');
});

test('Arm refuses when the advising page is open in two tabs', async ({ context, extensionId }) => {
  await resetMock();
  await openPortal(context);
  await openPortal(context);
  const popup = await openPopup(context, extensionId);
  await fillPopup(popup, { courses: 'CSE705-[01]', startAt: Date.now() + 60_000 });
  await popup.click('#arm');
  await expect(popup.locator('#formError')).toContainText('More than one advising tab');
});
