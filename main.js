const { app, BrowserWindow, ipcMain, safeStorage, dialog, shell, Menu } = require('electron');
const path = require('path');
const fs = require('fs');
const { autoUpdater } = require('electron-updater');

const BASE = 'https://integrate.api.nvidia.com/v1';
const keyFile = () => path.join(app.getPath('userData'), 'key.bin');
const dataFile = () => path.join(app.getPath('userData'), 'chats.json');
const controllers = new Map();

// ---- API key: encrypted with Windows DPAPI via safeStorage, never sent to the UI ----
function getKey() {
  try {
    return safeStorage.decryptString(fs.readFileSync(keyFile()));
  } catch {
    return null;
  }
}

ipcMain.handle('key:status', () => !!getKey());

ipcMain.handle('key:set', (_e, key) => {
  key = String(key || '').trim();
  if (!key) return { ok: false, error: 'Enter your API key.' };
  if (!safeStorage.isEncryptionAvailable()) return { ok: false, error: 'Secure storage is not available on this system.' };
  fs.writeFileSync(keyFile(), safeStorage.encryptString(key));
  return { ok: true };
});

ipcMain.handle('key:clear', () => {
  try { fs.unlinkSync(keyFile()); } catch {}
  return true;
});

// ---- Models ----
ipcMain.handle('models:list', async () => {
  try {
    const res = await fetch(`${BASE}/models`, { headers: { Authorization: `Bearer ${getKey()}` } });
    if (!res.ok) return { ok: false, error: friendly(res.status, '') };
    const j = await res.json();
    return { ok: true, models: (j.data || []).map((m) => m.id).sort() };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

function friendly(status, body) {
  if (status === 401 || status === 403) return 'NVIDIA rejected the API key. Check it in Settings.';
  if (status === 404) return 'Model not found. Pick another model from the list.';
  if (status === 429) return 'Rate limit reached. Wait a moment and try again.';
  return `HTTP ${status}${body ? ': ' + body.slice(0, 300) : ''}`;
}

// ---- Streaming chat ----
ipcMain.on('chat:stream', async (e, id, body) => {
  const ctrl = new AbortController();
  controllers.set(id, ctrl);
  const emit = (ch, p) => { if (!e.sender.isDestroyed()) e.sender.send(ch, id, p); };
  try {
    const res = await fetch(`${BASE}/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${getKey()}`, 'Content-Type': 'application/json', Accept: 'text/event-stream' },
      body: JSON.stringify({ ...body, stream: true }),
      signal: ctrl.signal
    });
    if (!res.ok) throw new Error(friendly(res.status, await res.text()));

    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (data === '[DONE]') continue;
        try {
          const delta = JSON.parse(data).choices?.[0]?.delta || {};
          if (delta.content || delta.reasoning_content) {
            emit('chat:chunk', { c: delta.content || '', r: delta.reasoning_content || '' });
          }
        } catch {}
      }
    }
    emit('chat:done', null);
  } catch (err) {
    if (err.name === 'AbortError') emit('chat:done', null);
    else emit('chat:error', err.message);
  } finally {
    controllers.delete(id);
  }
});

ipcMain.on('chat:stop', (_e, id) => controllers.get(id)?.abort());

// ---- Local storage of chats and settings ----
ipcMain.handle('store:load', () => {
  try { return JSON.parse(fs.readFileSync(dataFile(), 'utf8')); } catch { return {}; }
});
ipcMain.handle('store:save', (_e, data) => {
  fs.writeFileSync(dataFile(), JSON.stringify(data));
  return true;
});

// ---- Files: attach code to a prompt, save code blocks ----
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

// ---- Auto-update (installed version only; portable builds skip this) ----
let mainWin = null;
const canUpdate = () => app.isPackaged && !process.env.PORTABLE_EXECUTABLE_DIR;
const sendUpdate = (p) => { if (mainWin && !mainWin.isDestroyed()) mainWin.webContents.send('update:status', p); };
const checkNow = () => autoUpdater.checkForUpdates().catch(() => {});

function setupUpdates() {
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.on('update-available', (i) => sendUpdate({ state: 'downloading', version: i.version, percent: 0 }));
  autoUpdater.on('download-progress', (p) => sendUpdate({ state: 'downloading', percent: Math.round(p.percent) }));
  autoUpdater.on('update-downloaded', (i) => sendUpdate({ state: 'ready', version: i.version }));
  autoUpdater.on('update-not-available', () => sendUpdate({ state: 'none' }));
  autoUpdater.on('error', (err) => sendUpdate({ state: 'error', message: err.message }));
  setTimeout(checkNow, 5000);
  setInterval(checkNow, 4 * 60 * 60 * 1000);
}

ipcMain.handle('app:version', () => app.getVersion());
ipcMain.handle('update:check', async () => {
  if (!canUpdate()) return { ok: false, message: 'Updates work in the installed version of the app.' };
  try { await autoUpdater.checkForUpdates(); return { ok: true }; }
  catch (err) { return { ok: false, message: 'Could not check for updates.' }; }
});
ipcMain.on('update:install', () => autoUpdater.quitAndInstall());

// ---- Window ----
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
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://')) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (ev) => ev.preventDefault());
}

app.whenReady().then(() => {
  Menu.setApplicationMenu(Menu.buildFromTemplate([{ role: 'editMenu' }, { role: 'viewMenu' }]));
  createWindow();
  if (canUpdate()) setupUpdates();
  app.on('activate', () => BrowserWindow.getAllWindows().length === 0 && createWindow());
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
