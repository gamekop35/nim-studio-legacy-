const { app, BrowserWindow, ipcMain, safeStorage, dialog, shell, Menu, net } = require('electron');
const path = require('path');
const fs = require('fs');
const { autoUpdater } = require('electron-updater');

const BASE = 'https://integrate.api.nvidia.com/v1';
const keyFile = () => path.join(app.getPath('userData'), 'key.bin');
const dataFile = () => path.join(app.getPath('userData'), 'chats.json');
const logFile = () => path.join(app.getPath('userData'), 'nim-studio.log');
const controllers = new Map();
let mainWin = null;

// ---------------------------------------------------------------------------
// Logging: kept in memory, written to a file, and streamed to the Logs window.
// API keys are always redacted.
// ---------------------------------------------------------------------------
const logs = [];
const redact = (s) =>
  String(s)
    .replace(/nvapi-[A-Za-z0-9_\-]+/g, 'nvapi-***')
    .replace(/Bearer\s+[A-Za-z0-9_\-.]+/gi, 'Bearer ***');

function log(level, msg) {
  const entry = { t: Date.now(), level, msg: redact(msg) };
  logs.push(entry);
  if (logs.length > 600) logs.shift();
  try {
    fs.appendFileSync(logFile(), `${new Date(entry.t).toISOString()} ${level.toUpperCase()} ${entry.msg}\n`);
  } catch {}
  try {
    if (mainWin && !mainWin.isDestroyed()) mainWin.webContents.send('log:entry', entry);
  } catch {}
}

process.on('uncaughtException', (e) => log('error', 'Main process error: ' + (e && e.stack ? e.stack : e)));
process.on('unhandledRejection', (e) => log('error', 'Unhandled rejection: ' + (e && e.stack ? e.stack : e)));

function describe(err) {
  let s = err && err.message ? err.message : String(err);
  const c = err && err.cause;
  if (c) s += ' (' + [c.code, c.message].filter(Boolean).join(' ') + ')';
  return s;
}

ipcMain.handle('log:list', () => logs);
ipcMain.handle('log:clear', () => { logs.length = 0; try { fs.writeFileSync(logFile(), ''); } catch {} return true; });
ipcMain.handle('log:show', () => { shell.showItemInFolder(logFile()); return true; });
ipcMain.handle('log:renderer', (_e, level, msg) => { log(level === 'error' ? 'error' : 'warn', '[window] ' + msg); return true; });

// ---------------------------------------------------------------------------
// API key (encrypted with Windows DPAPI, never sent to the UI)
// ---------------------------------------------------------------------------
function getKey() {
  try {
    return safeStorage.decryptString(fs.readFileSync(keyFile()));
  } catch (e) {
    if (fs.existsSync(keyFile())) log('error', 'Could not decrypt the saved API key: ' + e.message + '. Replace it in Settings.');
    return null;
  }
}

ipcMain.handle('key:status', () => !!getKey());

ipcMain.handle('key:set', (_e, raw) => {
  const key = String(raw || '').trim().replace(/^bearer\s+/i, '').replace(/^["']|["']$/g, '').trim();
  if (!key) return { ok: false, error: 'Enter your API key.' };
  if (!safeStorage.isEncryptionAvailable()) return { ok: false, error: 'Secure storage is not available on this system.' };
  fs.writeFileSync(keyFile(), safeStorage.encryptString(key));
  log('info', `API key saved (${key.length} characters${key.startsWith('nvapi-') ? '' : ', does not start with nvapi-'}).`);
  return { ok: true };
});

ipcMain.handle('key:clear', () => {
  try { fs.unlinkSync(keyFile()); } catch {}
  log('info', 'API key removed.');
  return true;
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
async function errorText(res) {
  const raw = await res.text().catch(() => '');
  let detail = raw;
  try {
    const j = JSON.parse(raw);
    detail = j.detail || (j.error && j.error.message) || j.message || j.title || raw;
    if (typeof detail !== 'string') detail = JSON.stringify(detail);
  } catch {}
  return String(detail).slice(0, 500);
}

function friendly(status, detail) {
  const base =
    status === 401 || status === 403 ? `NVIDIA rejected the API key (HTTP ${status}). Replace it in Settings.`
    : status === 404 ? 'This model is not available for your key (HTTP 404). Pick another model.'
    : status === 429 ? 'Rate limit reached (HTTP 429). Wait a moment and try again.'
    : `The API returned HTTP ${status}.`;
  return detail ? `${base}\n${detail}` : base;
}

function mergeSystem(messages) {
  const [sys, ...rest] = messages;
  const i = rest.findIndex((m) => m.role === 'user');
  if (i >= 0) rest[i] = { ...rest[i], content: sys.content + '\n\n' + rest[i].content };
  return rest;
}

// ---------------------------------------------------------------------------
// Models
// ---------------------------------------------------------------------------
ipcMain.handle('models:list', async () => {
  try {
    const res = await net.fetch(`${BASE}/models`, {
      headers: { Authorization: `Bearer ${getKey()}` },
      signal: AbortSignal.timeout(20000)
    });
    if (!res.ok) {
      const d = await errorText(res);
      log('error', `Model list failed: HTTP ${res.status} ${d}`);
      return { ok: false, error: friendly(res.status, '') };
    }
    const j = await res.json();
    const ids = (j.data || []).map((m) => m.id).sort();
    log('info', `Model list loaded: ${ids.length} models.`);
    return { ok: true, models: ids };
  } catch (err) {
    log('error', 'Model list failed: ' + describe(err));
    return { ok: false, error: 'Could not load models: ' + describe(err) };
  }
});

// ---------------------------------------------------------------------------
// Streaming chat
// ---------------------------------------------------------------------------
async function streamChat(id, body, emit) {
  const key = getKey();
  if (!key) {
    log('error', 'Chat blocked: no API key is saved.');
    emit('chat:error', 'No API key is saved. Open Settings and choose Replace API key.');
    return;
  }
  const ctrl = new AbortController();
  controllers.set(id, ctrl);
  const t0 = Date.now();
  let timer = null, timedOut = false, got = 0, chars = 0, finishReason = '';
  const arm = (ms) => { clearTimeout(timer); timer = setTimeout(() => { timedOut = true; ctrl.abort(); }, ms); };
  const fail = (text) => Object.assign(new Error(text), { userMessage: text });
  const post = (payload) =>
    net.fetch(`${BASE}/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
        Accept: payload.stream ? 'text/event-stream' : 'application/json'
      },
      body: JSON.stringify(payload),
      signal: ctrl.signal
    });

  try {
    let payload = { ...body, stream: true };
    log('info', `Request: model=${body.model}, ${body.messages.length} messages, max_tokens=${body.max_tokens}, temperature=${body.temperature}`);
    arm(90000);
    let res = await post(payload);
    log('info', `Response: HTTP ${res.status}, ${res.headers.get('content-type') || 'no content-type'}, after ${Date.now() - t0} ms`);

    // Some models reject the "system" role. Retry once with it merged into the first user message.
    if (res.status === 400 && payload.messages[0] && payload.messages[0].role === 'system') {
      const detail = await errorText(res);
      log('warn', `HTTP 400: ${detail}\nRetrying with the system prompt merged into your first message.`);
      payload = { ...payload, messages: mergeSystem(payload.messages) };
      res = await post(payload);
      log('info', `Retry: HTTP ${res.status}`);
    }
    if (!res.ok) {
      const detail = await errorText(res);
      log('error', `HTTP ${res.status}: ${detail}`);
      throw fail(friendly(res.status, detail));
    }

    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';

    const handle = (raw) => {
      const line = raw.trim();
      if (!line.startsWith('data:')) return;
      const data = line.slice(5).trim();
      if (!data || data === '[DONE]') return;
      let j;
      try { j = JSON.parse(data); } catch { log('warn', 'Unreadable stream line: ' + data.slice(0, 200)); return; }
      if (j.error) {
        const msg = typeof j.error === 'string' ? j.error : j.error.message || JSON.stringify(j.error);
        log('error', 'Stream error: ' + msg);
        throw fail('The API reported an error: ' + msg);
      }
      const ch = j.choices && j.choices[0];
      if (!ch) return;
      if (ch.finish_reason) finishReason = ch.finish_reason;
      const d = ch.delta || {};
      const c = typeof d.content === 'string' ? d.content : typeof ch.text === 'string' ? ch.text : '';
      const r = d.reasoning_content || d.reasoning || '';
      if (c || r) {
        got++;
        chars += c.length + (typeof r === 'string' ? r.length : 0);
        if (got === 1) log('info', `First text arrived after ${Date.now() - t0} ms`);
        emit('chat:chunk', { c, r: typeof r === 'string' ? r : '' });
      }
    };

    arm(120000);
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      arm(120000);
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        handle(line);
      }
    }
    if (buf.trim()) handle(buf);

    // Nothing came through the stream: try a normal (non-streaming) request once.
    if (got === 0) {
      log('warn', 'The stream ended with no text. Trying once more without streaming.');
      arm(120000);
      const r2 = await post({ ...payload, stream: false });
      log('info', `Non-streaming response: HTTP ${r2.status}`);
      if (!r2.ok) {
        const detail = await errorText(r2);
        log('error', `HTTP ${r2.status}: ${detail}`);
        throw fail(friendly(r2.status, detail));
      }
      const j = await r2.json();
      const m = (j.choices && j.choices[0] && j.choices[0].message) || {};
      const c = typeof m.content === 'string' ? m.content : '';
      const r = m.reasoning_content || m.reasoning || '';
      if (c || r) {
        got = 1; chars = c.length + r.length;
        emit('chat:chunk', { c, r });
        log('info', `Non-streaming reply received (${chars} characters).`);
      } else {
        log('error', 'Empty reply. Raw response: ' + JSON.stringify(j).slice(0, 800));
      }
    }

    log('info', `Finished: ${got} chunks, ${chars} characters, ${Date.now() - t0} ms, finish_reason=${finishReason || 'n/a'}`);
    if (finishReason === 'length') log('warn', 'The reply was cut off by the max token limit. Raise Max response tokens in Settings.');
    emit('chat:done', null);
  } catch (err) {
    if (ctrl.signal.aborted && !timedOut) {
      log('info', 'Stopped by you.');
      emit('chat:done', null);
    } else {
      if (!err.userMessage) log('error', (timedOut ? 'Timed out: ' : 'Network error: ') + describe(err));
      emit('chat:error', err.userMessage || (timedOut
        ? 'NVIDIA did not respond in time. Open Logs and run the connection test.'
        : 'Could not reach NVIDIA: ' + describe(err)));
    }
  } finally {
    clearTimeout(timer);
    controllers.delete(id);
  }
}

ipcMain.on('chat:stream', (e, id, body) => {
  const emit = (ch, p) => { if (!e.sender.isDestroyed()) e.sender.send(ch, id, p); };
  streamChat(id, body, emit);
});
ipcMain.on('chat:stop', (_e, id) => { const c = controllers.get(id); if (c) c.abort(); });

// ---------------------------------------------------------------------------
// Connection test (shown step by step in the Logs window)
// ---------------------------------------------------------------------------
ipcMain.handle('diag:run', async (_e, model) => {
  log('info', '--- Connection test started ---');
  const key = getKey();
  if (!key) { log('error', '[1/3] No API key saved. Open Settings and choose Replace API key.'); return false; }
  log('info', `[1/3] API key found (${key.length} characters).` + (key.startsWith('nvapi-') ? '' : ' Warning: it does not start with nvapi-. Check that you copied the whole key.'));

  try {
    const r = await net.fetch(`${BASE}/models`, { headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(20000) });
    if (!r.ok) { log('error', `[2/3] GET /models failed: HTTP ${r.status} ${await errorText(r)}`); return false; }
    const j = await r.json();
    log('info', `[2/3] Reached NVIDIA. ${(j.data || []).length} models listed.`);
  } catch (err) {
    log('error', '[2/3] Could not reach NVIDIA: ' + describe(err) + '\nCheck your internet, VPN, proxy, firewall or antivirus HTTPS scanning.');
    return false;
  }

  log('info', `[3/3] Sending a test message to ${model} ...`);
  let text = '', error = null;
  await streamChat('diag-' + Date.now(),
    { model, messages: [{ role: 'user', content: 'Reply with the single word: ok' }], max_tokens: 256, temperature: 0 },
    (ch, p) => { if (ch === 'chat:chunk') text += p.c; if (ch === 'chat:error') error = p; });
  if (error) { log('error', '[3/3] Test message failed: ' + error); return false; }
  if (!text.trim()) { log('error', '[3/3] The model answered with no text. Try a different model.'); return false; }
  log('info', `[3/3] The model replied: "${text.trim().slice(0, 80)}"`);
  log('info', '--- Test PASSED. Sending messages should work. ---');
  return true;
});

// ---------------------------------------------------------------------------
// Local storage of chats and settings
// ---------------------------------------------------------------------------
ipcMain.handle('store:load', () => {
  try { return JSON.parse(fs.readFileSync(dataFile(), 'utf8')); } catch { return {}; }
});
ipcMain.handle('store:save', (_e, data) => {
  fs.writeFileSync(dataFile(), JSON.stringify(data));
  return true;
});

// ---------------------------------------------------------------------------
// Files: attach code to a prompt, save code blocks
// ---------------------------------------------------------------------------
ipcMain.handle('file:open', async (e) => {
  const win = BrowserWindow.fromWebContents(e.sender);
  const r = await dialog.showOpenDialog(win, { properties: ['openFile', 'multiSelections'] });
  if (r.canceled) return [];
  const out = [];
  for (const p of r.filePaths) {
    const stat = fs.statSync(p);
    if (stat.size > 400 * 1024) { out.push({ name: path.basename(p), error: 'File is larger than 400 KB.' }); continue; }
    const text = fs.readFileSync(p, 'utf8');
    if (text.includes('\u0000')) { out.push({ name: path.basename(p), error: 'Not a text file.' }); continue; }
    out.push({ name: path.basename(p), content: text });
  }
  return out;
});

ipcMain.handle('file:save', async (e, name, content) => {
  const win = BrowserWindow.fromWebContents(e.sender);
  const r = await dialog.showSaveDialog(win, { defaultPath: name });
  if (r.canceled || !r.filePath) return false;
  fs.writeFileSync(r.filePath, content, 'utf8');
  return true;
});

// ---------------------------------------------------------------------------
// Auto-update (installed version only; the portable build skips this)
// ---------------------------------------------------------------------------
const canUpdate = () => app.isPackaged && !process.env.PORTABLE_EXECUTABLE_DIR;
const sendUpdate = (p) => { if (mainWin && !mainWin.isDestroyed()) mainWin.webContents.send('update:status', p); };
const checkNow = () => autoUpdater.checkForUpdates().catch(() => {});

function setupUpdates() {
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.on('update-available', (i) => { log('info', 'Update found: ' + i.version); sendUpdate({ state: 'downloading', version: i.version, percent: 0 }); });
  autoUpdater.on('download-progress', (p) => sendUpdate({ state: 'downloading', percent: Math.round(p.percent) }));
  autoUpdater.on('update-downloaded', (i) => { log('info', 'Update downloaded: ' + i.version); sendUpdate({ state: 'ready', version: i.version }); });
  autoUpdater.on('update-not-available', () => sendUpdate({ state: 'none' }));
  autoUpdater.on('error', (err) => { log('warn', 'Update check failed: ' + err.message); sendUpdate({ state: 'error', message: err.message }); });
  setTimeout(checkNow, 5000);
  setInterval(checkNow, 4 * 60 * 60 * 1000);
}

ipcMain.handle('app:version', () => app.getVersion());
ipcMain.handle('update:check', async () => {
  if (!canUpdate()) return { ok: false, message: 'Updates work in the installed version of the app.' };
  try { await autoUpdater.checkForUpdates(); return { ok: true }; }
  catch { return { ok: false, message: 'Could not check for updates.' }; }
});
ipcMain.on('update:install', () => autoUpdater.quitAndInstall());

// ---------------------------------------------------------------------------
// Window
// ---------------------------------------------------------------------------
function createWindow() {
  const win = new BrowserWindow({
    width: 1240,
    height: 820,
    minWidth: 820,
    minHeight: 560,
    backgroundColor: '#11151b',
    autoHideMenuBar: true,
    title: 'NIM Studio',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  mainWin = win;
  win.webContents.on('did-fail-load', (_e, code, desc) => log('error', `Window failed to load: ${code} ${desc}`));
  win.webContents.on('render-process-gone', (_e, d) => log('error', 'Window process crashed: ' + d.reason));
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://')) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (ev) => ev.preventDefault());
}

app.whenReady().then(() => {
  try { if (fs.existsSync(logFile()) && fs.statSync(logFile()).size > 1024 * 1024) fs.unlinkSync(logFile()); } catch {}
  Menu.setApplicationMenu(Menu.buildFromTemplate([{ role: 'editMenu' }, { role: 'viewMenu' }]));
  createWindow();
  log('info', `NIM Studio ${app.getVersion()} started (Electron ${process.versions.electron}).`);
  if (canUpdate()) setupUpdates();
  app.on('activate', () => BrowserWindow.getAllWindows().length === 0 && createWindow());
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
