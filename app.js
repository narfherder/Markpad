// Markpad Reader — a home-screen reader for Markdown stories.
//
// Everything is local to the phone: stories, reading positions, settings and
// the fonts live in IndexedDB. The only network traffic is the app itself and,
// once Google Drive is connected, requests straight to Google's Drive API.
(() => {
'use strict';

const CFG = window.READER_CONFIG || {};
const APP_VERSION = '2026-10-13.2';
const $ = (sel) => document.querySelector(sel);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/* -------------------------------------------------------- diagnostics */

// An iPhone cannot be inspected from the PC, so the app keeps its own trail:
// the last steps it took, held in sessionStorage so they outlive a restart
// iOS forces on the page, and shown on screen whenever something fails.
const CRUMBS = 'reader-crumbs';
const OPENING = 'reader-opening';

function crumb(message) {
  try {
    const list = JSON.parse(sessionStorage.getItem(CRUMBS) || '[]');
    list.push(new Date().toTimeString().slice(0, 8) + '  ' + message);
    sessionStorage.setItem(CRUMBS, JSON.stringify(list.slice(-40)));
  } catch { /* diagnostics must never be the thing that breaks */ }
}
function crumbs() {
  try { return JSON.parse(sessionStorage.getItem(CRUMBS) || '[]'); } catch { return []; }
}

const shownErrors = new Set();
function showDiagnostics(title, detail = '') {
  const lines = [
    `Markpad Reader ${APP_VERSION}`, title, detail, '',
    'Recent steps:', ...crumbs().slice(-15), '',
    navigator.userAgent,
  ];
  $('#err-text').textContent = lines.join('\n');
  $('#errors').hidden = false;
}
function reportError(where, err) {
  const detail = err && err.message
    ? `${err.name || 'Error'}: ${err.message}${err.stack ? '\n' + err.stack.split('\n').slice(0, 4).join('\n') : ''}`
    : String(err);
  crumb(`ERROR in ${where}: ${detail.split('\n')[0]}`);
  // A broken storage layer fails on every scroll; say so once, not forever.
  const key = where + detail.split('\n')[0];
  if (shownErrors.has(key)) return;
  shownErrors.add(key);
  showDiagnostics(`Something went wrong: ${where}`, detail);
}
window.addEventListener('error', (e) => reportError('page', e.error || e.message));
window.addEventListener('unhandledrejection', (e) => reportError('background task', e.reason));

/* ------------------------------------------------------------ storage */

let dbPromise = null;
function openDb() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open('markpad-reader', 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        db.createObjectStore('stories', { keyPath: 'id' });
        db.createObjectStore('fonts', { keyPath: 'name' });
        db.createObjectStore('kv');
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
      req.onblocked = () => reject(new Error('Storage is blocked by another copy of the app'));
      setTimeout(() => reject(new Error('Storage did not open (IndexedDB timed out)')), 8000);
    });
    dbPromise.catch(() => { dbPromise = null; });   // let the next call try again
  }
  return dbPromise;
}
// Bounded: a storage request that never answers would otherwise hang whatever
// awaited it, and every button that reads storage would silently do nothing.
function settle(req, ms = 8000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Storage did not respond (IndexedDB timed out)')), ms);
    req.onsuccess = () => { clearTimeout(timer); resolve(req.result); };
    req.onerror = () => { clearTimeout(timer); reject(req.error || new Error('Storage error')); };
  });
}
async function objectStore(name, mode = 'readonly') {
  return (await openDb()).transaction(name, mode).objectStore(name);
}
const idb = {
  get: async (store, key) => settle((await objectStore(store)).get(key)),
  all: async (store) => settle((await objectStore(store)).getAll()),
  put: async (store, value, key) => {
    const s = await objectStore(store, 'readwrite');
    return settle(key === undefined ? s.put(value) : s.put(value, key));
  },
  del: async (store, key) => settle((await objectStore(store, 'readwrite')).delete(key)),
};
const kv = {
  get: (key) => idb.get('kv', key),
  set: (key, value) => idb.put('kv', value, key),
};

/* ----------------------------------------------------------- markdown */

const marked = new window.marked.Marked({ gfm: true, breaks: false });
marked.use({
  renderer: {
    // Stories are prose. Raw HTML in one is far likelier to be a stray angle
    // bracket than a deliberate embed, so it is shown as text, never run.
    html({ text, block }) {
      return block ? `<p>${escapeHtml(text)}</p>` : escapeHtml(text);
    },
  },
});

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}
function slugify(text) {
  return text.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/[^\p{L}\p{N}\s-]/gu, '').trim().replace(/\s+/g, '-') || 'section';
}
function titleFrom(name) {
  return name.replace(/\.(md|markdown|txt)$/i, '').replace(/_/g, ' ');
}

const doc = $('#doc');
let blocks = [];    // top-level elements, each tagged with its source line
let headings = [];  // { el, depth, text } for h1–h3

function render(text) {
  const tokens = marked.lexer(text);
  let line = 1;
  let html = '';
  for (const token of tokens) {
    const start = line;
    line += (token.raw.match(/\n/g) || []).length;
    if (token.type === 'space') continue;
    const one = [token];
    one.links = tokens.links;
    const part = marked.parser(one);
    if (!part.trim()) continue;
    // Each block carries the source line it starts on, so a reading position
    // can be stored as "this paragraph" rather than as a pixel offset.
    html += part.replace(/^\s*<([a-zA-Z][a-zA-Z0-9]*)/, `<$1 data-line="${start}"`);
  }
  doc.innerHTML = html;
  blocks = Array.from(doc.children).filter((el) => el.dataset.line);

  headings = [];
  const used = new Map();
  for (const el of blocks) {
    if (!/^H[1-3]$/.test(el.tagName)) continue;
    const base = slugify(el.textContent);
    const n = used.get(base) || 0;
    used.set(base, n + 1);
    el.id = n ? `${base}-${n}` : base;
    headings.push({ el, depth: Number(el.tagName[1]), text: el.textContent.trim() });
  }
  buildToc();
}

/* ---------------------------------------------------- reading position */

const bar = $('#bar');
// Measured from the bar's full height whether or not it is currently slid
// away, so saving and restoring always use the same reference line.
const refOffset = () => bar.offsetHeight + 10;
const pageTop = (el) => el.getBoundingClientRect().top + window.scrollY;
const keyOf = (el) => el.textContent.replace(/\s+/g, ' ').trim().slice(0, 100);

function blockAt(y) {
  let lo = 0;
  let hi = blocks.length - 1;
  let best = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (pageTop(blocks[mid]) <= y) { best = mid; lo = mid + 1; } else { hi = mid - 1; }
  }
  return blocks[best];
}

function captureAnchor() {
  if (!blocks.length) return null;
  if (window.scrollY < 4) return { top: true };
  const ref = window.scrollY + refOffset();
  const el = blockAt(ref);
  const height = el.offsetHeight || 1;
  return {
    line: Number(el.dataset.line),
    key: keyOf(el),
    frac: Math.min(1, Math.max(0, (ref - pageTop(el)) / height)),
  };
}

function restoreAnchor(anchor) {
  if (!anchor || anchor.top || !blocks.length) { scrollQuietly(0); return; }
  // The paragraph that opens with the same words, nearest its old line. Text
  // added or removed above it changes its line number but not its words, so
  // this is what keeps a reader in place while a story is being edited.
  let target = null;
  if (anchor.key) {
    let best = Infinity;
    for (const el of blocks) {
      if (keyOf(el) !== anchor.key) continue;
      const d = Math.abs(Number(el.dataset.line) - anchor.line);
      if (d < best) { best = d; target = el; }
    }
  }
  // The paragraph itself was rewritten: fall back to its line.
  if (!target) {
    target = blocks[0];
    for (const el of blocks) {
      if (Number(el.dataset.line) <= anchor.line) target = el; else break;
    }
  }
  scrollQuietly(pageTop(target) + (anchor.frac || 0) * target.offsetHeight - refOffset());
}

// Scrolls the app makes itself must not slide the bar or dismiss popovers.
let quietUntil = 0;
function scrollQuietly(y) {
  quietUntil = performance.now() + 250;
  window.scrollTo(0, Math.max(0, y));
}

let current = null;
let saveTimer = null;
function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(savePosition, 600);
}
async function savePosition() {
  clearTimeout(saveTimer);
  if (!current || document.body.dataset.view !== 'reader') return;
  current.position = captureAnchor();
  const max = document.documentElement.scrollHeight - window.innerHeight;
  current.progress = max > 0 ? Math.min(100, Math.round((window.scrollY / max) * 100)) : 0;
  current.readAt = Date.now();
  try {
    await idb.put('stories', current);
  } catch (err) {
    reportError('saving your place', err);
  }
}

let lastY = 0;
let ticking = false;
window.addEventListener('scroll', () => {
  if (ticking) return;
  ticking = true;
  requestAnimationFrame(() => {
    ticking = false;
    if (document.body.dataset.view !== 'reader') return;
    const y = window.scrollY;
    if (performance.now() > quietUntil) {
      if (y > lastY + 8 && y > 120) bar.classList.add('hidden');
      else if (y < lastY - 8 || y < 60) bar.classList.remove('hidden');
      closeAa();
    }
    lastY = y;
    scheduleSave();
  });
}, { passive: true });

document.addEventListener('visibilitychange', () => {
  if (document.hidden) savePosition(); else checkLive();
});
window.addEventListener('pagehide', () => { savePosition(); });

doc.addEventListener('click', (e) => {
  const link = e.target.closest('a');
  if (link) {
    const href = link.getAttribute('href') || '';
    if (href.startsWith('#')) {
      e.preventDefault();
      const target = document.getElementById(decodeURIComponent(href.slice(1)));
      if (target) jumpTo(target);
    }
    return;
  }
  if (!aaPop.hidden) { closeAa(); return; }
  const sel = window.getSelection();
  if (sel && !sel.isCollapsed) return;
  bar.classList.toggle('hidden');
});

/* ------------------------------------------------------------ contents */

const tocEl = $('#toc');
const tocList = $('#toc-list');
const scrim = $('#scrim');

function buildToc() {
  tocList.replaceChildren(...headings.map((h, i) => {
    const li = document.createElement('li');
    li.className = 'd' + h.depth;
    const a = document.createElement('a');
    a.href = '#' + h.el.id;
    a.textContent = h.text;
    a.dataset.index = String(i);
    li.append(a);
    return li;
  }));
  $('#btn-toc').hidden = headings.length === 0;
}

function jumpTo(el) {
  closeToc();
  // Instant, and measured from the heading itself: nothing to sit through,
  // and nothing to drift while an animation plays.
  scrollQuietly(pageTop(el) - refOffset());
  bar.classList.remove('hidden');
  scheduleSave();
}

function openToc() {
  closeAa();
  const y = window.scrollY + refOffset() + 1;
  let active = -1;
  headings.forEach((h, i) => { if (pageTop(h.el) <= y) active = i; });
  const links = tocList.querySelectorAll('a');
  links.forEach((a, i) => a.classList.toggle('active', i === active));
  scrim.hidden = false;
  tocEl.classList.add('open');
  if (active >= 0) {
    const a = links[active];
    tocEl.scrollTop = Math.max(0, a.offsetTop - tocEl.clientHeight / 2);
  }
}
function closeToc() {
  tocEl.classList.remove('open');
  scrim.hidden = true;
}

tocList.addEventListener('click', (e) => {
  const a = e.target.closest('a');
  if (!a) return;
  e.preventDefault();
  jumpTo(headings[Number(a.dataset.index)].el);
});
$('#btn-toc').addEventListener('click', () => {
  if (tocEl.classList.contains('open')) closeToc(); else openToc();
});
scrim.addEventListener('click', closeToc);

/* ----------------------------------------------------------- text size */

const FS_MIN = 13;
const FS_MAX = 30;
const aaPop = $('#aa-pop');
let fontSize = 18;

function applyFontSize(px) {
  fontSize = Math.min(FS_MAX, Math.max(FS_MIN, px));
  document.documentElement.style.setProperty('--fs', fontSize + 'px');
  $('#fs-val').textContent = fontSize + 'px';
}
function changeFontSize(delta) {
  const anchor = captureAnchor();
  applyFontSize(fontSize + delta);
  kv.set('fontSize', fontSize);
  restoreAnchor(anchor);
}
function closeAa() { aaPop.hidden = true; }

$('#fs-down').addEventListener('click', () => changeFontSize(-1));
$('#fs-up').addEventListener('click', () => changeFontSize(1));
$('#btn-aa').addEventListener('click', () => {
  closeToc();
  aaPop.hidden = !aaPop.hidden;
});

/* --------------------------------------------------------------- fonts */

// Static font files register one family per weight ("Serif Text Semibold").
// Reading the weight back out of the file name puts every cut under its real
// family, so a heading asking for weight 600 gets the true semibold rather
// than a synthesised bold.
const WEIGHTS = {
  thin: 100, hairline: 100, extralight: 200, ultralight: 200, light: 300,
  regular: 400, normal: 400, book: 400, medium: 500,
  semibold: 600, demibold: 600, smbold: 600, bold: 700,
  extrabold: 800, exbold: 800, ultrabold: 800, heavy: 900, black: 900,
};
function describeFont(fileName) {
  const base = fileName.replace(/\.(otf|ttf|woff2?)$/i, '').replace(/[-_ ]static$/i, '');
  const parts = base.split(/[-_ ]+/).filter(Boolean);
  let tail = parts.length > 1 ? parts[parts.length - 1] : '';
  let style = 'normal';
  if (/italic$/i.test(tail)) {
    style = 'italic';
    tail = tail.replace(/italic$/i, '') || 'regular';
  }
  const weight = WEIGHTS[tail.toLowerCase()];
  if (weight !== undefined) parts.pop();
  return { family: parts.join(' ') || base, weight: String(weight ?? 400), style };
}

let fontFamilies = new Set();
let fontsReady = Promise.resolve();

async function registerFont(record) {
  const d = describeFont(record.name);
  const face = new FontFace(d.family, record.data.slice(0), { weight: d.weight, style: d.style });
  await face.load();
  document.fonts.add(face);
  return d.family;
}
async function loadStoredFonts() {
  const records = await idb.all('fonts');
  const results = await Promise.allSettled(records.map(registerFont));
  return new Set(results.filter((r) => r.status === 'fulfilled').map((r) => r.value));
}
function updateFontStatus() {
  const loaded = fontFamilies.has('Serif Text');
  $('#font-status').textContent = loaded ? 'Serif fonts loaded.' : 'Using a fallback serif.';
  $('#btn-fonts').textContent = loaded ? 'Replace fonts…' : 'Load fonts…';
}

$('#btn-fonts').addEventListener('click', () => $('#font-input').click());
$('#font-input').addEventListener('change', async (e) => {
  const files = Array.from(e.target.files || []).filter((f) => /\.(otf|ttf|woff2?)$/i.test(f.name));
  e.target.value = '';
  if (!files.length) { toast('No font files selected'); return; }
  const anchor = captureAnchor();
  let loaded = 0;
  for (const file of files) {
    const record = { name: file.name, data: await file.arrayBuffer() };
    try {
      fontFamilies.add(await registerFont(record));
      await idb.put('fonts', record);
      loaded += 1;
    } catch {
      // Not a font this browser can read; skip it.
    }
  }
  if (document.body.dataset.view === 'reader') restoreAnchor(anchor);
  toast(`Loaded ${loaded} font${loaded === 1 ? '' : 's'}`);
  updateFontStatus();
});

/* ------------------------------------------------------------- library */

async function openStory(story) {
  crumb(`open "${story.title}" (${Math.round((story.text || '').length / 1024)} KB, ${story.source})`);
  // Marks an open in progress. If iOS kills the page part-way through, the
  // next start finds this still set and says so instead of failing silently.
  try { sessionStorage.setItem(OPENING, `${story.title} (${Math.round((story.text || '').length / 1024)} KB)`); } catch {}
  await savePosition();
  current = story;
  current.openedAt = Date.now();
  closeToc();
  closeAa();
  hideBanner();
  document.body.dataset.view = 'reader';
  bar.classList.remove('hidden');
  $('#title').textContent = current.title;
  render(current.text);
  crumb(`rendered ${blocks.length} blocks, ${headings.length} headings`);
  // Bounded, and no waiting on an animation frame: a page started or resumed
  // in the background draws no frames, and start-up stalled there with the
  // story invisible. Reading offsetHeight lays the page out on the spot.
  await Promise.race([fontsReady, sleep(1500)]);
  void doc.offsetHeight;
  restoreAnchor(current.position);
  lastY = window.scrollY;
  liveState = 'live';
  if (current.source === 'drive') startLive(); else stopLive();
  updateLiveDot();
  try { sessionStorage.removeItem(OPENING); } catch {}
  crumb('open finished');

  // Saved only once the story is on screen, and never awaited by it: storage
  // trouble must not stand between you and the page. Remembering it as the
  // open story comes last, so a story that crashes while rendering is not
  // reopened automatically on the next start.
  idb.put('stories', current).catch((err) => reportError('saving the story', err));
  kv.set('current', current.id).catch((err) => reportError('remembering the open story', err));
}

async function showLibrary() {
  await savePosition();
  stopLive();
  current = null;
  kv.set('current', null).catch((err) => reportError('leaving the story', err));
  closeToc();
  closeAa();
  hideBanner();
  document.body.dataset.view = 'library';
  window.scrollTo(0, 0);
  let stories = [];
  try {
    stories = (await idb.all('stories'))
      .sort((a, b) => (b.readAt || b.openedAt || 0) - (a.readAt || a.openedAt || 0));
  } catch (err) {
    reportError('loading the library', err);
  }
  $('#lib-list').replaceChildren(...stories.map(storyRow));
  $('#lib-empty').hidden = stories.length > 0;
  updateDriveButton();
}

function storyRow(story) {
  const li = document.createElement('li');
  const open = document.createElement('button');
  open.className = 'story';
  const title = document.createElement('span');
  title.className = 's-title';
  title.textContent = story.title;
  const meta = document.createElement('span');
  meta.className = 's-meta';
  meta.textContent = [
    story.source === 'drive' ? 'Google Drive · live' : 'Files',
    story.progress != null ? `${story.progress}%` : null,
    ago(story.readAt || story.openedAt),
  ].filter(Boolean).join(' · ');
  open.append(title, meta);
  open.addEventListener('click', () => openStory(story));

  const remove = document.createElement('button');
  remove.className = 's-del';
  remove.textContent = '×';
  remove.setAttribute('aria-label', 'Remove ' + story.title);
  remove.addEventListener('click', async () => {
    if (!confirm(`Remove “${story.title}” from the library? The file itself is not touched.`)) return;
    await idb.del('stories', story.id);
    showLibrary();
  });
  li.append(open, remove);
  return li;
}

function ago(ts) {
  if (!ts) return '';
  const minutes = Math.round((Date.now() - ts) / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.round(hours / 24);
  return days === 1 ? 'yesterday' : `${days} days ago`;
}

$('#btn-lib').addEventListener('click', showLibrary);

/* --------------------------------------------------------------- Files */

// No `accept` filter: iOS greys out .md files it has no type for.
$('#btn-files').addEventListener('click', () => $('#file-input').click());
$('#file-input').addEventListener('change', async (e) => {
  const file = e.target.files && e.target.files[0];
  e.target.value = '';
  if (!file) return;
  crumb(`files: picked ${file.name} (${Math.round(file.size / 1024)} KB)`);
  const text = await file.text();
  const id = 'file:' + file.name;
  const previous = await idb.get('stories', id).catch(() => null) || {};
  const story = { ...previous, id, source: 'file', name: file.name, title: titleFrom(file.name), text };
  await openStory(story);
});

/* -------------------------------------------------------- Google Drive */

const SCOPE = 'https://www.googleapis.com/auth/drive.readonly';
const API = 'https://www.googleapis.com/drive/v3/';
const POLL_MS = 20000;

class DriveAuthError extends Error {}
let silentFailed = false;

function redirectUri() {
  return location.origin + location.pathname.replace(/index\.html$/, '');
}

async function driveSignIn(silent, after = null) {
  if (!CFG.googleClientId) { toast('Google Drive isn’t set up yet'); return; }
  await savePosition();
  const state = crypto.randomUUID ? crypto.randomUUID() : String(Math.random()).slice(2);
  await kv.set('oauth', { state, returnTo: current ? current.id : null, after });
  const params = new URLSearchParams({
    client_id: CFG.googleClientId,
    redirect_uri: redirectUri(),
    response_type: 'token',
    scope: SCOPE,
    include_granted_scopes: 'true',
    state,
  });
  if (silent) params.set('prompt', 'none');
  location.assign('https://accounts.google.com/o/oauth2/v2/auth?' + params.toString());
}

// Google sends the reader back here with the outcome in the URL fragment.
// Returns undefined when this load is not a return from sign-in.
async function finishSignIn() {
  if (!/[#&]state=/.test(location.hash)) return undefined;
  const result = new URLSearchParams(location.hash.slice(1));
  history.replaceState(null, '', location.pathname + location.search);
  const pending = await kv.get('oauth');
  await kv.set('oauth', null);
  if (!pending || result.get('state') !== pending.state) return undefined;
  const token = result.get('access_token');
  const previous = (await kv.get('drive')) || {};
  if (token) {
    const seconds = Number(result.get('expires_in')) || 3600;
    await kv.set('drive', { connected: true, token, expires: Date.now() + seconds * 1000 - 60000 });
    silentFailed = false;
  } else {
    // A silent attempt that needs the user (expired Google session, revoked
    // access). The next attempt has to be a visible one.
    silentFailed = true;
    await kv.set('drive', { ...previous, token: null });
  }
  return { returnTo: pending.returnTo, after: token ? pending.after : null };
}

async function driveToken() {
  const d = await kv.get('drive');
  return d && d.token && Date.now() < d.expires ? d.token : null;
}
async function driveConnected() {
  const d = await kv.get('drive');
  return !!(d && d.connected);
}

async function drive(path, asText = false) {
  const token = await driveToken();
  if (!token) throw new DriveAuthError();
  const res = await fetch(API + path, { headers: { Authorization: 'Bearer ' + token } });
  if (res.status === 401) {
    const d = (await kv.get('drive')) || {};
    await kv.set('drive', { ...d, token: null });
    throw new DriveAuthError();
  }
  if (!res.ok) throw new Error('Google Drive answered ' + res.status);
  return asText ? res.text() : res.json();
}

async function updateDriveButton() {
  $('#btn-drive').textContent = CFG.googleClientId && !(await driveConnected())
    ? 'Connect Drive' : 'Google Drive';
}
$('#btn-drive').addEventListener('click', async () => {
  if (!CFG.googleClientId) { toast('Google Drive isn’t set up yet'); return; }
  if (await driveToken()) { openDriveBrowser(); return; }
  driveSignIn((await driveConnected()) && !silentFailed, 'browse');
});

async function needReconnect() {
  const silent = (await driveConnected()) && !silentFailed;
  liveState = 'stale';
  updateLiveDot();
  showBanner('Google Drive needs you to sign in again to keep updating.', 'Reconnect',
    () => driveSignIn(silent));
}

// --- browsing

const sheet = $('#drive-sheet');
const driveList = $('#drive-list');
let trail = [];

function openDriveBrowser() {
  trail = [{ id: 'root', name: 'My Drive' }];
  sheet.hidden = false;
  loadFolder();
}
$('#drive-close').addEventListener('click', () => { sheet.hidden = true; });
$('#drive-back').addEventListener('click', () => {
  if (trail.length > 1) { trail.pop(); loadFolder(); }
});

function note(text) {
  const li = document.createElement('li');
  li.className = 'note';
  li.textContent = text;
  return li;
}
function row(icon, name, sub, onClick) {
  const li = document.createElement('li');
  const button = document.createElement('button');
  const ico = document.createElement('span');
  ico.className = 'ico';
  ico.textContent = icon;
  const label = document.createElement('span');
  label.textContent = name;
  if (sub) {
    const s = document.createElement('span');
    s.className = 'sub';
    s.textContent = sub;
    label.append(s);
  }
  button.append(ico, label);
  button.addEventListener('click', onClick);
  li.append(button);
  return li;
}

async function loadFolder() {
  const here = trail[trail.length - 1];
  $('#drive-path').textContent = trail.map((t) => t.name).join(' › ');
  $('#drive-back').style.visibility = trail.length > 1 ? 'visible' : 'hidden';
  driveList.replaceChildren(note('Loading…'));
  try {
    const q = encodeURIComponent(`'${here.id}' in parents and trashed = false`);
    const fields = encodeURIComponent('nextPageToken,files(id,name,mimeType,modifiedTime)');
    let files = [];
    let pageToken = '';
    do {
      const res = await drive(`files?q=${q}&fields=${fields}&orderBy=folder,name_natural&pageSize=1000`
        + '&supportsAllDrives=true&includeItemsFromAllDrives=true'
        + (pageToken ? '&pageToken=' + encodeURIComponent(pageToken) : ''));
      files = files.concat(res.files || []);
      pageToken = res.nextPageToken || '';
    } while (pageToken);
    if (trail[trail.length - 1] !== here) return;   // moved on while loading

    const folders = files.filter((f) => f.mimeType === 'application/vnd.google-apps.folder');
    const stories = files.filter((f) => /\.(md|markdown|txt)$/i.test(f.name));
    const rows = [
      ...folders.map((f) => row('📁', f.name, null, () => {
        trail.push({ id: f.id, name: f.name });
        loadFolder();
      })),
      ...stories.map((f) => row('¶', f.name, 'Edited ' + ago(Date.parse(f.modifiedTime)),
        () => openDriveFile(f))),
    ];
    driveList.replaceChildren(...(rows.length ? rows : [note('No folders or stories here.')]));
  } catch (err) {
    if (err instanceof DriveAuthError) { sheet.hidden = true; needReconnect(); return; }
    driveList.replaceChildren(note('Couldn’t reach Google Drive. ' + err.message));
  }
}

async function openDriveFile(file) {
  crumb(`drive: open ${file.name}`);
  driveList.replaceChildren(note('Opening ' + file.name + '…'));
  let story;
  try {
    const meta = await drive(`files/${file.id}?fields=id,name,version&supportsAllDrives=true`);
    crumb(`drive: metadata ok (version ${meta.version})`);
    const text = await drive(`files/${file.id}?alt=media&supportsAllDrives=true`, true);
    crumb(`drive: downloaded ${Math.round(text.length / 1024)} KB`);
    const id = 'drive:' + file.id;
    const previous = await idb.get('stories', id).catch(() => null) || {};
    story = {
      ...previous, id, source: 'drive', driveId: file.id,
      name: meta.name, title: titleFrom(meta.name), text, version: meta.version,
    };
  } catch (err) {
    crumb(`drive: open failed: ${err.message || err}`);
    if (err instanceof DriveAuthError) { sheet.hidden = true; needReconnect(); return; }
    loadFolder();
    reportError('opening ' + file.name, err);
    return;
  }
  sheet.hidden = true;
  await openStory(story);
}

// --- live reload

let liveTimer = null;
let liveBusy = false;
let liveState = 'live';

function startLive() {
  stopLive();
  liveTimer = setInterval(checkLive, POLL_MS);
  checkLive();
}
function stopLive() {
  clearInterval(liveTimer);
  liveTimer = null;
}
function updateLiveDot() {
  const dot = $('#live-dot');
  dot.hidden = !current || current.source !== 'drive';
  dot.classList.toggle('stale', liveState !== 'live');
}

async function checkLive() {
  if (!current || current.source !== 'drive' || document.hidden || liveBusy) return;
  liveBusy = true;
  const story = current;
  try {
    const meta = await drive(`files/${story.driveId}?fields=name,version&supportsAllDrives=true`);
    if (meta.version !== story.version) {
      const text = await drive(`files/${story.driveId}?alt=media&supportsAllDrives=true`, true);
      if (current !== story) return;
      const anchor = captureAnchor();
      Object.assign(story, { text, version: meta.version, name: meta.name, title: titleFrom(meta.name) });
      render(text);
      restoreAnchor(anchor);
      $('#title').textContent = story.title;
      await savePosition();
      toast('Updated');
    }
    liveState = 'live';
    hideBanner();
  } catch (err) {
    liveState = 'stale';
    if (err instanceof DriveAuthError) needReconnect();
  } finally {
    liveBusy = false;
    updateLiveDot();
  }
}

/* ---------------------------------------------------- banner and toast */

let bannerAction = null;
function showBanner(text, label, action) {
  $('#banner-text').textContent = text;
  $('#banner-btn').textContent = label;
  bannerAction = action;
  $('#banner').hidden = false;
}
function hideBanner() {
  $('#banner').hidden = true;
  bannerAction = null;
}
$('#banner-btn').addEventListener('click', () => { if (bannerAction) bannerAction(); });

let toastTimer = null;
function toast(message) {
  const el = $('#toast');
  el.textContent = message;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2200);
}

/* --------------------------------------------------------------- start */

/* ------------------------------------------- library footer, panel */

$('#app-version').textContent = 'Version ' + APP_VERSION;
$('#btn-diag').addEventListener('click', () => showDiagnostics('Diagnostics (nothing has failed)'));
$('#btn-reload').addEventListener('click', () => location.reload());
$('#err-reload').addEventListener('click', () => location.reload());
$('#err-close').addEventListener('click', () => { $('#errors').hidden = true; });
$('#err-copy').addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText($('#err-text').textContent);
    toast('Copied');
  } catch {
    toast('Couldn’t copy — take a screenshot instead');
  }
});

async function start() {
  crumb(`start ${APP_VERSION}${location.hash ? ' (returning from Google)' : ''}`);
  if ('scrollRestoration' in history) history.scrollRestoration = 'manual';
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});

  // An open that never reached its end means iOS restarted the page under it.
  let interrupted = null;
  try { interrupted = sessionStorage.getItem(OPENING); sessionStorage.removeItem(OPENING); } catch {}

  fontsReady = loadStoredFonts()
    .then((families) => { fontFamilies = families; updateFontStatus(); })
    .catch((err) => reportError('loading your fonts', err));
  applyFontSize((await kv.get('fontSize').catch(() => null)) || 18);
  updateFontStatus();

  const signIn = await finishSignIn().catch((err) => { reportError('finishing Google sign-in', err); return undefined; });
  const id = signIn ? signIn.returnTo : await kv.get('current').catch(() => null);
  const story = id ? await idb.get('stories', id).catch(() => null) : null;

  if (interrupted) {
    showDiagnostics('The app restarted while opening a story, so it went back to the library.',
      `Story: ${interrupted}`);
  }

  if (story && !interrupted) {
    // Back on a Drive story after the hour-long sign-in has lapsed: renew it
    // once, silently, before anyone has to tap anything.
    if (story.source === 'drive' && !signIn && !(await driveToken().catch(() => null))
        && (await driveConnected().catch(() => false)) && !sessionStorage.getItem('renewTried')) {
      sessionStorage.setItem('renewTried', '1');
      current = story;
      driveSignIn(true);
      return;
    }
    await openStory(story);
  } else {
    await showLibrary();
    if (signIn && signIn.after === 'browse') openDriveBrowser();
  }
  document.body.classList.remove('booting');
}

start().catch((err) => {
  document.body.classList.remove('booting');
  document.body.dataset.view = 'library';
  reportError('starting up', err);
});
})();
