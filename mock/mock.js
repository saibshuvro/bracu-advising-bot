/* Mock of the advising pages (Self Registration, Phase One, Phase Two: one page component in the portal).
 * Markup: copied from the real Angular templates and a DOM capture of the live page.
 * Behaviour: ported from the portal's code (chunks 82800 and 75672): the first program loads by itself, the
 * notify queue, the add confirm, the asynchronous result, the empty-and-refill after a success, the page reset
 * after an HTTP 400, and the "Use Here" / "system updated" / "data changed" popups. */
(async function () {
  'use strict';

  const api = (p, opts) => fetch(`/__mock/api/${p}`, opts).then((r) => r.json());
  const post = (p, body) => api(p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const event = (type, data = {}) => post('event', { type, at: Date.now(), ...data }).catch(() => {});
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const cfg = await api('config');
  const appList = document.querySelector('app-list');
  const spinnerHost = document.querySelector('ngx-spinner');

  event('page-load');

  // ---------- notify: the portal's SweetAlert2 wrapper (non-forced popups wait for the open one) ----------
  const waiting = [];
  function fire(options, force) {
    if (Swal.isVisible() && !force) return new Promise((resolve) => waiting.push({ resolve, options }));
    const shown = Swal.fire(options);
    shown.then(() =>
      setTimeout(() => {
        if (waiting.length) {
          const next = waiting.shift();
          fire(next.options, true).then(next.resolve);
        }
      }, 300)
    );
    return shown;
  }
  const notify = {
    toast: (icon, title, timer = 3000) =>
      fire({ icon, position: 'top-end', title, timer, toast: true, timerProgressBar: true, showConfirmButton: false }),
    success: (t) => notify.toast('success', t),
    warning: (t, ms) => notify.toast('warning', t, ms),
    info: (t) => notify.toast('info', t),
    error: (title) =>
      fire({
        icon: 'error',
        position: 'center',
        titleText: title,
        showConfirmButton: true,
        allowOutsideClick: false,
        backdrop: true,
        buttonsStyling: false,
        customClass: { title: 'swal2-title text-danger', confirmButton: 'px-12 btn btn-primary btn-shadow font-weight-bold' },
      }),
    confirm: (title, yes, no) =>
      fire({ title, icon: 'question', confirmButtonColor: '#0479d9', showCancelButton: no !== undefined, confirmButtonText: yes, cancelButtonText: no }, true),
  };

  const spinner = {
    show: () => (spinnerHost.innerHTML = '<div class="ngx-spinner-overlay"><div></div></div>'),
    hide: () => (spinnerHost.innerHTML = ''),
  };

  // ---------- state ----------
  let portfolios = [];
  let portfolioId = null;
  let student = null;
  let offered = [];
  let selected = [];
  let credits = 0;
  let addsDone = 0;
  let availableApi = null;
  let selectedApi = null;
  let fallbackTimer = null;
  let noiseTimer = null;
  let closeMenu = () => {};

  // The phase pages differ only in their title and have no Confirm Advising button.
  const PHASE = { 'phase-one': 'Phase One', 'phase-two': 'Phase Two' }[location.pathname.split('/').pop()] || 'Self Registration';
  document.title = `BRAC University SLMS > Student > ${PHASE}`;
  const titleFor = (p) => `Advising for ${p.shortCode}\n          (${p.academicType} ) - ${PHASE}`;
  const label = (s) => `${s.courseCode}-[${s.sectionName}](${(s.capacity || 0) - (s.consumedSeat || 0)})-${s.faculties || 'N/A'}`;

  // ---------- loading (loadInfo → checkBlocking → getAvailable) ----------
  async function loadInfo() {
    destroyGrids();
    closeMenu();
    appList.innerHTML = ''; // load$ = false: nothing is shown until the data is in
    await sleep(cfg.bootDelayMs);
    portfolios = await api('active-sessions');
    document.getElementById('splash-screen')?.remove();
    if (!portfolios.length) return renderNotAllowed('Advising has not been scheduled or has been expired. Please try after scheduled.');
    portfolioId = portfolios[0].id;
    await getAvailable(portfolioId, true);
  }

  async function getAvailable(pid, initial) {
    const prog = portfolios.find((p) => p.id === pid);
    if (!initial) spinner.show();
    await sleep(cfg.loadDelayMs / 2);
    const session = await api(`session?program=${pid}`);
    if (session.error) {
      // errorHandle: the toolbar (with Select Advising) stays, the card shows the message, the title is unchanged.
      if (initial) renderShell(`Advising for ${PHASE}`);
      showNotAllowed(session.error);
      spinner.hide();
      event('program-not-open', { program: prog.shortCode });
      return;
    }
    student = prog;
    if (!initial) {
      appList.querySelector('h1.page-heading').textContent = titleFor(prog);
      renderStudentInfo();
    }
    await sleep(cfg.loadDelayMs / 2);
    if (initial) renderShell(titleFor(prog));
    showPanel();
    await loadSchedules({ immediate: true });
    spinner.hide();
    event('program-loaded', { program: prog.shortCode });
  }

  // loadSchedules: selected courses + seat status, then the Available list is emptied and refilled.
  async function loadSchedules({ immediate = false } = {}) {
    if (!immediate) await sleep(cfg.refillDelayMs);
    const res = await api(`selected?program=${portfolioId}`);
    offered = await api(`offered?program=${portfolioId}`);
    selected = res.sections;
    credits = res.credits;
    if (!availableApi) return;
    availableApi.setGridOption('rowData', []);
    if (!immediate) await sleep(150); // same tick in the real portal; a gap makes the test stricter
    const ids = new Set(selected.map((s) => s.sectionId));
    availableApi.setGridOption('rowData', offered.filter((s) => !ids.has(s.sectionId)));
    selectedApi.setGridOption('rowData', selected);
    renderStudentInfo();
  }

  // HTTP 400 / "Use Here" / "Reload": the portal starts over with the first program.
  function concurrentError() {
    event('page-reset');
    loadInfo();
  }

  // ---------- markup ----------
  function toolbar(title, dropdown) {
    return `
      <app-toolbar id="kt_app_toolbar" class="app-toolbar py-3 py-lg-6">
        <div id="kt_app_toolbar_container" class="app-container d-flex flex-stack container-xxl">
          <div class="page-title d-flex flex-wrap me-3 flex-column justify-content-center">
            <h1 class="page-heading d-flex text-dark fw-bold fs-sm-3 my-0 flex-column justify-content-center">${title}</h1>
          </div>
          <div class="align-items-center d-flex">
            ${dropdown}
            <div class="d-flex align-items-center flex-shrink-0 pe-2 d-lg-flex d-md-flex d-none">
              <div class="overflow-hidden ms-2"><button type="button" id="mock-actions" class="mat-mdc-menu-trigger btn btn-primary btn-sm d-flex justify-content-center align-items-center" aria-haspopup="menu" aria-expanded="false">Actions <mat-icon class="mat-icon notranslate material-icons">arrow_drop_down</mat-icon></button></div>
              ${PHASE === 'Self Registration' ? '<button id="mock-confirm" class="btn btn-success p-0 px-4 py-3 font-weight-bold ms-2"> Confirm <span class="d-none d-md-inline">Advising</span></button>' : ''}
            </div>
          </div>
        </div>
      </app-toolbar>`;
  }

  function programDropdown() {
    if (portfolios.length < 2) return '';
    const options = portfolios
      .map((p, i) => {
        const n = i + 2;
        return `<mat-radio-button ngbdropdownitem="" class="mat-mdc-radio-button dropdown-item mat-accent ng-star-inserted${i === 0 ? ' mat-mdc-radio-checked' : ''}" id="mat-radio-${n}" tabindex="0"><div class="mdc-form-field"><div class="mdc-radio"><div class="mat-mdc-radio-touch-target"></div><input type="radio" class="mdc-radio__native-control" id="mat-radio-${n}-input" name="mat-radio-group-0" value="${p.id}" tabindex="${i === 0 ? 0 : -1}"${i === 0 ? ' checked' : ''}><div class="mdc-radio__background"><div class="mdc-radio__outer-circle"></div><div class="mdc-radio__inner-circle"></div></div></div><label for="mat-radio-${n}-input"> ${p.shortCode}(${p.academicType}) </label></div></mat-radio-button>`;
      })
      .join('');
    return `<div container="body" ngbdropdown="" class="btn-group ng-star-inserted dropdown"><button ngbdropdowntoggle="" type="button" class="dropdown-toggle btn btn-primary p-0 px-3 py-3" aria-expanded="false"> Select Advising </button><div ngbdropdownmenu="" class="dropdown-menu" style="position: static;"><mat-radio-group role="radiogroup" class="mat-mdc-radio-group">${options}</mat-radio-group></div></div>`;
  }

  function renderNotAllowed(message) {
    renderShell(`Advising for ${PHASE}`);
    showNotAllowed(message);
  }

  function renderShell(title) {
    appList.innerHTML = `<div class="ng-star-inserted">${toolbar(title, programDropdown())}
      <div class="card card-custom custom-h"><div class="card-body p-0" id="mock-body"></div></div></div>`;
    wireToolbar();
  }

  function destroyGrids() {
    availableApi?.destroy();
    selectedApi?.destroy();
    availableApi = selectedApi = null;
    clearInterval(noiseTimer);
  }

  function showNotAllowed(message) {
    destroyGrids();
    appList.querySelector('#mock-body').innerHTML = `
      <div class="text-center mt-20"><p class="fw-bold fw-normal text-gray-700 fs-1">${message}</p><img alt="Search" src="./assets/media/misc/not_available.svg" class="img-fluid img-thumbnail shadow-none mx-auto d-block" style="height: 200px;"></div>`;
    event('not-open');
  }

  function showPanel() {
    if (availableApi) return renderStudentInfo();
    appList.querySelector('#mock-body').innerHTML = `
        <div class="mt-2 ng-star-inserted"><app-advising-student-info></app-advising-student-info></div>
        <div class="ng-star-inserted"><app-advising-panel>
          <mat-expansion-panel class="mat-expansion-panel expansion-panel-with-button mat-elevation-z0 mat-expanded">
            <mat-expansion-panel-header role="button" class="mat-expansion-panel-header mat-expanded" aria-expanded="true"><span class="mat-content"><mat-panel-title class="mat-expansion-panel-header-title fs-3"> Advising Panel </mat-panel-title></span></mat-expansion-panel-header>
            <div role="region" class="mat-expansion-panel-content"><div class="mat-expansion-panel-body">
              <div class="row">
                <div class="col-12 col-lg-7 col-md-7 col-sm-12">
                  <nav class="navbar bg-light"><div class="container-fluid input-group-sm">
                    <div><h5 class="navbar-brand w-50">Available Courses</h5></div>
                    <div class="input-group input-group-solid w-50 input-group-sm input-group-solid">
                      <input placeholder="Quick filter..." type="text" aria-label="Quick filter..." class="form-control quick-filter ng-untouched ng-pristine ng-valid">
                      <button class="bg-transparent h-20 input-group-text" id="mock-reset-filter" disabled=""><i class="cursor fs-3 ki-duotone ki-filter-edit text-dark-emphasis"></i></button>
                    </div>
                  </div></nav>
                  <app-easy-grid><div class="ag-theme-alpine w-100" style="height: 360px;"><ag-grid-angular id="grid-available" style="height: 100%; width: 100%; display: block;"></ag-grid-angular></div></app-easy-grid>
                </div>
                <div class="col-12 col-lg-5 col-md-5 col-sm-12">
                  <nav class="navbar bg-light"><div class="container-fluid"><h5 class="navbar-brand">Selected Sections</h5></div></nav>
                  <app-easy-grid><div class="ag-theme-alpine w-100" style="height: 360px;"><ag-grid-angular id="grid-selected" style="height: 100%; width: 100%; display: block;"></ag-grid-angular></div></app-easy-grid>
                </div>
              </div>
            </div></div>
          </mat-expansion-panel>
        </app-advising-panel></div>`;
    renderStudentInfo();
    createGrids();
    if (cfg.noise) startNoise();
  }

  function renderStudentInfo() {
    const host = appList.querySelector('app-advising-student-info');
    if (!host || !student) return;
    host.innerHTML = `
      <div class="px-10 pt-2"><div class="alert bg-light-warning border border-warning"><span class="mt-1 fs-5 fw-semibold">Your progress is saved automatically. Please click the 'Confirm Advising' button only when you are certain that no further changes are needed in your self-registration.</span></div></div>
      <div class="info"><p class="text-gray-900 fs-2 fw-bold">Test Student</p>
        <p><i class="fa fa-graduation-cap fs-4 me-1"></i>${student.shortCode} · 00000000 · SUMMER 2026 · FALL 2026</p>
        <div class="boxes">
          <div class="box"><b>36</b>Total Credit</div><div class="box"><b>9</b>Completed Credit</div>
          <div class="box"><b>${student.minLoad} - ${student.maxLoad}</b>Credit Limit</div><div class="box"><b>${credits}</b>Credit Taken</div>
        </div></div>`;
  }

  // ngbDropdown with container="body": the menu moves to <body> while open and closes on any click.
  function wireToolbar() {
    appList.querySelector('#mock-actions')?.addEventListener('click', () => event('actions-click'));
    appList.querySelector('#mock-confirm')?.addEventListener('click', async () => {
      event('confirm-advising-click');
      const r = await notify.confirm("You won't be able to change your courses any further if you confirm ? ", 'Yes', 'No');
      if (r.isConfirmed) event('confirm-advising-yes');
    });
    const toggle = appList.querySelector('button[ngbdropdowntoggle]');
    if (!toggle) return;
    const group = toggle.parentElement;
    const menu = group.querySelector('[ngbdropdownmenu]');
    let wrapper = null;
    const open = () => {
      const r = toggle.getBoundingClientRect();
      wrapper = document.createElement('div');
      wrapper.className = 'dropdown show';
      wrapper.style.cssText = `top:${r.bottom + scrollY}px;left:${r.left + scrollX}px`;
      menu.classList.add('show');
      wrapper.appendChild(menu);
      document.body.appendChild(wrapper);
      toggle.setAttribute('aria-expanded', 'true');
    };
    closeMenu = () => {
      if (!wrapper) return;
      menu.classList.remove('show');
      group.appendChild(menu);
      wrapper.remove();
      wrapper = null;
      toggle.setAttribute('aria-expanded', 'false');
    };
    toggle.addEventListener('click', () => {
      event('toggle-click');
      if (wrapper) closeMenu();
      else open();
    });
    document.addEventListener('click', (e) => {
      if (wrapper && !toggle.contains(e.target)) setTimeout(closeMenu);
    });
    menu.querySelectorAll('input[type="radio"]').forEach((input) =>
      input.addEventListener('change', () => {
        menu.querySelectorAll('mat-radio-button').forEach((rb) => rb.classList.toggle('mat-mdc-radio-checked', rb.contains(input)));
        portfolioId = Number(input.value);
        event('program-change', { program: portfolios.find((p) => p.id === portfolioId)?.shortCode });
        getAvailable(portfolioId, false);
      })
    );
  }

  // ---------- grids (same column setup as the portal) ----------
  function actionCell(actions, onClick) {
    return (params) => {
      const host = document.createElement('app-action-renderer');
      for (const a of actions) {
        const b = document.createElement('button');
        b.setAttribute('mat-icon-button', '');
        b.setAttribute('color', 'primary');
        b.setAttribute('aria-label', a.title);
        b.className = 'mdc-icon-button mat-mdc-icon-button mat-primary mat-mdc-button-base mat-mdc-tooltip-trigger';
        b.innerHTML = `<span class="mat-mdc-button-persistent-ripple mdc-icon-button__ripple"></span><mat-icon role="img" color="${a.cls}" class="mat-icon notranslate mat-${a.cls} material-icons mat-ligature-font" aria-hidden="true" data-mat-icon-type="font">${a.icon}</mat-icon><span class="mat-mdc-focus-indicator"></span><span class="mat-mdc-button-touch-target"></span>`;
        b.addEventListener('click', () => onClick(a.id, params.data));
        host.appendChild(b);
      }
      return host;
    };
  }

  function createGrids() {
    const defaultColDef = { resizable: true, sortable: true, unSortIcon: true, filterParams: { maxNumConditions: 1 } };
    availableApi = agGrid.createGrid(document.getElementById('grid-available'), {
      columnDefs: [
        { field: 'sectionName', headerName: 'Course Name', filter: 'agTextColumnFilter', sort: 'asc', valueGetter: (p) => label(p.data) },
        { field: 'prerequisiteCourses', headerName: 'Pre Requisite', filter: 'agTextColumnFilter', getQuickFilterText: () => '', valueGetter: (p) => p.data.prerequisiteCourses || 'N/A' },
        { field: 'courseEquivalences', headerName: 'Course Equivalences', filter: 'agTextColumnFilter', getQuickFilterText: () => '', valueGetter: (p) => p.data.courseEquivalences || 'N/A' },
        { field: 'consumedSeat', hide: true },
        {
          colId: '__action',
          headerName: 'Action',
          pinned: 'right',
          width: 120,
          sortable: false,
          resizable: false,
          cellRenderer: actionCell(
            [
              { id: 'view', title: 'View', icon: 'visibility', cls: 'primary' },
              { id: 'add', title: 'Add', icon: 'add_circle', cls: 'success' },
            ],
            onAvailableAction
          ),
        },
      ],
      defaultColDef,
      rowBuffer: 0,
      suppressMenuHide: true,
      suppressCellFocus: true,
      getRowId: (p) => String(p.data.sectionId),
      rowData: [],
    });
    selectedApi = agGrid.createGrid(document.getElementById('grid-selected'), {
      columnDefs: [
        { field: 'sectionName', headerName: 'Course Name', filter: 'agTextColumnFilter', cellRenderer: (p) => `${p.data.courseCode}-[${p.data.sectionName}]  -${p.data.faculties || 'N/A'}` },
        {
          colId: '__action',
          headerName: 'Action',
          pinned: 'right',
          width: 120,
          sortable: false,
          resizable: false,
          cellRenderer: actionCell(
            [
              { id: 'view', title: 'View', icon: 'visibility', cls: 'primary' },
              { id: 'drop', title: 'Drop', icon: 'remove_circle', cls: 'danger' },
            ],
            onSelectedAction
          ),
        },
      ],
      defaultColDef,
      rowBuffer: 0,
      suppressCellFocus: true,
      getRowId: (p) => String(p.data.sectionId),
      overlayNoRowsTemplate: 'No Section Selected',
      rowData: [],
    });

    const input = appList.querySelector('input.quick-filter');
    const reset = appList.querySelector('#mock-reset-filter');
    input.addEventListener('input', () => {
      availableApi.setGridOption('quickFilterText', input.value || '');
      availableApi.redrawRows();
      reset.disabled = !input.value;
      event('search', { value: input.value });
    });
    reset.addEventListener('click', () => {
      input.value = '';
      availableApi.setGridOption('quickFilterText', '');
      reset.disabled = true;
    });
  }

  // Other students' seat changes: the portal redraws and flashes rows as they arrive.
  function startNoise() {
    noiseTimer = setInterval(() => {
      const nodes = [];
      availableApi?.forEachNodeAfterFilter((n) => nodes.push(n));
      const node = nodes[Math.floor(Math.random() * nodes.length)];
      if (!node) return;
      node.setDataValue('consumedSeat', node.data.consumedSeat);
      availableApi.redrawRows({ rowNodes: [node] });
      availableApi.flashCells({ rowNodes: [node] });
    }, 300);
  }

  // ---------- actions ----------
  async function onAvailableAction(id, s) {
    if (id === 'view') return notify.info(`${s.courseCode}-${s.sectionName}`);
    event('add-click', { sectionId: s.sectionId, label: label(s) });
    if (s.courseCredit + credits > student.maxLoad) return notify.warning('Credit limit exceeded');
    if (selected.some((x) => x.courseId === s.courseId)) return notify.warning('You have already added another section. Please drop it before adding this one.');
    if (cfg.conflicts.includes(s.sectionId)) return notify.warning('You have taken course that class schedule conflict with another course');
    const r = await notify.confirm(
      `<br> Do you want to add this section <span class="text-primary">${s.courseCode}-${s.sectionName}</span> ?\n         <br> <i> Your added courses are automatically saved. </i>`,
      'Yes',
      'No'
    );
    event('confirm-answer', { sectionId: s.sectionId, answer: r.isConfirmed ? 'yes' : 'no' });
    if (r.isConfirmed) submitAdd(s, false);
  }

  async function submitAdd(s, repeat) {
    spinner.show();
    clearTimeout(fallbackTimer);
    fallbackTimer = setTimeout(() => {
      spinner.hide();
      loadSchedules();
    }, cfg.fallbackMs); // the portal's 40 s give-up timer
    const res = await post('add', { program: portfolioId, sectionId: s.sectionId, repeat });
    if (res.status === 'NONE') return; // no result ever arrives
    clearTimeout(fallbackTimer);
    spinner.hide();
    const interrupt = res.status === 'ADDED' ? cfg.interrupts.find((i) => i.afterAdds === addsDone + 1) : null;
    switch (res.status) {
      case 'ADDED':
        addsDone++;
        notify.success('Successfully Added');
        if (interrupt?.timing === 'before-refresh') return showInterrupt(interrupt);
        await loadSchedules();
        if (interrupt) showInterrupt(interrupt);
        break;
      case 'ERROR':
        notify.error(res.message);
        break;
      case 'REPEAT': {
        const r = await notify.confirm(res.message || 'You have completed this course before. Do you want to repeat it?', 'Yes', 'No');
        event('repeat-answer', { answer: r.isConfirmed ? 'yes' : 'no' });
        if (r.isConfirmed) submitAdd(s, true);
        break;
      }
      case 'HTTP400':
        concurrentError();
        break;
      case 'HTTP500':
        notify.error('Http failure response for https://connect.bracu.ac.bd/api/adv/v1/student-courses/SELF_REGISTRATION: 500 Internal Server Error');
        break;
    }
  }

  function showInterrupt(it) {
    event('interrupt', { kind: it.type });
    if (it.type === 'use-here') {
      notify.confirm('Your advising panel is open in another window/device!! Please click "Use Here" to continue advising here.', 'Use Here').then(() => concurrentError());
    } else if (it.type === 'system-updated') {
      notify.confirm('The system state has been updated!! Click reload to fetch new data!!', 'Reload').then((r) => r.isConfirmed && concurrentError());
    } else if (it.type === 'data-changed') {
      notify.confirm('Advising data has changed. Please confirm to continue with the most current information.', 'Ok').then(() => loadSchedules());
    }
  }

  function onSelectedAction(id, s) {
    if (id === 'drop') {
      event('drop-click', { sectionId: s.sectionId });
      notify.confirm(`<br>Do you want to drop this section <span class="text-primary">${s.courseCode}-${s.sectionName}</span> ?`, 'Yes', 'No');
    }
  }

  loadInfo();
})();
