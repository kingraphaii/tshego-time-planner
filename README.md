# Pace — a calm time planner

A small planner for someone juggling multiple roles (work, courses, personal time)
who wants to stay sustainable instead of burning out. No framework, no build step,
no backend. Plain HTML + CSS + JS, deployable to GitHub Pages in three clicks.
Works offline as an installable PWA.

## What it does

- **Roles with weekly hour budgets** — put a ceiling on each bucket so overload
  becomes visible before it becomes painful.
- **Week planner** — drag-free click-to-plan time blocks on a 7-day grid.
- **Tasks** — capture work with an estimate, then schedule it.
- **Daily check-in** — 10-second pulse on energy and sleep. Patterns show up
  over a week.
- **Signals** — surfaces overload warnings (low energy streaks, sleep debt,
  over-scheduled weeks) so the next action is obvious.
- **Protected sleep window** — set bedtime and wake time once, get gentle
  reminders every day.

All data lives in the browser's `localStorage`. Export to JSON whenever you want.

## Run it locally

No dependencies. Open `index.html` directly or serve the folder:

```bash
# any static server works
python3 -m http.server 8080
# or
npx serve .
```

Then open http://localhost:8080.

## Deploy to GitHub Pages

1. Push this folder to a new GitHub repo.
2. In the repo: **Settings → Pages → Branch: `main` / folder: `/ (root)` → Save**.
3. Wait a minute. The app will be live at
   `https://<your-username>.github.io/<repo-name>/`.

The `.nojekyll` file in this repo disables Jekyll processing so nothing is
rewritten on the way out.

## Install as a mobile app (PWA)

Once deployed to HTTPS (GitHub Pages qualifies), Pace can be installed to any
modern phone home screen and runs offline.

- **iOS / Safari**: open the URL → Share → **Add to Home Screen**. Launches as
  a standalone app with the custom icon, no browser chrome, dark status bar.
- **Android / Chrome**: a small **Install** banner appears on the address bar
  after a few seconds of use, or via the three-dot menu → **Install app**.
- **Desktop Chrome / Edge**: install icon appears on the right side of the
  address bar.

First load requires network; after that all data (roles, blocks, tasks,
check-ins) and the app shell itself work fully offline, since everything lives
in `localStorage` and the service worker (`sw.js`) caches the static assets.

### What the mobile build does differently

- Bottom tab-bar navigation with safe-area insets for the home indicator.
- Modals slide up from the bottom as sheets.
- Inputs are 16px on touch devices so iOS Safari doesn't zoom on focus.
- Week view scrolls horizontally on narrow screens (swipeable).
- Tap highlights disabled; scale-on-press gives explicit feedback.
- Theme-color meta reacts to system dark / light preference for the PWA chrome.

## Customize

- **Name, bedtime, theme** — set in the Settings view inside the app.
- **Role colors** — edit `ROLE_COLORS` in `app.js` if you want a different
  palette.
- **Week hours shown** — change `HOUR_START` / `HOUR_END` in `app.js`
  (defaults: 6am to midnight).

## Philosophy

This started from a conversation about mentoring someone who was taking on too
much at once. The goal is not more productivity — it's visible workload.

- Capacity is shown as a number, not a vibe.
- Sleep is a guardrail, not a "nice to have".
- Three bad days in a row should trigger a signal, not a surprise.

Short answers beat clever ones. If a feature does not help someone notice they
are overloaded, it does not belong here.
