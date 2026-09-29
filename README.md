# Advising Bot

A Chrome extension that runs BRACU Connect advising for you at a time you choose.
It works on all three advising pages, which in the portal are the same page with a different title:

- **Self Registration**: `connect.bracu.ac.bd/student/advising/self-registration`
- **Pre-Registration Phase One**: `connect.bracu.ac.bd/student/advising/phase-one`
- **Pre-Registration Phase Two**: `connect.bracu.ac.bd/student/advising/phase-two`

On whichever of them your tab is on when you click **Arm** (or **Run now**), it:

1. at the start time, clicks **Select Advising →** the program you entered (e.g. **MENGGCSE(POSTGRADUATE)**), or with Program left empty uses the only open program, and waits for the page to load (if the page was opened before registration opened, it reloads it first),
2. if your program says it isn't open yet, reloads and does step 1 again every few seconds until it opens,
3. for each course: types it in the search box → clicks **+** → checks the popup names that exact section → **Yes** → waits for the page to finish loading,
4. stops when every course is done and shows a summary.

It never clicks **Confirm Advising** (only Self Registration has it), the red remove (Drop) buttons or the Actions menu.
**Dry run** (on by default) goes through everything but answers **No** in the popup.

## Install

1. Open `chrome://extensions` and turn on **Developer mode** (top right).
2. Click **Load unpacked** and pick the `extension/` folder of this project.
3. Pin the extension (puzzle icon → pin) so the popup is one click away.

After changing any file in `extension/`, press the reload icon on the extension's card, then reload the portal tab.

## Use it

1. Log in to Connect and open the advising page you want (Self Registration, Phase One or Phase Two). Keep **only one** advising tab open: the portal kicks out duplicates ("Your advising panel is open in another window"). The bot stays on the page the tab was on when you armed it.
2. Click the extension icon and fill in:
   - **Program**: exactly as the Select Advising menu shows it, e.g. `MENGGCSE(POSTGRADUATE)`. The bot only ever uses that exact program.
     If you have just one program, you can leave it empty: the bot uses the only open program. If you have more than one (an old undergraduate program counts), fill it in. With it empty and several programs open, the bot refuses rather than guess.
   - **Courses**: one per line, **no spaces**, in the portal's own format:
     - `CSE705-[01]` for that exact section (the search box then shows only that section),
     - `CSE705` for any section: the first one with free seats.
   - **Start at**: date and time, to the second.
3. Click **Check page**. Everything should be ✔; lines marked **!** are notes (before registration opens, "Not open yet" is expected).
4. Rehearse: with **Dry run** ticked, click **Run now** and watch it select the program, search each course, open each confirm popup and answer No.
5. For the real thing: untick **Dry run**, set the start time, click **Arm** and confirm.
6. Until then, keep the tab **visible** (don't minimise Chrome) and the laptop **plugged in and unlocked**. The extension keeps the screen awake, reloads the page every 10 minutes to keep your login alive, brings the tab to the front a minute before the start, and warns you 2 minutes before if you've been logged out.

The panel in the bottom-left corner of the page and the popup both show progress and have a **STOP** button. A notification shows the result at the end.

### What each course status means

| Status | Meaning |
|---|---|
| added | the section appeared in Selected Sections |
| already | it was already in Selected Sections, so nothing was clicked |
| skipped | a different section of that course is already selected (the bot never drops anything), or you answered No to a repeat / retake question |
| failed | the portal refused it; the message says why (no seat, time clash, credit limit, …) |
| not found | the course isn't in Available Courses (typo, or not offered) |
| dry-run | dry run: the popup named the right section and the bot answered No |

### Advanced settings

| Setting | Default | |
|---|---|---|
| Reload every (s) until registration opens | 4 | how often it reloads while the page says it isn't open yet |
| Keep trying for (min) | 5 | then it gives up and notifies you |
| Wait for each result (s) | 45 | the portal itself gives up after 40 s |
| Tries per course | 2 | a course is tried again after "no result" or a server (5xx) error |
| Keep-alive reload every (min) | 10 | 0 turns it off |
| Pre-flight check (min before) | 2 | reload + login check before the start; 0 turns it off |
| Bring the tab to the front | on | background tabs run timers late |
| Answer Yes to repeat / retake | off | otherwise that course is skipped |

## Checklist for the day

- [ ] Chrome is up to date, the extension is loaded, the laptop is plugged in, sleep is off.
- [ ] Logged in; exactly one advising tab, on the right page (Self Registration / Phase One / Phase Two).
- [ ] **Check page**: all ✔, and the clock line says your clock matches the portal's.
- [ ] A dry run went through every course.
- [ ] Course list and start time double-checked; **Dry run** unticked; **Arm**ed.
- [ ] Don't touch the advising page (or open it on your phone) while the bot runs.

## If something goes wrong

- **Check page shows ✖**: the portal's markup may have changed. Click **Copy debug snapshot**, paste it into a file, and use it to fix the selectors in `extension/content/portal.js` (every selector lives there).
- **Nothing happens after Run now / Arm**: tabs opened before the extension was loaded or reloaded can't hear it until they reload. The extension notices and reloads the tab itself; the popup says so. If it still doesn't start, reload the tab (F5).
- **Wrong Program name**: Arm / Run now warn straight away if the page shows other programs ("The page shows MENGGCSE(POSTGRADUATE), not …"). The bot never clicks anything under another program; after "Keep trying for" it stops with "… never appeared. The page offered …".
- **Logged out**: the bot can't log in for you. Log in again; if it happens during a run, the run continues once the page is back.
- **Your clock is off**: fix the system clock (Ubuntu: `timedatectl set-ntp true`).
- The log in the popup (**Log**) and the browser console (`[Advising Bot]` lines) show every step.

## How the portal works (what the bot relies on)

Learned from the portal's public JavaScript (Angular 15, AG Grid 31.1.1, SweetAlert2 11.4.8) and checked against a DOM capture:

- The page asks for the open advising sessions **once**, when it loads. If it was opened before registration opened, it shows "Advising has not been scheduled or has been expired" forever. So the bot reloads.
- **Select Advising** only exists when more than one program is open, and the portal selects the first one in the menu by itself (e.g. CS(UNDERGRADUATE)). With only one program open there is no menu; the bot checks the title shows your program and goes straight to the courses.
- A "not scheduled or expired" message is about whichever program is selected. The first program can show it while yours is open, so the bot switches to **the program you entered** before deciding whether registration is open. It only ever picks that exact program: if it isn't offered, the bot waits and reloads, then stops, and never adds courses under another program.
- The search box feeds AG Grid's quick filter. A space means "match each word separately", which is why entries have no spaces.
- The number in `CSE705-[01](8)-TBA` is seats left.
- After **Yes**, the result arrives a few seconds later: a "Successfully Added" toast and a refreshed Selected Sections, or an error popup. An HTTP 400 makes the page start over with the first program.
- The portal's own checks (credit limit, time clash, another section already added) show a 3-second warning instead of the confirm popup.

## Development

```bash
npm install
npx playwright install chromium   # once: Playwright's Chromium (branded Chrome can't load test extensions)
npm test                          # parser unit tests
npm run test:e2e                  # the extension against the mock portal (about 5 minutes)
npm run mock                      # mock portal at http://localhost:8787/student/advising/self-registration
```

`mock/` is a stand-in for the real page (served at all three addresses), built with the same AG Grid and SweetAlert2 versions and the same markup and behaviour. The end-to-end tests drive the real extension against it through the popup. They cover the normal run, exact vs. any section, scrolling to hidden rows, the reload loop before opening, switching away from a closed default program, an empty or wrong Program name, the Phase Two page, page resets, "Use Here", errors, retries, dry run, Stop, start-time accuracy, returning to the page if the tab wandered off, reconnecting a tab that can't hear the extension, and the keep-alive and pre-flight alarms. Every test also checks that Confirm Advising and Drop are never clicked.

The `localhost` entries in `extension/manifest.json` exist only so the extension can run against the mock (`http://localhost:8787/student/...`).

```
extension/
  manifest.json
  background.js        arming, alarms, the advising tab, keep-awake, notifications, clock check
  shared/config.js     settings, course-list and label parsers (also used by the tests)
  content/portal.js    every selector for the portal page
  content/runner.js    the run itself
  content/swal.js      popups (confirm, toasts, errors)
  content/dom.js       waiting / clicking / typing helpers
  content/overlay.js   the status panel on the page
  content/main.js      start timer, resume after reloads
  popup/               settings and status
mock/                  local copy of the page for testing
tests/                 unit tests and Playwright end-to-end tests
```

Automating the portal may be against BRACU's IT rules. That's your call. The bot works one course at a time, waits for each result, and only clicks what you would click yourself.

## License

MIT, see [LICENSE](LICENSE). Not affiliated with or endorsed by BRAC University.
