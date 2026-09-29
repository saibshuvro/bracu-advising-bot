/* Everything that knows about the BRACU Connect advising pages (Self Registration, Phase One, Phase Two) lives here.
 * Selectors come from the portal's own code (Angular 15.2, Angular Material 15, AG Grid 31.1.1, SweetAlert2 11.4.8)
 * and were checked against a DOM capture of the real page. If the portal changes, this is the file to fix. */
(function (AB) {
  'use strict';

  const { $, $$, isVisible, sleep } = AB.dom;
  const norm = AB.normText;

  const SEL = {
    app: 'app-list',
    title: 'app-toolbar h1.page-heading',
    notAvailable: 'img[src*="not_available"]',
    selectToggle: 'button[ngbdropdowntoggle]',
    programOption: '[ngbdropdownmenu] mat-radio-button',
    panel: 'app-advising-panel',
    quickFilter: 'app-advising-panel input.quick-filter',
    grid: 'app-easy-grid',
    agRoot: '.ag-root',
    headerRow: '.ag-header-row',
    viewport: '.ag-body-viewport',
    centerRow: '.ag-center-cols-container .ag-row[row-id]',
    labelCell: '[col-id="sectionName"]',
    spinner: '.ngx-spinner-overlay',
  };

  // On a supported advising page, or on that exact page when a path is given.
  const isPagePath = (path) => {
    const page = AB.pageFor(location.pathname);
    return !!page && (!path || page.path === path);
  };

  const title = () => norm($(SEL.title)?.textContent);

  function notAvailableMessage() {
    const img = $(SEL.notAvailable);
    if (!img) return null;
    return norm(img.parentElement?.querySelector('p')?.textContent) || 'Advising is not available';
  }

  function programOptions() {
    return $$(SEL.programOption).map((el) => {
      const input = el.querySelector('input[type="radio"]');
      return {
        el,
        input,
        label: norm(el.querySelector('label')?.textContent || el.textContent),
        checked: el.classList.contains('mat-mdc-radio-checked') || !!input?.checked,
      };
    });
  }
  const findProgram = (label) => programOptions().find((o) => AB.sameProgram(o.label, label)) || null;

  const selectToggle = () => $$(SEL.selectToggle).find((b) => /select advising/i.test(b.textContent)) || null;

  function gridUnder(heading, fallbackIndex) {
    const panel = $(SEL.panel);
    if (!panel) return null;
    const h = $$('h5', panel).find((e) => norm(e.textContent).toLowerCase() === heading.toLowerCase());
    return h?.closest('[class*="col-"]')?.querySelector(SEL.grid) || $$(SEL.grid, panel)[fallbackIndex] || null;
  }
  const availableGrid = () => gridUnder('Available Courses', 0);
  const selectedGrid = () => gridUnder('Selected Sections', 1);

  // Rows passing the filter, including ones not drawn yet: aria-rowcount counts header rows too.
  function displayedCount(grid) {
    const root = grid?.querySelector(SEL.agRoot);
    const n = Number(root?.getAttribute('aria-rowcount'));
    if (!root || !Number.isFinite(n)) return null;
    const headerLevels = new Set($$(SEL.headerRow, grid).map((r) => r.getAttribute('aria-rowindex'))).size || 1;
    return Math.max(0, n - headerLevels);
  }

  function readRows(grid, parse) {
    if (!grid) return [];
    return $$(SEL.centerRow, grid)
      .filter((r) => !r.classList.contains('ag-opacity-zero')) // rows fading out after a filter change
      .map((r) => {
        const label = norm(r.querySelector(SEL.labelCell)?.textContent);
        return { rowId: r.getAttribute('row-id'), rowIndex: Number(r.getAttribute('row-index')), label, ...(parse(label) || {}) };
      });
  }
  const availableRows = () => readRows(availableGrid(), AB.parseAvailableLabel);
  const selectedRows = () => readRows(selectedGrid(), AB.parseSelectedLabel);

  // The action buttons live in AG Grid's pinned-right container, in a row with the same row-id.
  function actionButton(grid, rowId, name, icon) {
    const row = grid?.querySelector(`.ag-pinned-right-cols-container .ag-row[row-id="${CSS.escape(String(rowId))}"]`);
    if (!row) return null;
    return (
      row.querySelector(`button[aria-label="${name}"]`) ||
      $$('button', row).find((b) => norm(b.querySelector('mat-icon')?.textContent) === icon) ||
      null
    );
  }
  const addButton = (rowId) => actionButton(availableGrid(), rowId, 'Add', 'add_circle');

  // The grids only draw the rows in view, so scroll through and collect every row that passes the filter.
  async function collectRows(grid, parse, signal) {
    const seen = new Map();
    const take = () => readRows(grid, parse).forEach((r) => seen.set(r.rowId, r));
    take();
    const total = displayedCount(grid);
    const vp = grid?.querySelector(SEL.viewport);
    if (vp && total != null && seen.size < total) {
      const startTop = vp.scrollTop;
      for (let top = 0, i = 0; i < 80 && seen.size < total; i++) {
        vp.scrollTop = top;
        await sleep(120, signal);
        take();
        if (top >= vp.scrollHeight - vp.clientHeight) break;
        top += Math.max(40, vp.clientHeight - 40);
      }
      vp.scrollTop = startTop;
      await sleep(80, signal);
    }
    return [...seen.values()].sort((a, b) => a.rowIndex - b.rowIndex);
  }

  async function scrollToRow(grid, rowIndex, signal) {
    const vp = grid?.querySelector(SEL.viewport);
    const sample = grid?.querySelector(SEL.centerRow);
    if (!vp || !sample) return;
    const h = sample.offsetHeight || 42;
    const top = rowIndex * h;
    if (top < vp.scrollTop || top + h > vp.scrollTop + vp.clientHeight) {
      vp.scrollTop = Math.max(0, top - h);
      await sleep(150, signal);
    }
  }

  const spinnerVisible = () => $$(SEL.spinner).some(isVisible);

  function classifyMessage(msg) {
    if (/probation/i.test(msg)) return 'probation';
    if (/blocked/i.test(msg)) return 'blocked';
    if (/not been scheduled|expired|try after/i.test(msg)) return 'not-open';
    return 'error';
  }

  function pageState(programLabel) {
    if (!isPagePath()) return { kind: 'wrong-page', message: `This tab isn't on an advising page (${AB.PAGE_NAMES}); it's on ${location.pathname}` };
    const msg = notAvailableMessage();
    const t = title();
    if (!$(SEL.app) || (!t && !msg)) return { kind: 'loading' };
    const options = programOptions().map(({ label, checked }) => ({ label, checked }));
    const auto = !AB.normText(programLabel); // Program left empty: use the only open program
    if (auto && options.length > 1) {
      const labels = options.map((o) => o.label).join(', ');
      return { kind: 'ambiguous', title: t, options, message: `Several programs are open (${labels}). Enter the one to use in Program.` };
    }
    if (AB.titleShowsProgram(t, programLabel) && $(SEL.panel) && !msg) return { kind: 'ready', title: t, options };
    const target = auto ? null : findProgram(programLabel);
    // A "not scheduled / expired" message is about the selected program (the first one loads by default).
    // If ours isn't selected yet, switch to it before deciding anything.
    if (target && !target.checked) return { kind: 'selector', title: t, options, message: msg || '' };
    if (msg) return { kind: classifyMessage(msg), title: t, options, message: msg };
    if (target) return { kind: 'selector', title: t, options, message: '' };
    if (auto) return { kind: 'loading' };
    const offered = options.map((o) => o.label).join(', ') || t;
    return { kind: 'other-program', title: t, options, message: `${programLabel} isn't offered here yet (${offered})` };
  }

  const confirmAdvisingButton = () => $$('app-toolbar button').find((b) => /confirm\s*advising/i.test(norm(b.textContent))) || null;

  // Read-only diagnosis for the popup's "Check page".
  function check(programLabel) {
    const st = pageState(programLabel);
    const avail = availableGrid();
    const sel = selectedGrid();
    const rows = availableRows();
    return {
      url: location.href,
      page: AB.pageFor(location.pathname)?.name || '',
      state: st.kind,
      message: st.message || '',
      title: title(),
      loadedProgram: AB.titleProgram(title()),
      programOptions: programOptions().map(({ label, checked }) => ({ label, checked })),
      selectToggle: !!selectToggle(),
      programFound: !!findProgram(programLabel) || st.kind === 'ready',
      panel: !!$(SEL.panel),
      quickFilter: !!$(SEL.quickFilter),
      available: avail
        ? {
            count: displayedCount(avail),
            drawn: rows.length,
            parsed: rows.filter((r) => r.code).length,
            sample: rows[0]?.label || '',
            addButton: !!(rows[0] && addButton(rows[0].rowId)),
          }
        : null,
      selected: sel ? { count: displayedCount(sel), labels: selectedRows().map((r) => r.label) } : null,
      spinner: spinnerVisible(),
      confirmAdvisingFound: !!confirmAdvisingButton(),
      visibility: document.visibilityState,
    };
  }

  // Trimmed DOM for debugging selectors (leaves out the student info card).
  function snapshot() {
    const grab = (label, sel) => {
      const els = $$(sel);
      const html = els.map((e) => e.outerHTML.replace(/<style[\s\S]*?<\/style>/gi, '')).join('\n\n');
      return `<!-- ===== ${label} | ${sel} | ${els.length} found ===== -->\n${html}`;
    };
    return [
      `<!-- ${document.title} | ${location.href} | ${new Date().toISOString()} -->`,
      grab('toolbar', 'app-toolbar'),
      grab('program menu', '[ngbdropdownmenu]'),
      grab('not available message', '.text-center.mt-20'),
      grab('advising panel', 'app-advising-panel'),
      grab('popup', '.swal2-container'),
      grab('spinner', 'ngx-spinner'),
    ].join('\n\n');
  }

  AB.portal = {
    SEL,
    isPagePath,
    title,
    pageState,
    programOptions,
    findProgram,
    selectToggle,
    panel: () => $(SEL.panel),
    quickFilter: () => $(SEL.quickFilter),
    availableGrid,
    selectedGrid,
    displayedCount,
    availableRows,
    selectedRows,
    addButton,
    collectRows,
    scrollToRow,
    spinnerVisible,
    check,
    snapshot,
  };
})(globalThis.AB);
