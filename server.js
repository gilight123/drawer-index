'use strict';
/*
 * Drawer Index — backend server.
 *
 * A tiny Express app with no database engine: all inventory lives in one JSON
 * file (db.json) that is read on boot and written atomically on every change.
 * Photos are stored as files under uploads/; dated snapshots under backups/.
 *
 * It runs three ways from this one file:
 *   - Docker / Node : DATA_DIR + PORT come from env (see docker-compose.yml)
 *   - packaged .exe  : process.pkg is set, so data sits next to the executable
 *                      and the bundled public/ files are read from the snapshot
 *
 * Data shape (db.json):
 *   { drawers: { "<code>": {name, note, order, example, tags[]} },
 *     parts:   { "<id>":   {name, qty, note, drawerId, img, min, tags[], example}}}
 *
 * REST API (all JSON):
 *   GET    /api/state              -> { drawers, parts }
 *   PUT    /api/drawers/:id        upsert a drawer
 *   DELETE /api/drawers/:id        delete a drawer + its parts (+ their photos)
 *   PUT    /api/parts/:id          upsert an item
 *   PATCH  /api/parts/:id          partial update (e.g. { qty })
 *   DELETE /api/parts/:id          delete an item (+ its photo)
 *   POST   /api/upload?ext=jpg     raw image body -> { url }
 *   POST   /api/backup             snapshot db.json -> { name, createdAt, bytes }
 *   GET    /api/backups            list snapshots
 *   GET    /api/backups/:name      download one snapshot
 *   DELETE /api/backups/:name      delete one snapshot
 *   POST   /api/restore            { name } -> replace db from a snapshot
 *   GET/POST /api/auth|login|logout  optional password login (AUTH_PASSWORD)
 *
 * Env vars: PORT, DATA_DIR, AUTH_PASSWORD (all optional).
 */
const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// When packaged as a standalone .exe (pkg), keep data next to the executable
// so it's portable; under Docker/Node the env vars drive it as before.
const PACKAGED = !!process.pkg;
const DATA = process.env.DATA_DIR || (PACKAGED ? path.join(path.dirname(process.execPath), 'drawer-index-data') : '/data');
const UPLOADS = path.join(DATA, 'uploads');
const BACKUPS = path.join(DATA, 'backups');
const DBFILE = path.join(DATA, 'db.json');
const PORT = parseInt(process.env.PORT || (PACKAGED ? '8095' : '3000'), 10);
const PUBLIC = path.join(__dirname, 'public');

fs.mkdirSync(UPLOADS, { recursive: true });
fs.mkdirSync(BACKUPS, { recursive: true });

// ---- storage: a single JSON file, written atomically ----
let db = { drawers: {}, parts: {} };
try { db = JSON.parse(fs.readFileSync(DBFILE, 'utf8')); } catch (e) { /* fresh */ }
if (!db || typeof db !== 'object') db = {};
if (!db.drawers) db.drawers = {};
if (!db.parts) db.parts = {};

function save() {
  const tmp = DBFILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(db));
  fs.renameSync(tmp, DBFILE);
}

function safeId(s) { return String(s == null ? '' : s).replace(/[^A-Za-z0-9_~.\-]/g, '').slice(0, 64); }

function safeBackupName(n) { n = String(n || ''); return /^backup-[A-Za-z0-9._\-]+\.json$/.test(n) ? n : ''; }
function makeBackup(tag) {
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const name = 'backup-' + ts + (tag ? ('-' + tag) : '') + '.json';
  fs.writeFileSync(path.join(BACKUPS, name), JSON.stringify(db));
  try {
    const files = fs.readdirSync(BACKUPS).filter(function (f) { return /^backup-.*\.json$/.test(f); }).sort();
    while (files.length > 60) { const old = files.shift(); try { fs.unlinkSync(path.join(BACKUPS, old)); } catch (e) {} }
  } catch (e) {}
  return name;
}

function unlinkImg(url) {
  if (!url) return;
  const m = /^\/uploads\/([A-Za-z0-9_.\-]+)$/.exec(String(url));
  if (!m) return;
  fs.unlink(path.join(UPLOADS, m[1]), function () {});
}

function cleanPart(b, prev) {
  b = b || {};
  return {
    name: String(b.name || '').slice(0, 200),
    qty: b.qty == null ? 1 : Math.max(0, parseInt(b.qty, 10) || 0),
    note: String(b.note || '').slice(0, 2000),
    drawerId: safeId(b.drawerId),
    img: b.img ? String(b.img).slice(0, 300) : null,
    min: (b.min == null || b.min === '') ? null : Math.max(0, parseInt(b.min, 10) || 0),
    tags: Array.isArray(b.tags) ? b.tags.map(function (t) { return String(t).slice(0, 40); }).filter(Boolean).slice(0, 30) : [],
    example: prev ? !!prev.example : !!b.example
  };
}

// ---- one-time seed so the first load isn't blank (all marked "example") ----
function seed() {
  const D = {
    D01: { name: 'Temp & Humidity', note: 'Example drawer — edit or delete anytime', order: 0, example: true },
    D02: { name: 'Motion & Distance', note: 'Example drawer — edit or delete anytime', order: 1, example: true },
    D03: { name: 'Light & Color', note: 'Example drawer — edit or delete anytime', order: 2, example: true }
  };
  const P = {
    'ex-dht22':   { name: 'DHT22', qty: 5, note: '1-wire digital · temp + humidity', drawerId: 'D01', min: null, tags: ['1-wire','temp','humidity'] },
    'ex-bme280':  { name: 'BME280', qty: 3, note: 'I²C 0x76 · temp / humidity / pressure', drawerId: 'D01', min: null, tags: ['i2c','temp','pressure'] },
    'ex-ds18b20': { name: 'DS18B20', qty: 10, note: '1-wire · waterproof temp probe', drawerId: 'D01', min: null, tags: ['1-wire','temp'] },
    'ex-hcsr04':  { name: 'HC-SR04', qty: 4, note: 'Ultrasonic distance · 5V trig/echo', drawerId: 'D02', min: null, tags: ['distance','5v'] },
    'ex-pir':     { name: 'PIR HC-SR501', qty: 6, note: 'Passive IR motion detector', drawerId: 'D02', min: null, tags: ['motion'] },
    'ex-vl53l0x': { name: 'VL53L0X', qty: 2, note: 'I²C · time-of-flight distance', drawerId: 'D02', min: 2, tags: ['i2c','distance','tof'] },
    'ex-mpu6050': { name: 'MPU6050', qty: 3, note: 'I²C 0x68 · accel + gyro (6-axis)', drawerId: 'D02', min: null, tags: ['i2c','imu','motion'] },
    'ex-bh1750':  { name: 'BH1750', qty: 3, note: 'I²C · ambient light (lux)', drawerId: 'D03', min: null, tags: ['i2c','light'] },
    'ex-tcs34725':{ name: 'TCS34725', qty: 1, note: 'I²C · RGB color sensor', drawerId: 'D03', min: 1, tags: ['i2c','color','light'] },
    'ex-ldr':     { name: 'LDR photoresistor', qty: 20, note: 'Analog light-dependent resistor', drawerId: 'D03', min: null, tags: ['analog','light'] }
  };
  db.drawers = D;
  Object.keys(P).forEach(function (k) { db.parts[k] = cleanPart(Object.assign({ example: true }, P[k])); db.parts[k].example = true; });
}
if (Object.keys(db.drawers).length === 0 && Object.keys(db.parts).length === 0) { seed(); save(); }

// ---- app ----
// ---- optional password login ----
// Set the AUTH_PASSWORD env var to require a password; leave it unset and the
// app is open (fine on a trusted LAN/VPN). Sessions are a signed cookie; the
// signing secret persists in the data folder so logins survive restarts.
const AUTH_PASSWORD = process.env.AUTH_PASSWORD || '';
const SECRETFILE = path.join(DATA, '.session-secret');
let SECRET;
try { SECRET = fs.readFileSync(SECRETFILE, 'utf8'); }
catch (e) { SECRET = crypto.randomBytes(32).toString('hex'); try { fs.writeFileSync(SECRETFILE, SECRET); } catch (e2) {} }
function makeToken() {
  const exp = String(Date.now() + 1000 * 60 * 60 * 24 * 30); // 30 days
  return exp + '.' + crypto.createHmac('sha256', SECRET).update(exp).digest('hex');
}
function validToken(tok) {
  if (!tok) return false;
  const i = tok.indexOf('.'); if (i < 0) return false;
  const exp = tok.slice(0, i), sig = tok.slice(i + 1);
  if (!/^[0-9]+$/.test(exp) || Date.now() > parseInt(exp, 10)) return false;
  const good = crypto.createHmac('sha256', SECRET).update(exp).digest('hex');
  try { return crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(good)); } catch (e) { return false; }
}
function getCookie(req, name) {
  const m = (req.headers.cookie || '').match(new RegExp('(?:^|; )' + name + '=([^;]*)'));
  return m ? decodeURIComponent(m[1]) : '';
}

const app = express();
app.use(express.json({ limit: '2mb' }));
app.disable('x-powered-by');

// gate the data endpoints (and uploaded photos) when a password is set;
// the static app files stay public so the login page itself can load.
app.use(function (req, res, next) {
  if (!AUTH_PASSWORD) return next();
  const p = req.path;
  if (p === '/api/login' || p === '/api/logout' || p === '/api/auth') return next();
  if (p.indexOf('/api/') !== 0 && p.indexOf('/uploads/') !== 0) return next();
  if (validToken(getCookie(req, 'di_session'))) return next();
  return res.status(401).json({ error: 'auth required' });
});

app.get('/api/auth', function (req, res) {
  res.json({ required: !!AUTH_PASSWORD, authed: !AUTH_PASSWORD || validToken(getCookie(req, 'di_session')) });
});
app.post('/api/login', function (req, res) {
  if (!AUTH_PASSWORD) return res.json({ ok: true, required: false });
  const pw = String((req.body && req.body.password) || '');
  let ok = false;
  try { ok = pw.length === AUTH_PASSWORD.length && crypto.timingSafeEqual(Buffer.from(pw), Buffer.from(AUTH_PASSWORD)); } catch (e) {}
  if (!ok) return res.status(401).json({ error: 'wrong password' });
  // "Remember me" (default on) = a persistent 30-day cookie; off = a session
  // cookie that the browser drops when it closes.
  const remember = !(req.body && req.body.remember === false);
  let cookie = 'di_session=' + makeToken() + '; HttpOnly; SameSite=Lax; Path=/';
  if (remember) cookie += '; Max-Age=' + (60 * 60 * 24 * 30);
  res.setHeader('Set-Cookie', cookie);
  res.json({ ok: true });
});
app.post('/api/logout', function (req, res) {
  res.setHeader('Set-Cookie', 'di_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0');
  res.json({ ok: true });
});

app.get('/api/state', function (req, res) { res.json({ drawers: db.drawers, parts: db.parts }); });

app.put('/api/drawers/:id', function (req, res) {
  const id = safeId(req.params.id);
  if (!id) return res.status(400).json({ error: 'bad id' });
  const b = req.body || {};
  db.drawers[id] = {
    name: String(b.name || id).slice(0, 200),
    note: String(b.note || '').slice(0, 2000),
    order: Number(b.order) || 0,
    example: !!b.example,
    tags: Array.isArray(b.tags) ? b.tags.map(function (t) { return String(t).slice(0, 40); }).filter(Boolean).slice(0, 30) : []
  };
  save(); res.json({ ok: true });
});

app.delete('/api/drawers/:id', function (req, res) {
  const id = safeId(req.params.id);
  delete db.drawers[id];
  Object.keys(db.parts).forEach(function (pid) {
    if (db.parts[pid].drawerId === id) { unlinkImg(db.parts[pid].img); delete db.parts[pid]; }
  });
  save(); res.json({ ok: true });
});

app.put('/api/parts/:id', function (req, res) {
  const id = safeId(req.params.id);
  if (!id) return res.status(400).json({ error: 'bad id' });
  const prev = db.parts[id];
  const next = cleanPart(req.body || {}, prev);
  if (prev && prev.img && prev.img !== next.img) unlinkImg(prev.img);
  db.parts[id] = next;
  save(); res.json({ ok: true });
});

app.patch('/api/parts/:id', function (req, res) {
  const id = safeId(req.params.id);
  const prev = db.parts[id];
  if (!prev) return res.status(404).json({ error: 'not found' });
  const b = req.body || {};
  if (b.qty != null) prev.qty = Math.max(0, parseInt(b.qty, 10) || 0);
  if (b.name != null) prev.name = String(b.name).slice(0, 200);
  if (b.note != null) prev.note = String(b.note).slice(0, 2000);
  if (b.min !== undefined) prev.min = (b.min == null || b.min === '') ? null : Math.max(0, parseInt(b.min, 10) || 0);
  if (Array.isArray(b.tags)) prev.tags = b.tags.map(function (t) { return String(t).slice(0, 40); }).filter(Boolean).slice(0, 30);
  save(); res.json({ ok: true, qty: prev.qty });
});

app.delete('/api/parts/:id', function (req, res) {
  const id = safeId(req.params.id);
  const prev = db.parts[id];
  if (prev) { unlinkImg(prev.img); delete db.parts[id]; save(); }
  res.json({ ok: true });
});

app.post('/api/upload', express.raw({ type: function () { return true; }, limit: '25mb' }), function (req, res) {
  if (!req.body || !req.body.length) return res.status(400).json({ error: 'empty' });
  let ext = String(req.query.ext || '').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 5);
  const ok = { jpg: 1, jpeg: 1, png: 1, gif: 1, webp: 1, heic: 1, bmp: 1 };
  if (!ok[ext]) ext = 'jpg';
  const name = crypto.randomBytes(12).toString('hex') + '.' + ext;
  fs.writeFileSync(path.join(UPLOADS, name), req.body);
  res.json({ url: '/uploads/' + name });
});

// ---- backups ----
app.post('/api/backup', function (req, res) {
  const name = makeBackup(req.body && req.body.tag ? String(req.body.tag).replace(/[^A-Za-z0-9_\-]/g, '').slice(0, 20) : '');
  try { const st = fs.statSync(path.join(BACKUPS, name)); res.json({ ok: true, name: name, createdAt: st.mtimeMs, bytes: st.size }); }
  catch (e) { res.status(500).json({ error: 'backup failed' }); }
});

app.get('/api/backups', function (req, res) {
  let out = [];
  try {
    out = fs.readdirSync(BACKUPS).filter(function (f) { return /^backup-.*\.json$/.test(f); }).map(function (f) {
      const st = fs.statSync(path.join(BACKUPS, f));
      return { name: f, createdAt: st.mtimeMs, bytes: st.size };
    }).sort(function (a, b) { return b.createdAt - a.createdAt; });
  } catch (e) {}
  res.json({ backups: out });
});

app.get('/api/backups/:name', function (req, res) {
  const n = safeBackupName(req.params.name); if (!n) return res.status(400).json({ error: 'bad name' });
  const fp = path.join(BACKUPS, n); if (!fs.existsSync(fp)) return res.status(404).json({ error: 'not found' });
  res.type('application/json').send(fs.readFileSync(fp));
});

app.delete('/api/backups/:name', function (req, res) {
  const n = safeBackupName(req.params.name); if (!n) return res.status(400).json({ error: 'bad name' });
  try { fs.unlinkSync(path.join(BACKUPS, n)); } catch (e) {}
  res.json({ ok: true });
});

app.post('/api/restore', function (req, res) {
  const n = safeBackupName(req.body && req.body.name); if (!n) return res.status(400).json({ error: 'bad name' });
  const fp = path.join(BACKUPS, n); if (!fs.existsSync(fp)) return res.status(404).json({ error: 'not found' });
  let data; try { data = JSON.parse(fs.readFileSync(fp, 'utf8')); } catch (e) { return res.status(400).json({ error: 'corrupt backup' }); }
  if (!data || typeof data !== 'object') return res.status(400).json({ error: 'invalid backup' });
  makeBackup('prerestore'); // safety snapshot of current state
  db = { drawers: data.drawers || {}, parts: data.parts || {} };
  save();
  res.json({ ok: true });
});

app.use('/uploads', express.static(UPLOADS, { maxAge: '7d' }));

// Serve the app's own files by reading them directly, so it works both from a
// normal folder (Docker) and from inside a packaged .exe snapshot.
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.ico': 'image/x-icon',
  '.css': 'text/css; charset=utf-8', '.webmanifest': 'application/manifest+json'
};
function servePublicFile(res, rel) {
  const fp = path.join(PUBLIC, rel);
  if (fp.indexOf(PUBLIC) !== 0) return false; // no path traversal
  try {
    const buf = fs.readFileSync(fp);
    res.type(MIME[path.extname(fp).toLowerCase()] || 'application/octet-stream').send(buf);
    return true;
  } catch (e) { return false; }
}
// static files, then app-shell fallback for client routes (/d/.., /s/..)
app.get('*', function (req, res) {
  if (req.path.indexOf('/api/') === 0) return res.status(404).json({ error: 'not found' });
  const rel = req.path === '/' ? 'index.html' : req.path.replace(/^\/+/, '');
  if (servePublicFile(res, rel)) return;
  if (servePublicFile(res, 'index.html')) return;
  res.status(404).send('Not found');
});

app.listen(PORT, '0.0.0.0', function () {
  const url = 'http://localhost:' + PORT;
  console.log('Drawer Index running on ' + url + '  (data: ' + DATA + ')');
  if (PACKAGED) {
    console.log('\n====================================================');
    console.log('  Drawer Index is running.');
    console.log('  Open this in your browser:  ' + url);
    console.log('  (it should open automatically)');
    console.log('  Your data is saved in the "drawer-index-data" folder');
    console.log('  next to this program. Keep this window open while');
    console.log('  using the app; close it to stop.');
    console.log('====================================================\n');
    try {
      const cp = require('child_process');
      const cmd = process.platform === 'win32' ? 'start ""' : process.platform === 'darwin' ? 'open' : 'xdg-open';
      cp.exec(cmd + ' ' + url);
    } catch (e) {}
  }
});
