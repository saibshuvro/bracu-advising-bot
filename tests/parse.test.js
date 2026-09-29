const test = require('node:test');
const assert = require('node:assert/strict');
const AB = require('../extension/shared/config.js');

test('course entries: exact section, bare code, clean-up', () => {
  assert.deepEqual(AB.parseCourseEntry('CSE705-[01]').entry, { text: 'CSE705-[01]', code: 'CSE705', section: '01' });
  assert.deepEqual(AB.parseCourseEntry('CSE705').entry, { text: 'CSE705', code: 'CSE705', section: null });
  assert.deepEqual(AB.parseCourseEntry(' cse705 - [1] ').entry, { text: 'CSE705-[01]', code: 'CSE705', section: '01' });
  assert.deepEqual(AB.parseCourseEntry('cse700a').entry, { text: 'CSE700A', code: 'CSE700A', section: null });
  assert.equal(AB.parseCourseEntry('CSE705-01').ok, false);
  assert.equal(AB.parseCourseEntry('CSE7').ok, false);
  assert.equal(AB.parseCourseEntry('hello').ok, false);
});

test('course list: lines, commas, comments, duplicates, bad lines', () => {
  const { entries, errors } = AB.parseCourseList('CSE705-[01]\n\n# backup later\ncse706-[2], CSE708 ;CSE711-[01]\nbogus\nCSE705-[02]');
  assert.deepEqual(entries.map((e) => e.text), ['CSE705-[01]', 'CSE706-[02]', 'CSE708', 'CSE711-[01]']);
  assert.equal(errors.length, 2);
  assert.match(errors[0], /bogus/);
  assert.match(errors[1], /CSE705 is listed twice/);
});

test('available labels', () => {
  assert.deepEqual(AB.parseAvailableLabel('CSE700A-[01](78)-TBA'), { code: 'CSE700A', section: '01', seats: 78, faculty: 'TBA' });
  assert.deepEqual(AB.parseAvailableLabel('CSE711-[01](0)-GRA'), { code: 'CSE711', section: '01', seats: 0, faculty: 'GRA' });
  assert.deepEqual(AB.parseAvailableLabel('CSE705-[02](-2)-N/A'), { code: 'CSE705', section: '02', seats: -2, faculty: 'N/A' });
  assert.equal(AB.parseAvailableLabel('No Rows To Show'), null);
});

test('selected labels', () => {
  assert.deepEqual(AB.parseSelectedLabel('CSE722-[01]  -SDF'), { code: 'CSE722', section: '01', faculty: 'SDF' });
  assert.deepEqual(AB.parseSelectedLabel('CSE723-[01] -N/A'), { code: 'CSE723', section: '01', faculty: 'N/A' });
  assert.equal(AB.parseSelectedLabel('CSE705'), null);
});

test('add-confirm popup matches the section without brackets', () => {
  const title = ' Do you want to add this section CSE705-01 ?\n          Your added courses are automatically saved. ';
  assert.equal(AB.popupSectionName('CSE705', '01'), 'CSE705-01');
  assert.equal(AB.isAddConfirmFor(title, 'CSE705', '01'), true);
  assert.equal(AB.isAddConfirmFor(title, 'CSE705', '02'), false);
  assert.equal(AB.isAddConfirmFor(title, 'CSE70', '01'), false);
});

test('program label and page title', () => {
  assert.deepEqual(AB.splitProgram('MENGGCSE(POSTGRADUATE)'), { shortCode: 'MENGGCSE', academicType: 'POSTGRADUATE' });
  assert.equal(AB.sameProgram(' MENGGCSE(POSTGRADUATE) ', 'menggcse (postgraduate)'), true);
  assert.equal(AB.sameProgram('CS(UNDERGRADUATE)', 'MENGGCSE(POSTGRADUATE)'), false);
  const title = 'Advising for MENGGCSE\n          (POSTGRADUATE ) - Self Registration';
  assert.equal(AB.titleShowsProgram(title, 'MENGGCSE(POSTGRADUATE)'), true);
  assert.equal(AB.titleShowsProgram(title, 'CS(UNDERGRADUATE)'), false);
  assert.equal(AB.titleShowsProgram('Advising for Self Registration', 'MENGGCSE(POSTGRADUATE)'), false);
});

test('program read from the title (Program left empty)', () => {
  const title = 'Advising for MENGGCSE\n          (POSTGRADUATE ) - Phase Two';
  assert.equal(AB.titleProgram(title), 'MENGGCSE(POSTGRADUATE)');
  assert.equal(AB.titleProgram('Advising for Self Registration'), null);
  assert.equal(AB.titleProgram('Advising for Phase Two'), null);
  assert.equal(AB.titleShowsProgram(title, ''), true);
  assert.equal(AB.titleShowsProgram('Advising for Phase Two', ''), false);
});

test('summary', () => {
  const p = { courses: [{ status: 'added' }, { status: 'added' }, { status: 'failed' }, { status: 'dry-run' }] };
  assert.equal(AB.summarize(p), '2 added, 1 failed, 1 checked (dry run)');
});
