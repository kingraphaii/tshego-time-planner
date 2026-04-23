/* =============================================================
   Pace — sustainable time planning
   Vanilla HTML/JS app. No build step. Persists to localStorage.
   ============================================================= */

/* ============================================================
   CONSTANTS
   ============================================================ */

const STORAGE_KEY = 'pace:v1';

const ROLE_COLORS = [
  '#60a5fa', '#a78bfa', '#f472b6', '#34d399',
  '#fbbf24', '#fb7185', '#22d3ee', '#c084fc',
];

const FEELINGS = [
  { value: 1, label: 'Drained', hint: 'empty tank' },
  { value: 2, label: 'Low',     hint: 'sluggish' },
  { value: 3, label: 'OK',      hint: 'steady' },
  { value: 4, label: 'Good',    hint: 'on a roll' },
  { value: 5, label: 'Flowing', hint: 'in the zone' },
];

const PRIORITIES = [
  { value: 'low',    label: 'Low' },
  { value: 'medium', label: 'Medium' },
  { value: 'high',   label: 'High' },
];

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const DAY_NAMES_LONG = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

const HOUR_START = 6;   // 6 AM
const HOUR_END   = 24;  // midnight
const HOURS      = HOUR_END - HOUR_START;
const PX_PER_MIN = 40 / 60; // 40px per hour

const DEFAULT_STATE = {
  version: 1,
  hasOnboarded: false,
  settings: {
    name: '',
    bedtime: '22:30',
    wakeTime: '06:30',
    weekStartsMonday: true,
    theme: 'dark',
  },
  roles: [],
  tasks: [],
  blocks: [],
  checkIns: [],
};

/* ============================================================
   STATE
   ============================================================ */

let state = structuredClone(DEFAULT_STATE);

/* IndexedDB wrapper. More durable than localStorage — survives storage-pressure
   eviction that localStorage is first in line for, and installable PWAs can
   request persistent-storage grants so the OS won't evict at all. */

const DB_NAME = 'pace';
const DB_VERSION = 1;
const DB_STORE = 'kv';
let _dbPromise = null;

function idbOpen() {
  if (_dbPromise) return _dbPromise;
  _dbPromise = new Promise((resolve, reject) => {
    if (!('indexedDB' in self)) return reject(new Error('IDB unavailable'));
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(DB_STORE)) db.createObjectStore(DB_STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return _dbPromise;
}

function idbGet(key) {
  return idbOpen().then((db) => new Promise((resolve, reject) => {
    const req = db.transaction(DB_STORE, 'readonly').objectStore(DB_STORE).get(key);
    req.onsuccess = () => resolve(req.result ?? null);
    req.onerror = () => reject(req.error);
  }));
}

function idbSet(key, value) {
  return idbOpen().then((db) => new Promise((resolve, reject) => {
    const tx = db.transaction(DB_STORE, 'readwrite');
    tx.objectStore(DB_STORE).put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  }));
}

function hydrateState(raw) {
  return {
    ...structuredClone(DEFAULT_STATE),
    ...raw,
    settings: { ...DEFAULT_STATE.settings, ...(raw.settings || {}) },
  };
}

async function loadStateAsync() {
  try {
    const stored = await idbGet('state');
    if (stored) { state = hydrateState(stored); return; }
  } catch (e) {
    console.warn('[pace] IDB read failed, falling back to localStorage', e);
  }
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return;
    state = hydrateState(JSON.parse(raw));
    // Migrate legacy data to IDB and clear the old copy.
    try {
      await idbSet('state', state);
      localStorage.removeItem(STORAGE_KEY);
    } catch {}
  } catch (e) {
    console.warn('[pace] localStorage read failed', e);
  }
}

let saveTimer = null;
function saveState() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    idbSet('state', state).catch(() => {
      // IDB failed (private mode, quota, etc.) — fall back to localStorage.
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
      } catch (e) {
        toast('Storage error: ' + e.message, 'error');
      }
    });
  }, 80);
}

function setState(patch, { rerender = true } = {}) {
  state = typeof patch === 'function' ? patch(state) : { ...state, ...patch };
  saveState();
  if (rerender) render();
}

/* ============================================================
   UTILITIES
   ============================================================ */

const uid = () =>
  (crypto.randomUUID && crypto.randomUUID()) ||
  'id-' + Math.random().toString(36).slice(2) + Date.now().toString(36);

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const pad = (n) => String(n).padStart(2, '0');

function isoDate(d = new Date()) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function parseDate(s) {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, m - 1, d);
}

function addDays(date, n) {
  const d = new Date(date);
  d.setDate(d.getDate() + n);
  return d;
}

function startOfWeek(date, mondayFirst = true) {
  const d = new Date(date);
  const day = d.getDay();
  const diff = mondayFirst ? (day === 0 ? -6 : 1 - day) : -day;
  d.setDate(d.getDate() + diff);
  d.setHours(0, 0, 0, 0);
  return d;
}

function timeToMinutes(hhmm) {
  if (!hhmm) return 0;
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
}

function minutesToTime(mins) {
  const m = ((mins % (24 * 60)) + 24 * 60) % (24 * 60);
  return `${pad(Math.floor(m / 60))}:${pad(m % 60)}`;
}

function formatTime12(hhmm) {
  if (!hhmm) return '';
  const [h, m] = hhmm.split(':').map(Number);
  const period = h >= 12 ? 'PM' : 'AM';
  const h12 = h % 12 || 12;
  return `${h12}:${pad(m)} ${period}`;
}

function formatDuration(mins) {
  if (mins < 60) return `${mins}m`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m === 0 ? `${h}h` : `${h}h ${m}m`;
}

function blockMinutes(b) {
  return timeToMinutes(b.endTime) - timeToMinutes(b.startTime);
}

function humanDate(d) {
  return d.toLocaleDateString(undefined, {
    weekday: 'long', month: 'long', day: 'numeric',
  });
}

function shortDate(d) {
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

function hexToRgba(hex, alpha) {
  const h = hex.replace('#', '');
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

function roleById(id) { return state.roles.find((r) => r.id === id); }
function taskById(id) { return state.tasks.find((t) => t.id === id); }

function blocksForDate(dateStr) {
  return state.blocks
    .filter((b) => b.date === dateStr)
    .sort((a, b) => timeToMinutes(a.startTime) - timeToMinutes(b.startTime));
}

function blocksThisWeek() {
  const start = startOfWeek(new Date(), state.settings.weekStartsMonday);
  const end = addDays(start, 7);
  return state.blocks.filter((b) => {
    const d = parseDate(b.date);
    return d >= start && d < end;
  });
}

function minutesScheduledThisWeekByRole(roleId) {
  return blocksThisWeek()
    .filter((b) => b.roleId === roleId)
    .reduce((sum, b) => sum + blockMinutes(b), 0);
}

function totalMinutesScheduledThisWeek() {
  return blocksThisWeek().reduce((sum, b) => sum + blockMinutes(b), 0);
}

function totalWeeklyBudgetMinutes() {
  return state.roles.reduce((sum, r) => sum + (r.weeklyHoursBudget || 0) * 60, 0);
}

function todayCheckIn() {
  const today = isoDate();
  return state.checkIns.find((c) => c.date === today);
}

function recentCheckIns(days = 14) {
  const cutoff = addDays(new Date(), -days);
  return state.checkIns
    .filter((c) => parseDate(c.date) >= cutoff)
    .sort((a, b) => a.date.localeCompare(b.date));
}

/* ============================================================
   INSIGHTS — overload/energy pattern detection
   ============================================================ */

function computeInsights() {
  const insights = [];
  const recent = recentCheckIns(7);

  // Low-energy streak
  const lastThree = recent.slice(-3);
  if (lastThree.length === 3 && lastThree.every((c) => c.energy <= 2)) {
    insights.push({
      level: 'alarm',
      title: 'Three low-energy days in a row',
      body: 'Consider scaling back commitments this week. Overload often shows up as exhaustion before it shows up as missed work.',
    });
  }

  // Sleep debt
  const lastFive = recent.slice(-5).filter((c) => c.sleepHours != null);
  if (lastFive.length >= 3) {
    const avg = lastFive.reduce((s, c) => s + c.sleepHours, 0) / lastFive.length;
    if (avg < 6.5) {
      insights.push({
        level: 'warn',
        title: `Sleep is short: ${avg.toFixed(1)}h average`,
        body: 'Shift bedtime earlier tonight. Sleep debt compounds silently.',
      });
    }
  }

  // Weekly capacity
  const scheduled = totalMinutesScheduledThisWeek() / 60;
  if (scheduled > 55) {
    insights.push({
      level: 'alarm',
      title: `${scheduled.toFixed(1)}h scheduled this week`,
      body: 'Anything over 55 focused hours tends to burn people out. Move something to next week or cut scope.',
    });
  } else if (scheduled > 45) {
    insights.push({
      level: 'warn',
      title: `${scheduled.toFixed(1)}h scheduled this week`,
      body: 'Heavy but manageable. Protect your evenings and one full rest block.',
    });
  }

  // Positive — streak
  const streak = recent.slice(-3).filter((c) => c.energy >= 4).length;
  if (streak === 3) {
    insights.push({
      level: 'calm',
      title: 'Three strong days in a row',
      body: 'Whatever you are doing is working. Notice what it is — structure, sleep, scope — and keep it.',
    });
  }

  return insights;
}

/* ============================================================
   SNAPSHOT — mentor-safe image export
   ============================================================ */

function snapshotRelativeTime(ts) {
  if (!ts) return 'never';
  const delta = Math.max(0, Date.now() - ts);
  if (delta < 60_000) return 'just now';
  if (delta < 3_600_000) return `${Math.floor(delta / 60_000)}m ago`;
  if (delta < 86_400_000) return `${Math.floor(delta / 3_600_000)}h ago`;
  const days = Math.floor(delta / 86_400_000);
  return days === 1 ? 'yesterday' : `${days}d ago`;
}

function roundRect(ctx, x, y, w, h, r) {
  const rad = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rad, y);
  ctx.arcTo(x + w, y,     x + w, y + h, rad);
  ctx.arcTo(x + w, y + h, x,     y + h, rad);
  ctx.arcTo(x,     y + h, x,     y,     rad);
  ctx.arcTo(x,     y,     x + w, y,     rad);
  ctx.closePath();
}

function snapWrapText(ctx, text, maxWidth, maxLines = 2) {
  const words = String(text || '').split(' ');
  const lines = [];
  let line = '';
  for (const w of words) {
    const test = line ? line + ' ' + w : w;
    if (ctx.measureText(test).width > maxWidth && line) {
      lines.push(line);
      if (lines.length === maxLines) return lines;
      line = w;
    } else {
      line = test;
    }
  }
  if (line) lines.push(line);
  return lines;
}

async function renderSnapshotBlob() {
  try { if (document.fonts && document.fonts.ready) await document.fonts.ready; } catch {}

  const DPR = 2;
  const W = 1080, H = 1350;
  const canvas = document.createElement('canvas');
  canvas.width = W * DPR;
  canvas.height = H * DPR;
  const ctx = canvas.getContext('2d');
  ctx.scale(DPR, DPR);
  ctx.textBaseline = 'alphabetic';

  // Background
  ctx.fillStyle = '#0b1220';
  ctx.fillRect(0, 0, W, H);

  // Top accent stripe
  const stripe = ctx.createLinearGradient(0, 0, W, 0);
  stripe.addColorStop(0, '#60a5fa');
  stripe.addColorStop(1, '#a78bfa');
  ctx.fillStyle = stripe;
  ctx.fillRect(0, 0, W, 5);

  const pad = 64;
  const contentW = W - pad * 2;
  let y = pad + 16;

  // Brand
  ctx.fillStyle = '#60a5fa';
  ctx.font = '600 18px "Inter", system-ui, sans-serif';
  ctx.fillText('PACE', pad, y + 14);

  y += 56;

  // Headline
  const name = (state.settings.name && state.settings.name.trim()) || 'A calm week';
  ctx.fillStyle = '#e5ecf5';
  ctx.font = '700 44px "Inter", system-ui, sans-serif';
  ctx.fillText(`${name}`, pad, y + 38);

  y += 52;

  const weekStart = startOfWeek(new Date(), state.settings.weekStartsMonday);
  const weekEnd = addDays(weekStart, 6);
  ctx.fillStyle = '#93a2bd';
  ctx.font = '500 22px "Inter", system-ui, sans-serif';
  ctx.fillText(`Week of ${shortDate(weekStart)} – ${shortDate(weekEnd)}`, pad, y + 22);

  y += 78;

  // ---- Stat row ----
  const cardGap = 20;
  const cardW = (contentW - cardGap) / 2;
  const cardH = 160;
  const totalHours = totalMinutesScheduledThisWeek() / 60;
  const recent = recentCheckIns(14);
  const sleepEntries = recent.filter((c) => c.sleepHours != null);
  const avgSleep = sleepEntries.length
    ? (sleepEntries.reduce((s, c) => s + c.sleepHours, 0) / sleepEntries.length)
    : null;

  snapDrawStatCard(ctx, pad,             y, cardW, cardH, totalHours.toFixed(1) + 'h', 'planned this week', '#60a5fa');
  snapDrawStatCard(ctx, pad + cardW + cardGap, y, cardW, cardH,
    avgSleep != null ? avgSleep.toFixed(1) + 'h' : '—',
    avgSleep != null ? 'avg sleep (14 days)' : 'no sleep logged yet',
    '#34d399');

  y += cardH + 40;

  // ---- Roles ----
  if (state.roles.length > 0) {
    ctx.fillStyle = '#5e6d87';
    ctx.font = '600 13px "Inter", system-ui, sans-serif';
    ctx.fillText('ROLES THIS WEEK', pad, y);
    ctx.fillStyle = '#22304a';
    ctx.fillRect(pad + 180, y - 6, contentW - 180, 1);
    y += 22;

    for (const r of state.roles.slice(0, 6)) {
      const scheduled = minutesScheduledThisWeekByRole(r.id) / 60;
      const budget = r.weeklyHoursBudget || 0;
      snapDrawRoleRow(ctx, pad, y, contentW, r, scheduled, budget);
      y += 44;
    }
    y += 12;
  }

  // ---- Charts ----
  if (recent.length > 0) {
    ctx.fillStyle = '#5e6d87';
    ctx.font = '600 13px "Inter", system-ui, sans-serif';
    ctx.fillText('ENERGY, LAST 14 DAYS', pad, y);
    y += 18;
    snapDrawEnergyChart(ctx, pad, y, contentW, 120, recent);
    y += 140;

    ctx.fillStyle = '#5e6d87';
    ctx.font = '600 13px "Inter", system-ui, sans-serif';
    ctx.fillText('SLEEP, LAST 14 DAYS', pad, y);
    y += 18;
    snapDrawSleepChart(ctx, pad, y, contentW, 90, recent);
    y += 110;
  } else {
    // No data yet — a gentle note so the snapshot still makes sense.
    ctx.fillStyle = '#5e6d87';
    ctx.font = '500 16px "Inter", system-ui, sans-serif';
    ctx.fillText('No check-ins logged yet. Two weeks is a good lens.', pad, y + 20);
    y += 60;
  }

  // ---- Signal ----
  const insights = computeInsights();
  if (insights.length > 0) {
    snapDrawSignal(ctx, pad, y, contentW, 90, insights[0]);
    y += 110;
  }

  // ---- Footer ----
  const footerY = H - pad;
  ctx.fillStyle = '#5e6d87';
  ctx.font = '500 14px "Inter", system-ui, sans-serif';
  const ts = new Date().toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
  ctx.fillText(`Shared from Pace · ${ts}`, pad, footerY);
  ctx.textAlign = 'right';
  ctx.fillText('Totals & trends only — no notes or task titles included.', W - pad, footerY);
  ctx.textAlign = 'start';

  return await new Promise((resolve) => canvas.toBlob(resolve, 'image/png', 0.95));
}

function snapDrawStatCard(ctx, x, y, w, h, big, label, color) {
  ctx.fillStyle = '#131c30';
  ctx.strokeStyle = '#22304a';
  ctx.lineWidth = 1;
  roundRect(ctx, x, y, w, h, 16);
  ctx.fill();
  ctx.stroke();

  ctx.fillStyle = color;
  ctx.font = '700 70px "JetBrains Mono", ui-monospace, monospace';
  ctx.fillText(big, x + 28, y + 90);

  ctx.fillStyle = '#93a2bd';
  ctx.font = '500 16px "Inter", system-ui, sans-serif';
  ctx.fillText(label, x + 28, y + 128);
}

function snapDrawRoleRow(ctx, x, y, w, role, scheduled, budget) {
  // Swatch
  ctx.fillStyle = role.color;
  roundRect(ctx, x, y + 4, 10, 24, 3);
  ctx.fill();

  // Name
  ctx.fillStyle = '#e5ecf5';
  ctx.font = '600 18px "Inter", system-ui, sans-serif';
  ctx.fillText(role.name, x + 22, y + 22);

  // Bar
  const barX = x + 260;
  const barRight = x + w - 140;
  const barW = barRight - barX;
  const barY = y + 14;
  ctx.fillStyle = '#1a2540';
  roundRect(ctx, barX, barY, barW, 8, 4);
  ctx.fill();
  const pct = budget ? Math.min(1, scheduled / budget) : 0;
  if (pct > 0) {
    ctx.fillStyle = role.color;
    roundRect(ctx, barX, barY, barW * pct, 8, 4);
    ctx.fill();
  }

  // Numbers
  ctx.fillStyle = '#93a2bd';
  ctx.font = '500 15px "JetBrains Mono", ui-monospace, monospace';
  ctx.textAlign = 'right';
  ctx.fillText(`${scheduled.toFixed(1)} / ${budget || 0}h`, x + w, y + 22);
  ctx.textAlign = 'start';
}

function snapDrawEnergyChart(ctx, x, y, w, h, data) {
  // Guides at 1..5
  ctx.strokeStyle = '#1a2540';
  ctx.lineWidth = 1;
  for (let i = 1; i <= 5; i++) {
    const ly = y + h - ((i - 1) / 4) * h;
    ctx.save();
    ctx.setLineDash([2, 4]);
    ctx.beginPath();
    ctx.moveTo(x, ly);
    ctx.lineTo(x + w, ly);
    ctx.stroke();
    ctx.restore();
  }

  const days = 14;
  const today = new Date(isoDate());
  const points = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = addDays(today, -i);
    const ds = isoDate(d);
    const c = data.find((ci) => ci.date === ds);
    const px = x + ((days - 1 - i) / (days - 1)) * w;
    const py = c ? y + h - ((c.energy - 1) / 4) * h : null;
    points.push({ x: px, y: py });
  }
  const valid = points.filter((p) => p.y != null);

  if (valid.length > 1) {
    // Area under
    const grad = ctx.createLinearGradient(0, y, 0, y + h);
    grad.addColorStop(0, 'rgba(96,165,250,0.25)');
    grad.addColorStop(1, 'rgba(96,165,250,0)');
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.moveTo(valid[0].x, y + h);
    valid.forEach((p) => ctx.lineTo(p.x, p.y));
    ctx.lineTo(valid[valid.length - 1].x, y + h);
    ctx.closePath();
    ctx.fill();

    // Line
    ctx.strokeStyle = '#60a5fa';
    ctx.lineWidth = 2.5;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.beginPath();
    valid.forEach((p, i) => (i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y)));
    ctx.stroke();
  }

  // Dots
  valid.forEach((p) => {
    ctx.fillStyle = '#0b1220';
    ctx.strokeStyle = '#60a5fa';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(p.x, p.y, 3.5, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
  });
}

function snapDrawSleepChart(ctx, x, y, w, h, data) {
  const days = 14;
  const today = new Date(isoDate());
  const barW = Math.max(6, w / days - 6);
  const maxHrs = 10;

  // Guides at 6 and 8
  ctx.strokeStyle = '#1a2540';
  ctx.lineWidth = 1;
  for (const hrs of [6, 8]) {
    const ly = y + h - (hrs / maxHrs) * h;
    ctx.save();
    ctx.setLineDash([2, 4]);
    ctx.beginPath();
    ctx.moveTo(x, ly);
    ctx.lineTo(x + w, ly);
    ctx.stroke();
    ctx.restore();
  }

  for (let i = 0; i < days; i++) {
    const d = addDays(today, -(days - 1 - i));
    const ds = isoDate(d);
    const c = data.find((ci) => ci.date === ds);
    if (!c || c.sleepHours == null) continue;
    const hrs = Math.min(c.sleepHours, maxHrs);
    const bx = x + i * (w / days) + 2;
    const bh = (hrs / maxHrs) * h;
    const by = y + h - bh;
    ctx.fillStyle = hrs < 6 ? '#f87171' : hrs < 7 ? '#fbbf24' : '#34d399';
    roundRect(ctx, bx, by, barW, bh, 3);
    ctx.fill();
  }
}

function snapDrawSignal(ctx, x, y, w, h, insight) {
  const palette = {
    alarm: { bg: 'rgba(248,113,113,0.12)', stroke: '#f87171', dot: '#f87171' },
    warn:  { bg: 'rgba(251,191,36,0.14)',  stroke: '#fbbf24', dot: '#fbbf24' },
    calm:  { bg: 'rgba(52,211,153,0.12)',  stroke: '#34d399', dot: '#34d399' },
  };
  const c = palette[insight.level] || palette.warn;

  ctx.fillStyle = c.bg;
  ctx.strokeStyle = c.stroke;
  ctx.lineWidth = 1;
  roundRect(ctx, x, y, w, h, 12);
  ctx.fill();
  ctx.stroke();

  // Dot
  ctx.fillStyle = c.dot;
  ctx.beginPath();
  ctx.arc(x + 24, y + 30, 5, 0, Math.PI * 2);
  ctx.fill();

  // Title
  ctx.fillStyle = '#e5ecf5';
  ctx.font = '600 18px "Inter", system-ui, sans-serif';
  ctx.fillText(insight.title, x + 46, y + 34);

  // Body (wrapped, max 2 lines)
  ctx.fillStyle = '#93a2bd';
  ctx.font = '400 15px "Inter", system-ui, sans-serif';
  const lines = snapWrapText(ctx, insight.body, w - 68, 2);
  lines.forEach((line, i) => ctx.fillText(line, x + 46, y + 58 + i * 20));
}

async function openSnapshotModal() {
  const body = h(`
    <div class="stack">
      <p style="color:var(--text-muted); font-size:13px; margin:0">
        This is what your mentor will see. Only totals and trends — no notes, no task titles, no specific check-in text.
      </p>
      <div class="snapshot-preview" data-role="snapshot-preview">
        <div class="snapshot-loading">Generating…</div>
      </div>
    </div>
  `);
  const hasShare = !!(navigator.canShare && window.File);
  const footer = `
    <button class="btn btn-ghost" data-action="close-modal">Close</button>
    <button class="btn btn-secondary" data-action="snapshot-download" disabled>Download PNG</button>
    ${hasShare ? `<button class="btn btn-primary" data-action="snapshot-share" disabled>Share…</button>` : ''}
  `;
  openModal({
    title: 'Share a snapshot',
    body,
    footer,
    size: 'lg',
    onMount: async () => {
      const preview = document.querySelector('[data-role="snapshot-preview"]');
      try {
        const blob = await renderSnapshotBlob();
        if (!blob) throw new Error('Image generation failed');
        window.__paceSnapshot = blob;
        const url = URL.createObjectURL(blob);
        const img = new Image();
        img.src = url;
        img.alt = 'Snapshot preview';
        img.className = 'snapshot-img';
        img.onload = () => {
          preview.innerHTML = '';
          preview.appendChild(img);
        };
        document.querySelectorAll('[data-action="snapshot-download"], [data-action="snapshot-share"]').forEach((b) => b.disabled = false);
      } catch (e) {
        preview.innerHTML = `<div class="snapshot-loading" style="color:var(--danger)">Could not generate snapshot: ${esc(e.message)}</div>`;
      }
    },
  });
}

function snapshotDownload() {
  const blob = window.__paceSnapshot;
  if (!blob) return;
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `pace-snapshot-${isoDate()}.png`;
  a.click();
  URL.revokeObjectURL(url);
  toast('Saved', 'success');
}

async function snapshotShare() {
  const blob = window.__paceSnapshot;
  if (!blob) return;
  const file = new File([blob], `pace-snapshot-${isoDate()}.png`, { type: 'image/png' });
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try {
      await navigator.share({
        title: 'My week',
        text: `A snapshot from Pace · week of ${shortDate(startOfWeek(new Date(), state.settings.weekStartsMonday))}`,
        files: [file],
      });
    } catch (e) {
      if (e && e.name !== 'AbortError') toast('Share cancelled', 'error');
    }
  } else {
    snapshotDownload();
  }
}

/* ============================================================
   TOAST
   ============================================================ */

function toast(message, variant = '') {
  const root = document.getElementById('toast-root');
  const el = document.createElement('div');
  el.className = 'toast ' + (variant ? 'toast-' + variant : '');
  el.textContent = message;
  root.appendChild(el);
  setTimeout(() => el.remove(), 3000);
}

/* ============================================================
   ROUTER
   ============================================================ */

const VIEWS = {
  today:    renderToday,
  plan:     renderPlan,
  tasks:    renderTasks,
  roles:    renderRoles,
  reflect:  renderReflect,
  settings: renderSettings,
};

function currentView() {
  const hash = location.hash.replace(/^#\/?/, '') || 'today';
  return VIEWS[hash] ? hash : 'today';
}

function render() {
  const name = currentView();
  document.querySelectorAll('[data-view]').forEach((el) => {
    el.classList.toggle('is-active', el.dataset.view === name);
  });
  const root = document.getElementById('view-root');
  root.innerHTML = '';
  root.appendChild(VIEWS[name]());
}

/* ============================================================
   DOM HELPER
   ============================================================ */

function h(html) {
  const tpl = document.createElement('template');
  tpl.innerHTML = html.trim();
  return tpl.content.firstChild;
}

function div(className, inner = '') {
  const d = document.createElement('div');
  d.className = className;
  d.innerHTML = inner;
  return d;
}

/* ============================================================
   VIEW: TODAY
   ============================================================ */

function renderToday() {
  const wrap = div('view view-today');
  const now = new Date();
  const greeting = greetingForHour(now.getHours());
  const name = state.settings.name || 'friend';
  const dateStr = humanDate(now);
  const checkin = todayCheckIn();
  const hasRoles = state.roles.length > 0;
  const todayBlocks = blocksForDate(isoDate());

  // Greeting card
  wrap.appendChild(h(`
    <section class="greet-card">
      <div class="weather">${esc(dayPeriod(now.getHours()))}</div>
      <h1>${esc(greeting)}, ${esc(name)}.</h1>
      <div class="greet-date">${esc(dateStr)}</div>
    </section>
  `));

  // Onboarding nudge
  if (!hasRoles) {
    wrap.appendChild(renderOnboard());
  }

  const body = div('today-grid');

  // LEFT column
  const left = div('stack');

  // Check-in card
  if (!checkin) {
    left.appendChild(renderCheckinCard());
  } else {
    left.appendChild(renderCheckinSummary(checkin));
  }

  // Today's schedule
  left.appendChild(renderTodayBlocks(todayBlocks));

  // RIGHT column
  const right = div('stack');
  right.appendChild(renderCapacityCard());
  right.appendChild(renderSleepCard());

  body.appendChild(left);
  body.appendChild(right);
  wrap.appendChild(body);

  // Insights
  const insights = computeInsights();
  if (insights.length) {
    const card = h(`<section class="card"><div class="card-heading"><h2>Signals</h2></div></section>`);
    const stack = div('stack');
    insights.forEach((ins) => {
      stack.appendChild(h(`
        <div class="insight ${esc(ins.level)}">
          <span class="dot"></span>
          <div>
            <div class="insight-title">${esc(ins.title)}</div>
            <div class="insight-body">${esc(ins.body)}</div>
          </div>
        </div>
      `));
    });
    card.appendChild(stack);
    wrap.appendChild(card);
  }

  return wrap;
}

function greetingForHour(h) {
  if (h < 5)  return 'Up late';
  if (h < 12) return 'Good morning';
  if (h < 17) return 'Good afternoon';
  if (h < 21) return 'Good evening';
  return 'Easy there';
}

function dayPeriod(h) {
  if (h < 5)  return 'late night';
  if (h < 12) return 'morning';
  if (h < 17) return 'afternoon';
  if (h < 21) return 'evening';
  return 'night';
}

function renderOnboard() {
  const hasName = !!state.settings.name;
  const hasRoles = state.roles.length > 0;
  const hasBlock = state.blocks.length > 0;
  return h(`
    <section class="onboard">
      <h2>Welcome to Pace.</h2>
      <p>A calm tool for planning time without burning out. Three small steps to set up.</p>
      <div class="row" style="gap:10px">
        <button class="btn btn-primary" data-action="open-settings">Get started</button>
        <button class="btn btn-secondary" data-action="open-role-modal">Add a role</button>
      </div>
      <div class="onboard-steps">
        <div class="onboard-step ${hasName ? 'is-done' : ''}">
          <div class="onboard-step-num">${hasName ? '✓' : '1'}</div> Add your name and sleep window
        </div>
        <div class="onboard-step ${hasRoles ? 'is-done' : ''}">
          <div class="onboard-step-num">${hasRoles ? '✓' : '2'}</div> Add at least one role
        </div>
        <div class="onboard-step ${hasBlock ? 'is-done' : ''}">
          <div class="onboard-step-num">${hasBlock ? '✓' : '3'}</div> Plan a time block for today
        </div>
      </div>
    </section>
  `);
}

function renderCheckinCard() {
  const card = div('card checkin-card');
  card.innerHTML = `
    <div class="card-heading">
      <h2>How is your energy?</h2>
      <span class="hint">30-second check-in</span>
    </div>
    <p style="color:var(--text-muted); font-size:13px;">Pick one. Catches overload before it catches you.</p>
    <div class="checkin-scale" data-role="checkin-scale">
      ${FEELINGS.map((f) => `
        <button class="checkin-option" data-action="quick-checkin" data-energy="${f.value}">
          <span class="checkin-dot">${f.value}</span>
          <strong>${esc(f.label)}</strong>
          <span>${esc(f.hint)}</span>
        </button>
      `).join('')}
    </div>
  `;
  return card;
}

function renderCheckinSummary(c) {
  const feeling = FEELINGS.find((f) => f.value === c.energy) || FEELINGS[2];
  return h(`
    <section class="card">
      <div class="card-heading">
        <h2>Today's check-in</h2>
        <button class="btn btn-sm btn-ghost" data-action="open-checkin-modal">Edit</button>
      </div>
      <div class="row" style="gap:14px">
        <span class="energy-pill energy-${c.energy}">${esc(feeling.label)}</span>
        ${c.sleepHours != null ? `<span class="chip"><span class="dot" style="background:var(--accent)"></span>${c.sleepHours}h sleep</span>` : ''}
      </div>
      ${c.notes ? `<p style="color:var(--text-muted); margin-top:10px; font-size:13px;">${esc(c.notes)}</p>` : ''}
    </section>
  `);
}

function renderTodayBlocks(blocks) {
  const card = div('card');
  card.innerHTML = `
    <div class="card-heading">
      <h2>Today's plan</h2>
      <button class="btn btn-sm btn-secondary" data-action="open-block-modal" data-date="${isoDate()}">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>
        Block
      </button>
    </div>
  `;
  if (blocks.length === 0) {
    card.appendChild(h(`
      <div class="empty-state" style="padding:30px 10px">
        <h3>No blocks yet.</h3>
        <p>Plan focused time so it does not get absorbed by reactive work.</p>
        <button class="btn btn-primary btn-sm" data-action="open-block-modal" data-date="${isoDate()}">Plan a block</button>
      </div>
    `));
  } else {
    const list = div('block-list');
    blocks.forEach((b) => list.appendChild(renderBlockItem(b)));
    card.appendChild(list);
  }
  return card;
}

function renderBlockItem(b) {
  const role = roleById(b.roleId);
  const task = b.taskId ? taskById(b.taskId) : null;
  const color = role?.color || 'var(--text-subtle)';
  const title = b.title || task?.title || role?.name || 'Block';
  return h(`
    <div class="block-item" data-action="open-block-modal" data-id="${esc(b.id)}">
      <div class="time">${esc(formatTime12(b.startTime))}<br>${esc(formatTime12(b.endTime))}</div>
      <div class="swatch" style="background:${esc(color)}"></div>
      <div>
        <div class="title">${esc(title)}</div>
        <div class="subtitle">
          ${role ? `<span class="chip" style="color:${esc(role.color)}"><span class="dot"></span>${esc(role.name)}</span>` : ''}
          ${task ? `<span>· ${esc(task.title)}</span>` : ''}
        </div>
      </div>
      <div class="duration">${esc(formatDuration(blockMinutes(b)))}</div>
    </div>
  `);
}

function renderCapacityCard() {
  const card = div('card');
  const totalBudget = totalWeeklyBudgetMinutes();
  const totalScheduled = totalMinutesScheduledThisWeek();
  const pct = totalBudget ? Math.min(100, (totalScheduled / totalBudget) * 100) : 0;
  const overall = totalScheduled / 60;
  const overloaded = overall > 55;

  card.innerHTML = `
    <div class="card-heading">
      <h2>This week</h2>
      <a href="#/plan" class="hint" style="color:var(--accent)">View plan →</a>
    </div>
    <div class="row spread" style="margin-bottom:14px">
      <div>
        <div style="font-size:24px; font-weight:700; font-family:var(--font-mono)">${overall.toFixed(1)}h</div>
        <div style="font-size:12px; color:var(--text-muted)">scheduled this week</div>
      </div>
      <div style="text-align:right">
        <div style="font-size:13px; font-family:var(--font-mono); color:var(--text-muted)">${Math.round(pct)}% of budget</div>
      </div>
    </div>
    <div class="capacity-bar ${overloaded ? 'overloaded' : ''}"><span style="width:${pct}%"></span></div>
  `;

  if (state.roles.length > 0) {
    const stack = div('capacity-stack');
    stack.style.marginTop = '20px';
    state.roles.forEach((r) => {
      const scheduledMin = minutesScheduledThisWeekByRole(r.id);
      const budgetMin = (r.weeklyHoursBudget || 0) * 60;
      const rPct = budgetMin ? Math.min(100, (scheduledMin / budgetMin) * 100) : 0;
      const over = budgetMin && scheduledMin > budgetMin;
      stack.appendChild(h(`
        <div class="capacity-row">
          <div class="label"><span class="dot" style="background:${esc(r.color)}"></span>${esc(r.name)}</div>
          <div class="capacity-bar ${over ? 'overloaded' : ''}"><span style="width:${rPct}%; background:${esc(r.color)}"></span></div>
          <div class="num">${(scheduledMin / 60).toFixed(1)} / ${r.weeklyHoursBudget || 0}h</div>
        </div>
      `));
    });
    card.appendChild(stack);
  }

  return card;
}

function renderSleepCard() {
  const card = div('card sleep-card');
  const { bedtime, wakeTime } = state.settings;
  const sleepMinutes = calcSleepWindow(bedtime, wakeTime);
  const hours = (sleepMinutes / 60).toFixed(1);

  const now = new Date();
  const nowMin = now.getHours() * 60 + now.getMinutes();
  const bedMin = timeToMinutes(bedtime);
  let countdown = '';
  const diff = bedMin - nowMin;
  if (diff > 0 && diff <= 90) {
    countdown = `<div class="sleep-countdown">Wind down in ${diff} min — sleep by ${formatTime12(bedtime)}.</div>`;
  } else if (diff < 0 && nowMin > bedMin && nowMin < 26 * 60) {
    const mins = Math.abs(diff);
    countdown = `<div class="sleep-countdown past">Past your bedtime by ${mins} min. Rest well.</div>`;
  }

  card.innerHTML = `
    <div class="card-heading">
      <h2>Sleep</h2>
      <a href="#/settings" class="hint">Adjust</a>
    </div>
    <div class="sleep-window">
      <span class="time">${esc(formatTime12(bedtime))}</span>
      <span class="sep">→</span>
      <span class="time">${esc(formatTime12(wakeTime))}</span>
    </div>
    <div class="sleep-meta">${hours}h window. Non-negotiable.</div>
    ${countdown}
  `;
  return card;
}

function calcSleepWindow(bed, wake) {
  let bedM = timeToMinutes(bed);
  let wakeM = timeToMinutes(wake);
  if (wakeM <= bedM) wakeM += 24 * 60;
  return wakeM - bedM;
}

/* ============================================================
   VIEW: PLAN (week calendar)
   ============================================================ */

let planWeekOffset = 0;

function renderPlan() {
  const wrap = div('view view-plan');
  const weekStart = addDays(startOfWeek(new Date(), state.settings.weekStartsMonday), planWeekOffset * 7);
  const weekEnd = addDays(weekStart, 6);
  const days = Array.from({ length: 7 }, (_, i) => addDays(weekStart, i));
  const today = isoDate();

  wrap.appendChild(h(`
    <div class="view-header">
      <div>
        <h1>Plan <small>your week</small></h1>
        <div class="view-subtitle">Click any empty slot to add a block.</div>
      </div>
      <button class="btn btn-primary" data-action="open-block-modal" data-date="${isoDate()}">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>
        New block
      </button>
    </div>
  `));

  const toolbar = h(`
    <div class="week-toolbar">
      <button class="btn btn-icon btn-secondary" data-action="week-prev" aria-label="Previous week">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M15 18l-6-6 6-6"/></svg>
      </button>
      <button class="btn btn-secondary" data-action="week-today">Today</button>
      <button class="btn btn-icon btn-secondary" data-action="week-next" aria-label="Next week">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M9 6l6 6-6 6"/></svg>
      </button>
      <div class="week-range" style="margin-left:8px">${shortDate(weekStart)} — ${shortDate(weekEnd)}</div>
    </div>
  `);
  wrap.appendChild(toolbar);

  const grid = document.createElement('div');
  grid.className = 'week-grid';
  grid.style.gridTemplateRows = `auto repeat(${HOURS}, 40px)`;

  // Header row
  grid.appendChild(div('week-header-cell'));
  days.forEach((d) => {
    const isToday = isoDate(d) === today;
    grid.appendChild(h(`
      <div class="week-header-cell ${isToday ? 'is-today' : ''}">
        ${DAY_NAMES[d.getDay()]}
        <strong>${d.getDate()}</strong>
      </div>
    `));
  });

  // Hour label column
  const hourCol = div('week-hour-col');
  hourCol.style.gridColumn = '1';
  hourCol.style.gridRow = `2 / span ${HOURS}`;
  for (let i = 0; i < HOURS; i++) {
    const hr = HOUR_START + i;
    const label = hr === 12 ? '12p' : hr > 12 ? (hr - 12) + 'p' : hr + 'a';
    hourCol.appendChild(h(`<div class="week-hour-label">${label}</div>`));
  }
  grid.appendChild(hourCol);

  // Day columns
  days.forEach((date, idx) => {
    const dateStr = isoDate(date);
    const col = div('week-day-col');
    col.style.gridColumn = String(idx + 2);
    col.style.gridRow = `2 / span ${HOURS}`;
    col.dataset.date = dateStr;

    // Hour grid lines
    for (let i = 1; i < HOURS; i++) {
      const line = div('hour-line');
      line.style.top = `${i * 40}px`;
      col.appendChild(line);
    }

    // Blocks
    blocksForDate(dateStr).forEach((b) => {
      const role = roleById(b.roleId);
      const startMin = timeToMinutes(b.startTime);
      const endMin = timeToMinutes(b.endTime);
      const top = (startMin - HOUR_START * 60) * PX_PER_MIN;
      const height = Math.max(22, (endMin - startMin) * PX_PER_MIN);
      const color = role?.color || '#60a5fa';
      const task = b.taskId ? taskById(b.taskId) : null;
      const title = b.title || task?.title || role?.name || 'Block';
      const blockEl = h(`
        <div class="week-block"
             data-action="open-block-modal"
             data-id="${esc(b.id)}"
             style="top:${top}px; height:${height}px; background:${hexToRgba(color, 0.18)}; border-left-color:${color}">
          <div class="wb-time">${formatTime12(b.startTime)}</div>
          <div class="wb-title">${esc(title)}</div>
        </div>
      `);
      col.appendChild(blockEl);
    });

    // Now line (if today)
    if (dateStr === today) {
      const now = new Date();
      const nowMin = now.getHours() * 60 + now.getMinutes();
      if (nowMin >= HOUR_START * 60 && nowMin <= HOUR_END * 60) {
        const line = div('now-line');
        line.style.top = `${(nowMin - HOUR_START * 60) * PX_PER_MIN}px`;
        col.appendChild(line);
      }
    }

    // Click to add (computes time from y-position)
    col.addEventListener('click', (e) => {
      if (e.target !== col && !e.target.classList.contains('hour-line')) return;
      const rect = col.getBoundingClientRect();
      const y = e.clientY - rect.top;
      const mins = HOUR_START * 60 + Math.round(y / PX_PER_MIN / 15) * 15;
      const start = minutesToTime(Math.max(HOUR_START * 60, Math.min(HOUR_END * 60 - 30, mins)));
      const end = minutesToTime(timeToMinutes(start) + 60);
      openBlockModal(null, { date: dateStr, startTime: start, endTime: end });
    });

    grid.appendChild(col);
  });

  wrap.appendChild(grid);

  // Summary beneath grid
  const summaryCard = h(`
    <section class="card" style="margin-top:24px">
      <div class="card-heading"><h2>This week</h2></div>
    </section>
  `);
  const stack = div('capacity-stack');
  state.roles.forEach((r) => {
    const scheduledMin = weekScheduledByRole(weekStart, r.id);
    const budgetMin = (r.weeklyHoursBudget || 0) * 60;
    const rPct = budgetMin ? Math.min(100, (scheduledMin / budgetMin) * 100) : 0;
    const over = budgetMin && scheduledMin > budgetMin;
    stack.appendChild(h(`
      <div class="capacity-row">
        <div class="label"><span class="dot" style="background:${esc(r.color)}"></span>${esc(r.name)}</div>
        <div class="capacity-bar ${over ? 'overloaded' : ''}"><span style="width:${rPct}%; background:${esc(r.color)}"></span></div>
        <div class="num">${(scheduledMin / 60).toFixed(1)} / ${r.weeklyHoursBudget || 0}h</div>
      </div>
    `));
  });
  summaryCard.appendChild(stack);
  wrap.appendChild(summaryCard);

  return wrap;
}

function weekScheduledByRole(weekStart, roleId) {
  const end = addDays(weekStart, 7);
  return state.blocks
    .filter((b) => b.roleId === roleId)
    .filter((b) => {
      const d = parseDate(b.date);
      return d >= weekStart && d < end;
    })
    .reduce((s, b) => s + blockMinutes(b), 0);
}

/* ============================================================
   VIEW: TASKS
   ============================================================ */

let taskFilter = { roleId: '', status: 'active' };

function renderTasks() {
  const wrap = div('view view-tasks');
  wrap.appendChild(h(`
    <div class="view-header">
      <div>
        <h1>Tasks</h1>
        <div class="view-subtitle">Capture work with an estimate. Schedule it when you are ready.</div>
      </div>
      <button class="btn btn-primary" data-action="open-task-modal">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>
        New task
      </button>
    </div>
  `));

  // Toolbar
  const toolbar = h(`
    <div class="task-toolbar">
      <select class="input" data-filter="roleId" style="width:auto; min-width:140px">
        <option value="">All roles</option>
        ${state.roles.map((r) => `<option value="${esc(r.id)}" ${taskFilter.roleId === r.id ? 'selected' : ''}>${esc(r.name)}</option>`).join('')}
      </select>
      <select class="input" data-filter="status" style="width:auto">
        <option value="active"${taskFilter.status === 'active' ? ' selected' : ''}>Active</option>
        <option value="done"${taskFilter.status === 'done' ? ' selected' : ''}>Done</option>
        <option value="all"${taskFilter.status === 'all' ? ' selected' : ''}>All</option>
      </select>
      <span class="spacer"></span>
    </div>
  `);
  toolbar.querySelectorAll('[data-filter]').forEach((sel) => {
    sel.addEventListener('change', () => {
      taskFilter[sel.dataset.filter] = sel.value;
      render();
    });
  });
  wrap.appendChild(toolbar);

  let tasks = [...state.tasks];
  if (taskFilter.roleId) tasks = tasks.filter((t) => t.roleId === taskFilter.roleId);
  if (taskFilter.status === 'active') tasks = tasks.filter((t) => t.status !== 'done');
  if (taskFilter.status === 'done') tasks = tasks.filter((t) => t.status === 'done');

  tasks.sort((a, b) => {
    if (a.status !== b.status) return a.status === 'done' ? 1 : -1;
    const pOrder = { high: 0, medium: 1, low: 2 };
    if (pOrder[a.priority] !== pOrder[b.priority]) return pOrder[a.priority] - pOrder[b.priority];
    if (a.dueDate && b.dueDate) return a.dueDate.localeCompare(b.dueDate);
    if (a.dueDate) return -1;
    if (b.dueDate) return 1;
    return b.createdAt.localeCompare(a.createdAt);
  });

  if (tasks.length === 0) {
    wrap.appendChild(h(`
      <div class="empty-state">
        <div class="empty-state-icon">
          <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><path d="M9 11l3 3L22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/></svg>
        </div>
        <h3>No tasks ${taskFilter.status === 'done' ? 'completed yet' : 'yet'}.</h3>
        <p>Small pieces are easier to schedule than giant projects. Add an estimate.</p>
        <button class="btn btn-primary btn-sm" data-action="open-task-modal">Add first task</button>
      </div>
    `));
    return wrap;
  }

  const list = div('task-list');
  tasks.forEach((t) => list.appendChild(renderTaskRow(t)));
  wrap.appendChild(list);
  return wrap;
}

function renderTaskRow(t) {
  const role = roleById(t.roleId);
  const due = t.dueDate ? parseDate(t.dueDate) : null;
  const overdue = due && t.status !== 'done' && due < new Date(isoDate());

  return h(`
    <div class="task-row ${t.status === 'done' ? 'is-done' : ''}" data-id="${esc(t.id)}">
      <button class="task-check" data-action="toggle-task" data-id="${esc(t.id)}" aria-label="Toggle done">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round"><path d="M5 12l5 5 9-10"/></svg>
      </button>
      <span class="priority-dot priority-${esc(t.priority)}"></span>
      <div data-action="open-task-modal" data-id="${esc(t.id)}" style="cursor:pointer">
        <div class="task-title">${esc(t.title)}</div>
        <div class="task-meta">
          ${role ? `<span class="chip" style="color:${esc(role.color)}"><span class="dot"></span>${esc(role.name)}</span>` : ''}
          ${t.estimateMinutes ? `<span>· ${formatDuration(t.estimateMinutes)}</span>` : ''}
          ${t.dueDate ? `<span class="${overdue ? 'energy-1' : ''}" style="${overdue ? 'font-weight:600' : ''}">· Due ${shortDate(parseDate(t.dueDate))}</span>` : ''}
        </div>
      </div>
      <button class="btn btn-sm btn-ghost" data-action="schedule-task" data-id="${esc(t.id)}">Schedule</button>
      <button class="btn btn-sm btn-ghost" data-action="open-task-modal" data-id="${esc(t.id)}" aria-label="Edit">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
      </button>
      <button class="btn btn-sm btn-danger" data-action="delete-task" data-id="${esc(t.id)}" aria-label="Delete">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/></svg>
      </button>
    </div>
  `);
}

/* ============================================================
   VIEW: ROLES
   ============================================================ */

function renderRoles() {
  const wrap = div('view view-roles');
  wrap.appendChild(h(`
    <div class="view-header">
      <div>
        <h1>Roles</h1>
        <div class="view-subtitle">A role is a bucket of commitments with a weekly hour budget.</div>
      </div>
      <button class="btn btn-primary" data-action="open-role-modal">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>
        New role
      </button>
    </div>
  `));

  if (state.roles.length === 0) {
    wrap.appendChild(h(`
      <div class="empty-state">
        <div class="empty-state-icon">
          <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><circle cx="12" cy="8" r="4"/><path d="M4 21c0-4 4-6 8-6s8 2 8 6"/></svg>
        </div>
        <h3>No roles yet.</h3>
        <p>Start with the big ones: internship work, courses, personal. Each with a rough weekly hour target.</p>
        <button class="btn btn-primary btn-sm" data-action="open-role-modal">Add your first role</button>
      </div>
    `));
    return wrap;
  }

  const grid = div('grid grid-auto');
  state.roles.forEach((r) => {
    const scheduled = minutesScheduledThisWeekByRole(r.id) / 60;
    const budget = r.weeklyHoursBudget || 0;
    const tasksCount = state.tasks.filter((t) => t.roleId === r.id && t.status !== 'done').length;
    const over = budget && scheduled > budget;
    grid.appendChild(h(`
      <article class="role-card" data-action="open-role-modal" data-id="${esc(r.id)}">
        <div class="role-card-head">
          <div class="role-card-name"><span class="role-color" style="background:${esc(r.color)}"></span>${esc(r.name)}</div>
          <div class="role-budget">${budget}h / wk</div>
        </div>
        ${budget ? `<div class="capacity-bar ${over ? 'overloaded' : ''}"><span style="width:${Math.min(100, (scheduled / budget) * 100)}%; background:${esc(r.color)}"></span></div>` : ''}
        <div class="role-stat">
          <span>${scheduled.toFixed(1)}h this week</span>
          <span>${tasksCount} open task${tasksCount === 1 ? '' : 's'}</span>
        </div>
      </article>
    `));
  });
  wrap.appendChild(grid);
  return wrap;
}

/* ============================================================
   VIEW: REFLECT
   ============================================================ */

function renderReflect() {
  const wrap = div('view view-reflect');
  wrap.appendChild(h(`
    <div class="view-header">
      <div>
        <h1>Reflect</h1>
        <div class="view-subtitle">Patterns only show up when you track. Two weeks is a good lens.</div>
      </div>
      <div class="row" style="gap:8px">
        ${!todayCheckIn() ? `<button class="btn btn-primary" data-action="open-checkin-modal">Log today</button>` : ''}
        <button class="btn btn-secondary" data-action="open-snapshot">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 12v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8"/><polyline points="16 6 12 2 8 6"/><line x1="12" y1="2" x2="12" y2="15"/></svg>
          Share snapshot
        </button>
      </div>
    </div>
  `));

  const recent = recentCheckIns(14);

  if (recent.length === 0) {
    wrap.appendChild(h(`
      <div class="empty-state">
        <div class="empty-state-icon">
          <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><path d="M3 12c3-7 15-7 18 0"/><circle cx="12" cy="12" r="3"/></svg>
        </div>
        <h3>Nothing to reflect on yet.</h3>
        <p>Energy check-ins take 10 seconds. Patterns emerge after a week.</p>
        <button class="btn btn-primary btn-sm" data-action="open-checkin-modal">First check-in</button>
      </div>
    `));
    return wrap;
  }

  // Charts row
  const chartRow = div('grid grid-2');

  // Energy chart
  const energyCard = div('card');
  energyCard.innerHTML = `<div class="card-heading"><h2>Energy, last 14 days</h2></div>`;
  energyCard.appendChild(buildEnergyChart(recent));
  chartRow.appendChild(energyCard);

  // Sleep chart
  const sleepCard = div('card');
  sleepCard.innerHTML = `<div class="card-heading"><h2>Sleep, last 14 days</h2></div>`;
  sleepCard.appendChild(buildSleepChart(recent));
  chartRow.appendChild(sleepCard);

  wrap.appendChild(chartRow);

  // Insights
  const insights = computeInsights();
  if (insights.length) {
    const card = div('card');
    card.style.marginTop = '20px';
    card.innerHTML = `<div class="card-heading"><h2>Signals</h2></div>`;
    const stack = div('stack');
    insights.forEach((ins) => {
      stack.appendChild(h(`
        <div class="insight ${esc(ins.level)}">
          <span class="dot"></span>
          <div>
            <div class="insight-title">${esc(ins.title)}</div>
            <div class="insight-body">${esc(ins.body)}</div>
          </div>
        </div>
      `));
    });
    card.appendChild(stack);
    wrap.appendChild(card);
  }

  // Log list
  const logCard = div('card');
  logCard.style.marginTop = '20px';
  logCard.innerHTML = `<div class="card-heading"><h2>Check-in log</h2></div>`;
  const stack = div('stack');
  recent.slice().reverse().forEach((c) => {
    const feeling = FEELINGS.find((f) => f.value === c.energy) || FEELINGS[2];
    stack.appendChild(h(`
      <div class="log-item">
        <div class="date">${shortDate(parseDate(c.date))}</div>
        <div>
          <div class="row" style="gap:10px; margin-bottom:4px">
            <span class="energy-pill energy-${c.energy}">${esc(feeling.label)}</span>
            ${c.sleepHours != null ? `<span class="chip">${c.sleepHours}h sleep</span>` : ''}
          </div>
          ${c.notes ? `<div style="color:var(--text-muted); font-size:13px">${esc(c.notes)}</div>` : ''}
        </div>
        <button class="btn btn-sm btn-ghost" data-action="delete-checkin" data-id="${esc(c.id)}" aria-label="Delete entry">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M18 6L6 18M6 6l12 12"/></svg>
        </button>
      </div>
    `));
  });
  logCard.appendChild(stack);
  wrap.appendChild(logCard);

  return wrap;
}

function buildEnergyChart(data) {
  const W = 560, H = 180, P = 30;
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  svg.setAttribute('class', 'chart');

  const days = 14;
  const today = new Date(isoDate());
  const points = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = addDays(today, -i);
    const ds = isoDate(d);
    const c = data.find((ci) => ci.date === ds);
    const x = P + ((days - 1 - i) / (days - 1)) * (W - P * 2);
    const y = c ? (H - P) - ((c.energy - 1) / 4) * (H - P * 2) : null;
    points.push({ x, y, c });
  }

  // Axis
  for (let i = 1; i <= 5; i++) {
    const y = (H - P) - ((i - 1) / 4) * (H - P * 2);
    const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
    line.setAttribute('x1', P);
    line.setAttribute('x2', W - P);
    line.setAttribute('y1', y);
    line.setAttribute('y2', y);
    line.setAttribute('class', 'chart-axis');
    line.setAttribute('stroke-dasharray', '2 4');
    line.setAttribute('opacity', '0.3');
    svg.appendChild(line);

    const lbl = document.createElementNS('http://www.w3.org/2000/svg', 'text');
    lbl.setAttribute('x', 10);
    lbl.setAttribute('y', y + 3);
    lbl.setAttribute('class', 'chart-label');
    lbl.textContent = i;
    svg.appendChild(lbl);
  }

  const withPoints = points.filter((p) => p.y != null);
  if (withPoints.length > 1) {
    const pathD = withPoints.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x},${p.y}`).join(' ');
    const areaD = `${pathD} L${withPoints[withPoints.length - 1].x},${H - P} L${withPoints[0].x},${H - P} Z`;
    const area = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    area.setAttribute('d', areaD);
    area.setAttribute('class', 'chart-area');
    svg.appendChild(area);

    const line = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    line.setAttribute('d', pathD);
    line.setAttribute('class', 'chart-line');
    svg.appendChild(line);
  }

  withPoints.forEach((p) => {
    const dot = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    dot.setAttribute('cx', p.x);
    dot.setAttribute('cy', p.y);
    dot.setAttribute('r', 3);
    dot.setAttribute('class', 'chart-dot');
    svg.appendChild(dot);
  });

  return svg;
}

function buildSleepChart(data) {
  const W = 560, H = 180, P = 30;
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  svg.setAttribute('class', 'chart');

  const days = 14;
  const today = new Date(isoDate());
  const barWidth = (W - P * 2) / days - 4;
  const maxHrs = 10;

  // Axis lines
  for (const t of [0, 4, 6, 8, 10]) {
    const y = (H - P) - (t / maxHrs) * (H - P * 2);
    const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
    line.setAttribute('x1', P); line.setAttribute('x2', W - P);
    line.setAttribute('y1', y); line.setAttribute('y2', y);
    line.setAttribute('class', 'chart-axis');
    line.setAttribute('stroke-dasharray', '2 4');
    line.setAttribute('opacity', '0.3');
    svg.appendChild(line);
    if (t > 0) {
      const lbl = document.createElementNS('http://www.w3.org/2000/svg', 'text');
      lbl.setAttribute('x', 10); lbl.setAttribute('y', y + 3);
      lbl.setAttribute('class', 'chart-label');
      lbl.textContent = t + 'h';
      svg.appendChild(lbl);
    }
  }

  for (let i = 0; i < days; i++) {
    const d = addDays(today, -(days - 1 - i));
    const ds = isoDate(d);
    const c = data.find((ci) => ci.date === ds);
    const hours = c?.sleepHours;
    if (hours == null) continue;
    const x = P + i * ((W - P * 2) / days);
    const h = (hours / maxHrs) * (H - P * 2);
    const y = (H - P) - h;
    const bar = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
    bar.setAttribute('x', x);
    bar.setAttribute('y', y);
    bar.setAttribute('width', barWidth);
    bar.setAttribute('height', h);
    bar.setAttribute('class', 'chart-bar');
    bar.setAttribute('rx', 2);
    if (hours < 6) bar.setAttribute('fill', 'var(--danger)');
    else if (hours < 7) bar.setAttribute('fill', 'var(--warn)');
    else bar.setAttribute('fill', 'var(--success)');
    svg.appendChild(bar);
  }

  return svg;
}

/* ============================================================
   VIEW: SETTINGS
   ============================================================ */

function renderSettings() {
  const wrap = div('view view-settings');
  const s = state.settings;
  wrap.appendChild(h(`
    <div class="view-header">
      <div>
        <h1>Settings</h1>
        <div class="view-subtitle">Set the guardrails once; the app enforces them.</div>
      </div>
    </div>
  `));

  // Profile
  const profile = h(`
    <section class="card settings-section">
      <h2>Profile</h2>
      <div class="stack">
        <div class="field">
          <label>Name</label>
          <input class="input" data-set="name" type="text" value="${esc(s.name)}" placeholder="e.g. Tshego" />
        </div>
      </div>
    </section>
  `);
  wrap.appendChild(profile);

  // Sleep
  const sleep = h(`
    <section class="card settings-section">
      <h2>Sleep window</h2>
      <p style="color:var(--text-muted); font-size:13px; margin-bottom:14px">Protected hours the planner will remind you about. Sleep is not negotiable — it compounds into everything else.</p>
      <div class="field-inline">
        <div class="field">
          <label>Bedtime</label>
          <input class="input" data-set="bedtime" type="time" value="${esc(s.bedtime)}" />
        </div>
        <div class="field">
          <label>Wake time</label>
          <input class="input" data-set="wakeTime" type="time" value="${esc(s.wakeTime)}" />
        </div>
      </div>
      <div class="hint" style="margin-top:10px; color:var(--text-subtle)">
        Window: ${(calcSleepWindow(s.bedtime, s.wakeTime) / 60).toFixed(1)} hours
      </div>
    </section>
  `);
  wrap.appendChild(sleep);

  // Appearance
  const appearance = h(`
    <section class="card settings-section">
      <h2>Appearance</h2>
      <div class="stack">
        <div class="field">
          <label>Theme</label>
          <select class="input" data-set="theme">
            <option value="dark" ${s.theme === 'dark' ? 'selected' : ''}>Dark</option>
            <option value="light" ${s.theme === 'light' ? 'selected' : ''}>Light</option>
          </select>
        </div>
        <div class="field">
          <label>Week starts on</label>
          <select class="input" data-set="weekStartsMonday">
            <option value="true" ${s.weekStartsMonday ? 'selected' : ''}>Monday</option>
            <option value="false" ${!s.weekStartsMonday ? 'selected' : ''}>Sunday</option>
          </select>
        </div>
      </div>
    </section>
  `);
  wrap.appendChild(appearance);

  // Data — full backup (private, portable, for moving between devices)
  const lastExp = state.lastExportedAt
    ? `Last exported ${snapshotRelativeTime(state.lastExportedAt)}`
    : 'Never exported';
  const data = h(`
    <section class="card settings-section">
      <h2>Back up &amp; move data</h2>
      <p style="color:var(--text-muted); font-size:13px; margin-bottom:6px">
        Your full planner lives in this browser only. There is no cloud account, nothing is sent anywhere automatically. Export a JSON file to move to another device, back up, or recover after a browser reset.
      </p>
      <div class="hint" style="font-size:12px; color:var(--text-subtle); margin-bottom:14px">${esc(lastExp)}</div>
      <div class="row">
        <button class="btn btn-primary" data-action="export-data">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
          Export JSON
        </button>
        <button class="btn btn-secondary" data-action="import-data">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>
          Import JSON
        </button>
        <button class="btn btn-danger" data-action="reset-data" style="margin-left:auto">Reset everything</button>
      </div>
    </section>
  `);
  wrap.appendChild(data);

  // Snapshot — mentor-safe share
  const snap = h(`
    <section class="card settings-section">
      <h2>Share a snapshot</h2>
      <p style="color:var(--text-muted); font-size:13px; margin-bottom:14px">
        Export an image with totals and trends — no notes, no task titles, no specific check-in text. Safe to send a mentor or coach who just wants to see how the week looks, without reading your journal.
      </p>
      <div class="row">
        <button class="btn btn-primary" data-action="open-snapshot">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/><circle cx="12" cy="13" r="4"/></svg>
          Generate snapshot
        </button>
      </div>
    </section>
  `);
  wrap.appendChild(snap);

  // Wire live inputs
  wrap.querySelectorAll('[data-set]').forEach((inp) => {
    inp.addEventListener('change', () => {
      const key = inp.dataset.set;
      let value = inp.value;
      if (key === 'weekStartsMonday') value = value === 'true';
      setState((st) => ({ ...st, settings: { ...st.settings, [key]: value } }), { rerender: false });
      if (key === 'theme') applyTheme();
      if (key === 'bedtime' || key === 'wakeTime') {
        wrap.querySelector('.view-settings .hint');
      }
      toast('Saved', 'success');
      render();
    });
  });

  return wrap;
}

function applyTheme() {
  document.documentElement.setAttribute('data-theme', state.settings.theme);
}

/* ============================================================
   MODALS
   ============================================================ */

function openModal({ title, body, footer, onMount, size }) {
  closeModal();
  const root = document.getElementById('modal-root');
  const backdrop = h(`<div class="modal-backdrop" data-modal-backdrop></div>`);
  const modal = h(`<div class="modal" role="dialog" aria-modal="true" style="${size === 'lg' ? 'max-width:640px' : ''}">
    <div class="modal-header">
      <div class="modal-title">${esc(title)}</div>
      <button class="btn btn-icon btn-ghost" data-action="close-modal" aria-label="Close">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M18 6L6 18M6 6l12 12"/></svg>
      </button>
    </div>
    <div class="modal-body"></div>
    ${footer ? `<div class="modal-footer">${footer}</div>` : ''}
  </div>`);
  backdrop.appendChild(modal);
  if (typeof body === 'string') modal.querySelector('.modal-body').innerHTML = body;
  else if (body) modal.querySelector('.modal-body').appendChild(body);
  root.appendChild(backdrop);
  backdrop.addEventListener('click', (e) => {
    if (e.target === backdrop) closeModal();
  });
  document.addEventListener('keydown', onEscClose);
  if (onMount) onMount(modal);
  // focus first focusable
  const firstInput = modal.querySelector('input, select, textarea, button:not([data-action="close-modal"])');
  if (firstInput) firstInput.focus();
}

function onEscClose(e) {
  if (e.key === 'Escape') closeModal();
}

function closeModal() {
  const root = document.getElementById('modal-root');
  const backdrop = root.querySelector('.modal-backdrop');
  if (!backdrop) return;
  backdrop.classList.add('closing');
  document.removeEventListener('keydown', onEscClose);
  setTimeout(() => { root.innerHTML = ''; }, 160);
}

/* ---------- Role modal ---------- */

function openRoleModal(id = null) {
  const editing = id ? roleById(id) : null;
  const role = editing || { name: '', color: ROLE_COLORS[state.roles.length % ROLE_COLORS.length], weeklyHoursBudget: 10, notes: '' };

  const body = h(`
    <form data-form="role" class="stack">
      <div class="field">
        <label>Name</label>
        <input class="input" name="name" type="text" value="${esc(role.name)}" placeholder="e.g. Internship work, React course" required maxlength="60" />
      </div>
      <div class="field">
        <label>Weekly hour budget</label>
        <input class="input" name="weeklyHoursBudget" type="number" min="0" max="100" step="0.5" value="${role.weeklyHoursBudget}" />
        <span class="hint">A rough target. Going over is a signal, not a crime.</span>
      </div>
      <div class="field">
        <label>Color</label>
        <div class="color-grid">
          ${ROLE_COLORS.map((c) => `<div class="color-swatch ${c === role.color ? 'is-selected' : ''}" style="background:${c}" data-pick-color="${c}"></div>`).join('')}
        </div>
      </div>
      <div class="field">
        <label>Notes (optional)</label>
        <textarea class="input" name="notes" rows="2">${esc(role.notes || '')}</textarea>
      </div>
    </form>
  `);

  const footer = `
    ${editing ? `<button class="btn btn-danger" data-action="delete-role" data-id="${esc(id)}">Delete</button><div style="flex:1"></div>` : ''}
    <button class="btn btn-ghost" data-action="close-modal">Cancel</button>
    <button class="btn btn-primary" data-action="save-role" data-id="${esc(id || '')}">${editing ? 'Save' : 'Add role'}</button>
  `;

  openModal({ title: editing ? 'Edit role' : 'New role', body, footer, onMount(m) {
    m.querySelectorAll('[data-pick-color]').forEach((sw) => {
      sw.addEventListener('click', () => {
        m.querySelectorAll('[data-pick-color]').forEach((s) => s.classList.toggle('is-selected', s === sw));
      });
    });
  }});
}

function saveRoleFromModal(id) {
  const modal = document.querySelector('.modal');
  const form = modal.querySelector('[data-form="role"]');
  const name = form.name.value.trim();
  if (!name) { toast('Name is required', 'error'); return; }
  const color = modal.querySelector('[data-pick-color].is-selected')?.dataset.pickColor || ROLE_COLORS[0];
  const weeklyHoursBudget = Number(form.weeklyHoursBudget.value) || 0;
  const notes = form.notes.value.trim();

  if (id) {
    setState((st) => ({
      ...st,
      roles: st.roles.map((r) => r.id === id ? { ...r, name, color, weeklyHoursBudget, notes } : r),
    }));
    toast('Role updated', 'success');
  } else {
    const newRole = { id: uid(), name, color, weeklyHoursBudget, notes };
    setState((st) => ({ ...st, roles: [...st.roles, newRole] }));
    toast('Role added', 'success');
  }
  closeModal();
}

function deleteRoleAction(id) {
  const role = roleById(id);
  if (!role) return;
  const taskCount = state.tasks.filter((t) => t.roleId === id).length;
  const blockCount = state.blocks.filter((b) => b.roleId === id).length;
  const msg = `Delete "${role.name}"?\n\n` +
    (taskCount || blockCount
      ? `This will also delete ${taskCount} task${taskCount === 1 ? '' : 's'} and ${blockCount} scheduled block${blockCount === 1 ? '' : 's'}.`
      : 'No tasks or blocks will be affected.');
  if (!confirm(msg)) return;
  setState((st) => ({
    ...st,
    roles: st.roles.filter((r) => r.id !== id),
    tasks: st.tasks.filter((t) => t.roleId !== id),
    blocks: st.blocks.filter((b) => b.roleId !== id),
  }));
  closeModal();
  toast('Role deleted');
}

/* ---------- Task modal ---------- */

function openTaskModal(id = null, defaults = {}) {
  if (state.roles.length === 0) {
    toast('Add a role first', 'error');
    openRoleModal();
    return;
  }
  const editing = id ? taskById(id) : null;
  const task = editing || {
    roleId: defaults.roleId || state.roles[0].id,
    title: '',
    estimateMinutes: 60,
    priority: 'medium',
    dueDate: '',
    status: 'todo',
    notes: '',
  };

  const body = h(`
    <form data-form="task" class="stack">
      <div class="field">
        <label>Task</label>
        <input class="input" name="title" type="text" value="${esc(task.title)}" placeholder="e.g. Finish React module 3" required maxlength="120" />
      </div>
      <div class="field-inline">
        <div class="field">
          <label>Role</label>
          <select class="input" name="roleId">
            ${state.roles.map((r) => `<option value="${esc(r.id)}" ${task.roleId === r.id ? 'selected' : ''}>${esc(r.name)}</option>`).join('')}
          </select>
        </div>
        <div class="field">
          <label>Priority</label>
          <select class="input" name="priority">
            ${PRIORITIES.map((p) => `<option value="${p.value}" ${task.priority === p.value ? 'selected' : ''}>${p.label}</option>`).join('')}
          </select>
        </div>
      </div>
      <div class="field-inline">
        <div class="field">
          <label>Estimate (minutes)</label>
          <input class="input" name="estimateMinutes" type="number" min="0" step="15" value="${task.estimateMinutes || 0}" />
        </div>
        <div class="field">
          <label>Due date (optional)</label>
          <input class="input" name="dueDate" type="date" value="${esc(task.dueDate || '')}" />
        </div>
      </div>
      <div class="field">
        <label>Notes</label>
        <textarea class="input" name="notes" rows="2">${esc(task.notes || '')}</textarea>
      </div>
    </form>
  `);

  const footer = `
    ${editing ? `<button class="btn btn-danger" data-action="delete-task" data-id="${esc(id)}">Delete</button><div style="flex:1"></div>` : ''}
    <button class="btn btn-ghost" data-action="close-modal">Cancel</button>
    <button class="btn btn-primary" data-action="save-task" data-id="${esc(id || '')}">${editing ? 'Save' : 'Add task'}</button>
  `;

  openModal({ title: editing ? 'Edit task' : 'New task', body, footer });
}

function saveTaskFromModal(id) {
  const form = document.querySelector('[data-form="task"]');
  const title = form.title.value.trim();
  if (!title) { toast('Title is required', 'error'); return; }
  const base = {
    title,
    roleId: form.roleId.value,
    priority: form.priority.value,
    estimateMinutes: Number(form.estimateMinutes.value) || 0,
    dueDate: form.dueDate.value || '',
    notes: form.notes.value.trim(),
  };
  if (id) {
    setState((st) => ({ ...st, tasks: st.tasks.map((t) => t.id === id ? { ...t, ...base } : t) }));
    toast('Task saved', 'success');
  } else {
    const newTask = { id: uid(), ...base, status: 'todo', createdAt: new Date().toISOString() };
    setState((st) => ({ ...st, tasks: [...st.tasks, newTask] }));
    toast('Task added', 'success');
  }
  closeModal();
}

function deleteTaskAction(id) {
  if (!confirm('Delete this task?')) return;
  setState((st) => ({
    ...st,
    tasks: st.tasks.filter((t) => t.id !== id),
    blocks: st.blocks.map((b) => b.taskId === id ? { ...b, taskId: null } : b),
  }));
  closeModal();
  toast('Task deleted');
}

function toggleTaskAction(id) {
  setState((st) => ({
    ...st,
    tasks: st.tasks.map((t) => t.id === id
      ? { ...t, status: t.status === 'done' ? 'todo' : 'done', completedAt: t.status === 'done' ? null : new Date().toISOString() }
      : t),
  }));
}

/* ---------- Block modal ---------- */

function openBlockModal(id = null, defaults = {}) {
  if (state.roles.length === 0) {
    toast('Add a role first', 'error');
    openRoleModal();
    return;
  }
  const editing = id ? state.blocks.find((b) => b.id === id) : null;
  const block = editing || {
    roleId: defaults.roleId || state.roles[0].id,
    taskId: defaults.taskId || null,
    date: defaults.date || isoDate(),
    startTime: defaults.startTime || '09:00',
    endTime: defaults.endTime || '10:00',
    title: defaults.title || '',
    notes: '',
  };

  const taskOptions = state.tasks
    .filter((t) => t.status !== 'done')
    .map((t) => `<option value="${esc(t.id)}" ${block.taskId === t.id ? 'selected' : ''}>${esc(t.title)}</option>`)
    .join('');

  const body = h(`
    <form data-form="block" class="stack">
      <div class="field">
        <label>Title (optional)</label>
        <input class="input" name="title" type="text" value="${esc(block.title)}" placeholder="Leave blank to use task or role name" maxlength="120" />
      </div>
      <div class="field-inline">
        <div class="field">
          <label>Role</label>
          <select class="input" name="roleId">
            ${state.roles.map((r) => `<option value="${esc(r.id)}" ${block.roleId === r.id ? 'selected' : ''}>${esc(r.name)}</option>`).join('')}
          </select>
        </div>
        <div class="field">
          <label>Task (optional)</label>
          <select class="input" name="taskId">
            <option value="">— None —</option>
            ${taskOptions}
          </select>
        </div>
      </div>
      <div class="field">
        <label>Date</label>
        <input class="input" name="date" type="date" value="${esc(block.date)}" required />
      </div>
      <div class="field-inline">
        <div class="field">
          <label>Start</label>
          <input class="input" name="startTime" type="time" value="${esc(block.startTime)}" required />
        </div>
        <div class="field">
          <label>End</label>
          <input class="input" name="endTime" type="time" value="${esc(block.endTime)}" required />
        </div>
      </div>
      <div class="field">
        <label>Notes</label>
        <textarea class="input" name="notes" rows="2">${esc(block.notes || '')}</textarea>
      </div>
    </form>
  `);

  const footer = `
    ${editing ? `<button class="btn btn-danger" data-action="delete-block" data-id="${esc(id)}">Delete</button><div style="flex:1"></div>` : ''}
    <button class="btn btn-ghost" data-action="close-modal">Cancel</button>
    <button class="btn btn-primary" data-action="save-block" data-id="${esc(id || '')}">${editing ? 'Save' : 'Add block'}</button>
  `;

  openModal({ title: editing ? 'Edit block' : 'New block', body, footer });
}

function saveBlockFromModal(id) {
  const form = document.querySelector('[data-form="block"]');
  const start = form.startTime.value;
  const end = form.endTime.value;
  if (timeToMinutes(end) <= timeToMinutes(start)) {
    toast('End time must be after start', 'error');
    return;
  }
  const base = {
    roleId: form.roleId.value,
    taskId: form.taskId.value || null,
    date: form.date.value,
    startTime: start,
    endTime: end,
    title: form.title.value.trim(),
    notes: form.notes.value.trim(),
  };
  if (id) {
    setState((st) => ({ ...st, blocks: st.blocks.map((b) => b.id === id ? { ...b, ...base } : b) }));
    toast('Block updated', 'success');
  } else {
    const newBlock = { id: uid(), ...base };
    setState((st) => ({ ...st, blocks: [...st.blocks, newBlock] }));
    toast('Block added', 'success');
  }
  closeModal();
}

function deleteBlockAction(id) {
  if (!confirm('Delete this block?')) return;
  setState((st) => ({ ...st, blocks: st.blocks.filter((b) => b.id !== id) }));
  closeModal();
  toast('Block deleted');
}

function scheduleTaskAction(taskId) {
  const t = taskById(taskId);
  if (!t) return;
  const start = '09:00';
  const end = minutesToTime(timeToMinutes(start) + (t.estimateMinutes || 60));
  openBlockModal(null, {
    roleId: t.roleId,
    taskId: t.id,
    title: t.title,
    date: isoDate(),
    startTime: start,
    endTime: end,
  });
}

/* ---------- Check-in modal ---------- */

function openCheckInModal() {
  const existing = todayCheckIn();
  const c = existing || { energy: 3, sleepHours: 7, notes: '' };

  const body = h(`
    <form data-form="checkin" class="stack">
      <div class="field">
        <label>Energy today</label>
        <div class="checkin-scale" data-role="checkin-scale-modal">
          ${FEELINGS.map((f) => `
            <button type="button" class="checkin-option ${c.energy === f.value ? 'is-selected' : ''}" data-energy="${f.value}">
              <span class="checkin-dot">${f.value}</span>
              <strong>${esc(f.label)}</strong>
              <span>${esc(f.hint)}</span>
            </button>
          `).join('')}
        </div>
      </div>
      <div class="field">
        <label>Sleep last night (hours)</label>
        <input class="input" name="sleepHours" type="number" min="0" max="14" step="0.5" value="${c.sleepHours ?? 7}" />
      </div>
      <div class="field">
        <label>Anything on your mind?</label>
        <textarea class="input" name="notes" rows="3" placeholder="One line is enough. What's heavy? What's helping?">${esc(c.notes || '')}</textarea>
      </div>
    </form>
  `);

  const footer = `
    ${existing ? `<button class="btn btn-danger" data-action="delete-checkin" data-id="${esc(existing.id)}">Delete</button><div style="flex:1"></div>` : ''}
    <button class="btn btn-ghost" data-action="close-modal">Cancel</button>
    <button class="btn btn-primary" data-action="save-checkin">${existing ? 'Save' : 'Log check-in'}</button>
  `;

  openModal({ title: existing ? 'Edit check-in' : 'Daily check-in', body, footer, onMount(m) {
    let selected = c.energy;
    m.querySelectorAll('[data-energy]').forEach((btn) => {
      btn.addEventListener('click', () => {
        selected = Number(btn.dataset.energy);
        m.querySelectorAll('[data-energy]').forEach((b) => b.classList.toggle('is-selected', b === btn));
      });
    });
    m._energy = () => selected;
  }});
}

function saveCheckInFromModal() {
  const modal = document.querySelector('.modal');
  const form = modal.querySelector('[data-form="checkin"]');
  const energy = modal._energy ? modal._energy() : Number(modal.querySelector('[data-energy].is-selected')?.dataset.energy) || 3;
  const sleepHours = form.sleepHours.value ? Number(form.sleepHours.value) : null;
  const notes = form.notes.value.trim();
  const today = isoDate();
  const existing = todayCheckIn();

  if (existing) {
    setState((st) => ({
      ...st,
      checkIns: st.checkIns.map((c) => c.id === existing.id ? { ...c, energy, sleepHours, notes } : c),
    }));
  } else {
    const c = { id: uid(), date: today, energy, sleepHours, notes, createdAt: new Date().toISOString() };
    setState((st) => ({ ...st, checkIns: [...st.checkIns, c] }));
  }
  toast('Check-in saved', 'success');
  closeModal();
}

function deleteCheckInAction(id) {
  if (!confirm('Delete this check-in?')) return;
  setState((st) => ({ ...st, checkIns: st.checkIns.filter((c) => c.id !== id) }));
  closeModal();
  toast('Check-in removed');
}

function quickCheckInAction(energy) {
  const today = isoDate();
  const existing = todayCheckIn();
  if (existing) {
    setState((st) => ({
      ...st,
      checkIns: st.checkIns.map((c) => c.id === existing.id ? { ...c, energy } : c),
    }));
  } else {
    const c = { id: uid(), date: today, energy, sleepHours: null, notes: '', createdAt: new Date().toISOString() };
    setState((st) => ({ ...st, checkIns: [...st.checkIns, c] }));
  }
  toast('Logged — ' + FEELINGS.find((f) => f.value === energy).label, 'success');
}

/* ============================================================
   DATA EXPORT / IMPORT
   ============================================================ */

function exportData() {
  const payload = { ...state, exportedAt: new Date().toISOString() };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `pace-export-${isoDate()}.json`;
  a.click();
  URL.revokeObjectURL(url);
  setState((st) => ({ ...st, lastExportedAt: Date.now() }), { rerender: false });
  if (currentView() === 'settings') render();
  toast('Exported');
}

function importData() {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'application/json';
  input.addEventListener('change', () => {
    const file = input.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const data = JSON.parse(reader.result);
        if (!data.version) throw new Error('Not a Pace export.');
        if (!confirm('This will replace your current data. Continue?')) return;
        setState(data);
        toast('Imported', 'success');
      } catch (e) {
        toast('Import failed: ' + e.message, 'error');
      }
    };
    reader.readAsText(file);
  });
  input.click();
}

function resetData() {
  if (!confirm('This erases all roles, tasks, blocks, and check-ins. Are you sure?')) return;
  state = structuredClone(DEFAULT_STATE);
  // Clear both backing stores.
  idbSet('state', state).catch(() => {});
  try { localStorage.removeItem(STORAGE_KEY); } catch {}
  applyTheme();
  location.hash = '#/today';
  render();
  toast('Reset complete');
}

/* ============================================================
   EVENT DELEGATION
   ============================================================ */

document.addEventListener('submit', (e) => {
  e.preventDefault();
  const form = e.target;
  const save = {
    role:    () => saveRoleFromModal(document.querySelector('[data-action="save-role"]')?.dataset.id || null),
    task:    () => saveTaskFromModal(document.querySelector('[data-action="save-task"]')?.dataset.id || null),
    block:   () => saveBlockFromModal(document.querySelector('[data-action="save-block"]')?.dataset.id || null),
    checkin: () => saveCheckInFromModal(),
  }[form.dataset.form];
  if (save) save();
});

document.addEventListener('click', (e) => {
  const target = e.target.closest('[data-action]');
  if (!target) return;
  const action = target.dataset.action;
  const id = target.dataset.id || null;

  switch (action) {
    case 'close-modal': closeModal(); break;
    case 'open-role-modal': openRoleModal(id); break;
    case 'save-role': saveRoleFromModal(id); break;
    case 'delete-role': deleteRoleAction(id); break;

    case 'open-task-modal': openTaskModal(id); break;
    case 'save-task': saveTaskFromModal(id); break;
    case 'delete-task': deleteTaskAction(id); break;
    case 'toggle-task': toggleTaskAction(id); break;
    case 'schedule-task': scheduleTaskAction(id); break;

    case 'open-block-modal': openBlockModal(id, { date: target.dataset.date }); break;
    case 'save-block': saveBlockFromModal(id); break;
    case 'delete-block': deleteBlockAction(id); break;

    case 'open-checkin-modal': openCheckInModal(); break;
    case 'save-checkin': saveCheckInFromModal(); break;
    case 'delete-checkin': deleteCheckInAction(id); break;
    case 'quick-checkin': {
      const energy = Number(target.dataset.energy);
      quickCheckInAction(energy);
      break;
    }

    case 'open-settings': location.hash = '#/settings'; break;

    case 'week-prev': planWeekOffset -= 1; render(); break;
    case 'week-next': planWeekOffset += 1; render(); break;
    case 'week-today': planWeekOffset = 0; render(); break;

    case 'export-data': exportData(); break;
    case 'import-data': importData(); break;
    case 'reset-data': resetData(); break;

    case 'open-snapshot': openSnapshotModal(); break;
    case 'snapshot-download': snapshotDownload(); break;
    case 'snapshot-share': snapshotShare(); break;
  }
});

/* ============================================================
   INIT
   ============================================================ */

async function init() {
  await loadStateAsync();
  applyTheme();

  // Ask the browser not to evict our IDB under storage pressure.
  // Installed PWAs are usually granted silently; browsers may prompt otherwise.
  if (navigator.storage && navigator.storage.persist) {
    navigator.storage.persist().catch(() => {});
  }

  window.addEventListener('hashchange', render);
  if (!location.hash) location.hash = '#/today';
  render();

  // Re-render the "now line" each minute while the Plan view is open,
  // and refresh sleep countdown on Today.
  setInterval(() => {
    const hash = currentView();
    if (hash === 'plan' || hash === 'today') render();
  }, 60_000);

  // Register service worker for offline/installable PWA behavior.
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('./sw.js').catch((err) => {
        console.warn('SW registration failed:', err);
      });
    });
  }
}

init();
