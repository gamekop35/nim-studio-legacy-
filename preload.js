const { contextBridge, ipcRenderer } = require('electron');

const call = (ch) => (...a) => ipcRenderer.invoke(ch, ...a);
const on = (ch) => (cb) => ipcRenderer.on(ch, (_e, id, payload) => cb(id, payload));

contextBridge.exposeInMainWorld('api', {
  keyStatus: call('key:status'),
  setKey: call('key:set'),
  clearKey: call('key:clear'),
  models: call('models:list'),
  loadStore: call('store:load'),
  saveStore: call('store:save'),
  openFiles: call('file:open'),
  saveFile: call('file:save'),
  stream: (id, body) => ipcRenderer.send('chat:stream', id, body),
  stop: (id) => ipcRenderer.send('chat:stop', id),
  onChunk: on('chat:chunk'),
  onDone: on('chat:done'),
  onError: on('chat:error'),
  appVersion: call('app:version'),
  checkUpdate: call('update:check'),
  installUpdate: () => ipcRenderer.send('update:install'),
  onUpdate: (cb) => ipcRenderer.on('update:status', (_e, p) => cb(p))
});
