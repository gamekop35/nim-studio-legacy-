'use strict';
const $ = (s) => document.querySelector(s);
const FENCE = '`'.repeat(3);
const EXT = { javascript: 'js', js: 'js', typescript: 'ts', ts: 'ts', python: 'py', py: 'py', html: 'html', css: 'css', json: 'json', bash: 'sh', sh: 'sh', powershell: 'ps1', ps1: 'ps1', java: 'java', c: 'c', cpp: 'cpp', csharp: 'cs', cs: 'cs', go: 'go', rust: 'rs', rs: 'rs', sql: 'sql', yaml: 'yml', yml: 'yml', markdown: 'md', md: 'md' };

let chats = [];
let activeId = null;
let settings = {
  model: 'meta/llama-3.3-70b-instruct',
  system: 'You are a precise, helpful coding assistant. Give working code in fenced code blocks and keep explanations short.',
  temperature: 0.4,
  maxTokens: 4096,
  recent: []
};
let streaming = null; // { id, chat, msg }
let attachments = [];
let saveTimer = null;

const active = () => chats.find((c) => c.id === activeId);

/* ---------- persistence ---------- */
function persist() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => api.saveStore({ chats, settings, activeId }), 400);
}

/* ---------- markdown ---------- */
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function inline(s) {
  s = esc(s);
  s = s.replace(/`([^`\n]+)`/g, '<code>$1</code>');
  s = s.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>');
  s = s.replace(/\[([^\]]+)\]\((https:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noreferrer">$1</a>');
  return s;
}

function textBlock(text) {
  let out = '', list = null, para = [];
  const flushP = () => { if (para.length) { out += '<p>' + inline(para.join('\n')).replace(/\n/g, '<br>') + '</p>'; para = []; } };
  const flushL = () => { if (list) { out += `</${list}>`; list = null; } };
  for (const l of text.split('\n')) {
    let m;
    if ((m = l.match(/^(#{1,4})\s+(.*)/))) {
      flushP(); flushL();
      const n = m[1].length + 1;
      out += `<h${n}>${inline(m[2])}</h${n}>`;
    } else if ((m = l.match(/^\s*[-*]\s+(.*)/))) {
      flushP();
      if (list !== 'ul') { flushL(); out += '<ul>'; list = 'ul'; }
      out += '<li>' + inline(m[1]) + '</li>';
    } else if ((m = l.match(/^\s*\d+[.)]\s+(.*)/))) {
      flushP();
      if (list !== 'ol') { flushL(); out += '<ol>'; list = 'ol'; }
      out += '<li>' + inline(m[1]) + '</li>';
    } else if (!l.trim()) {
      flushP(); flushL();
    } else {
      flushL(); para.push(l);
    }
  }
  flushP(); flushL();
  return out;
}

function renderMarkdown(text) {
  const re = new RegExp('(' + FENCE + '[\\s\\S]*?(?:' + FENCE + '|$))', 'g');
  return text.split(re).map((part) => {
    if (!part.startsWith(FENCE)) return textBlock(part);
    const nl = part.indexOf('\n');
    const lang = (nl < 0 ? part.slice(3) : part.slice(3, nl)).trim().toLowerCase();
    let code = nl < 0 ? '' : part.slice(nl + 1);
    code = code.replace(new RegExp('\\n?' + FENCE + '$'), '');
    return `<div class="codeblock" data-lang="${esc(lang)}"><div class="codebar"><span class="lang">${esc(lang || 'text')}</span><button class="copy">Copy</button><button class="save">Save as file</button></div><pre><code>${esc(code)}</code></pre></div>`;
  }).join('');
}

/* ---------- rendering ---------- */
function msgHtml(m, isStreaming) {
  let h = '';
  if (m.reasoning) h += `<details class="think"><summary>Reasoning</summary><div>${esc(m.reasoning)}</div></details>`;
  h += renderMarkdown(m.content || '');
  if (m.error) h += `<div class="msg-error">${esc(m.error)}</div>`;
  return h;
}

function msgEl(m, isStreaming) {
  const d = document.createElement('div');
  d.className = 'msg ' + m.role;
  d.innerHTML = `<div class="who">${m.role === 'user' ? 'You' : 'Assistant'}</div><div class="body${isStreaming ? ' cursor' : ''}">${msgHtml(m)}</div>`;
  return d;
}

function renderMessages() {
  const box = $('#messages');
  box.innerHTML = '';
  const chat = active();
  if (!chat || !chat.messages.length) {
    box.innerHTML = '<div class="empty"><h2>What are you working on?</h2><p>Ask a question, paste a stack trace, or attach source files with Attach. Code in replies can be copied or saved as a file.</p></div>';
    return;
  }
  chat.messages.forEach((m) => box.appendChild(msgEl(m, streaming && streaming.msg === m)));
  box.scrollTop = box.scrollHeight;
}

let raf = 0;
function updateStreaming() {
  if (raf) return;
  raf = requestAnimationFrame(() => {
    raf = 0;
    if (!streaming) return;
    const box = $('#messages');
    const el = box.lastElementChild?.querySelector('.body');
    if (!el) return;
    const near = box.scrollHeight - box.scrollTop - box.clientHeight < 120;
    el.innerHTML = msgHtml(streaming.msg);
    if (near) box.scrollTop = box.scrollHeight;
  });
}

function renderList() {
  const list = $('#chatList');
  list.innerHTML = '';
  chats.forEach((c) => {
    const row = document.createElement('div');
    row.className = 'chat-item' + (c.id === activeId ? ' active' : '');
    row.innerHTML = `<span>${esc(c.title)}</span><button title="Delete chat" aria-label="Delete chat">×</button>`;
    row.addEventListener('click', () => selectChat(c.id));
    row.querySelector('button').addEventListener('click', (e) => { e.stopPropagation(); deleteChat(c.id); });
    list.appendChild(row);
  });
}

function renderChips() {
  const box = $('#chips');
  box.innerHTML = '';
  attachments.forEach((a, i) => {
    const chip = document.createElement('span');
    chip.className = 'chip';
    chip.innerHTML = `${esc(a.name)}<button aria-label="Remove ${esc(a.name)}">×</button>`;
    chip.querySelector('button').addEventListener('click', () => { attachments.splice(i, 1); renderChips(); });
    box.appendChild(chip);
  });
}

/* ---------- chats ---------- */
function newChat() {
  if (streaming) return;
  const existing = chats.find((c) => !c.messages.length);
  if (existing) return selectChat(existing.id);
  const c = { id: crypto.randomUUID(), title: 'New chat', messages: [] };
  chats.unshift(c);
  selectChat(c.id);
}

function selectChat(id) {
  if (streaming) return;
  activeId = id;
  renderList(); renderMessages(); persist();
  $('#input').focus();
}

function deleteChat(id) {
  if (streaming) return;
  chats = chats.filter((c) => c.id !== id);
  if (!chats.length) return newChat();
  if (activeId === id) activeId = chats[0].id;
  renderList(); renderMessages(); persist();
}

/* ---------- sending ---------- */
function setBusy(busy) {
  const b = $('#send');
  b.textContent = busy ? 'Stop' : 'Send';
  b.classList.toggle('primary', !busy);
}

function send() {
  if (streaming) { api.stop(streaming.id); return; }
  const input = $('#input');
  const text = input.value.trim();
  if (!text && !attachments.length) return;

  let content = text;
  for (const a of attachments) {
    const ext = (a.name.split('.').pop() || '').toLowerCase();
    content += `\n\n${a.name}\n${FENCE}${ext}\n${a.content}\n${FENCE}`;
  }
  const chat = active();
  if (!chat.messages.length) chat.title = (text || attachments[0].name).slice(0, 48);
  chat.messages.push({ role: 'user', content: content.trim() });
  const msg = { role: 'assistant', content: '', reasoning: '' };
  chat.messages.push(msg);

  input.value = ''; input.style.height = 'auto';
  attachments = []; renderChips();

  const history = chat.messages.slice(0, -1).filter((m) => m.content).map(({ role, content }) => ({ role, content }));
  if (settings.system.trim()) history.unshift({ role: 'system', content: settings.system.trim() });

  const id = crypto.randomUUID();
  streaming = { id, chat, msg };
  setBusy(true); renderList(); renderMessages();
  api.stream(id, { model: settings.model, messages: history, temperature: settings.temperature, max_tokens: settings.maxTokens });
}

function finish() {
  streaming = null;
  setBusy(false); renderMessages(); persist();
  $('#input').focus();
}

api.onChunk((id, p) => {
  if (!streaming || streaming.id !== id) return;
  streaming.msg.content += p.c;
  streaming.msg.reasoning += p.r;
  updateStreaming();
});
api.onDone((id) => { if (streaming && streaming.id === id) finish(); });
api.onError((id, err) => {
  if (!streaming || streaming.id !== id) return;
  streaming.msg.error = err;
  finish();
});

/* ---------- events ---------- */
$('#send').addEventListener('click', send);
$('#newChat').addEventListener('click', newChat);

const input = $('#input');
input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(); }
});
input.addEventListener('input', () => { input.style.height = 'auto'; input.style.height = Math.min(input.scrollHeight, 220) + 'px'; });
document.addEventListener('keydown', (e) => { if (e.ctrlKey && e.key.toLowerCase() === 'n') { e.preventDefault(); newChat(); } });

$('#attach').addEventListener('click', async () => {
  const files = await api.openFiles();
  const bad = files.filter((f) => f.error);
  attachments.push(...files.filter((f) => !f.error));
  renderChips();
  if (bad.length) $('#status').textContent = bad.map((f) => `${f.name}: ${f.error}`).join(' ');
});

$('#messages').addEventListener('click', async (e) => {
  const block = e.target.closest('.codeblock');
  if (!block) return;
  const code = block.querySelector('code').textContent;
  if (e.target.classList.contains('copy')) {
    await navigator.clipboard.writeText(code);
    e.target.textContent = 'Copied';
    setTimeout(() => (e.target.textContent = 'Copy'), 1200);
  } else if (e.target.classList.contains('save')) {
    const lang = block.dataset.lang;
    await api.saveFile('snippet.' + (EXT[lang] || 'txt'), code);
  }
});

/* ---------- model picker ---------- */
const NON_CHAT = /embed|rerank|retriev|guard|safety|reward|parse|clip|vila|paligemma|neva|kosmos|fuyu|deplot|riva|tts|asr|stable-diffusion|sdxl|flux|cosmos|esm2|alphafold|molmim|genmol|diffdock|boltz|openfold|corrdiff|fourcastnet|maxine|audio2face|translate|nv-yolo|ocdrnet|bevformer/i;
const CODING = /code|coder|codestral|starcoder|devstral/i;
const THINKING = /(^|[-/_])r1([-/_.]|$)|reason|qwq|thinking/i;
const PUBS = { meta: 'Meta', nvidia: 'NVIDIA', mistralai: 'Mistral AI', 'deepseek-ai': 'DeepSeek', qwen: 'Qwen', google: 'Google', microsoft: 'Microsoft', ibm: 'IBM', openai: 'OpenAI', moonshotai: 'Moonshot AI', abacusai: 'Abacus AI', databricks: 'Databricks', snowflake: 'Snowflake', writer: 'Writer', '01-ai': '01.AI' };

let allModels = [];
let showAllModels = false;
let optEls = [];
let hl = -1;

const publisher = (id) => { const p = id.split('/')[0]; return PUBS[p] || p.charAt(0).toUpperCase() + p.slice(1); };
const shortName = (id) => (id.includes('/') ? id.split('/').slice(1).join('/') : id);
const setModelLabel = () => { $('#modelLabel').textContent = settings.model; };

function sectionsFor(query) {
  const q = query.trim().toLowerCase();
  let ids = allModels.filter((id) => showAllModels || !NON_CHAT.test(id));
  if (q) ids = ids.filter((id) => id.toLowerCase().includes(q));
  const out = [];
  const recent = settings.recent.filter((id) => !q || id.toLowerCase().includes(q));
  if (recent.length) out.push({ title: 'Recent', ids: recent, pub: true });
  const coding = ids.filter((id) => CODING.test(id));
  const thinking = ids.filter((id) => !CODING.test(id) && THINKING.test(id));
  if (coding.length) out.push({ title: 'Coding', ids: coding, pub: true });
  if (thinking.length) out.push({ title: 'Reasoning', ids: thinking, pub: true });
  const byPub = {};
  ids.filter((id) => !CODING.test(id) && !THINKING.test(id)).forEach((id) => { (byPub[publisher(id)] ||= []).push(id); });
  Object.keys(byPub).sort((a, b) => a.localeCompare(b)).forEach((k) => out.push({ title: k, ids: byPub[k], pub: false }));
  return out;
}

function optEl(id, showPub, label) {
  const d = document.createElement('div');
  d.className = 'opt' + (id === settings.model ? ' sel' : '');
  d.dataset.id = id;
  d.setAttribute('role', 'option');
  d.title = id;
  const n = document.createElement('span');
  n.textContent = label || (showPub ? shortName(id) : shortName(id));
  d.appendChild(n);
  if (showPub && !label) { const p = document.createElement('span'); p.className = 'p'; p.textContent = publisher(id); d.appendChild(p); }
  optEls.push(d);
  return d;
}

function setHl(i) {
  if (hl >= 0 && optEls[hl]) optEls[hl].classList.remove('hl');
  hl = Math.max(0, Math.min(i, optEls.length - 1));
  if (optEls[hl]) { optEls[hl].classList.add('hl'); optEls[hl].scrollIntoView({ block: 'nearest' }); }
}

function renderMenu() {
  const q = $('#modelSearch').value;
  const box = $('#modelScroll');
  box.innerHTML = '';
  optEls = []; hl = -1;
  const secs = sectionsFor(q);
  secs.forEach((s) => {
    const h = document.createElement('div');
    h.className = 'sec';
    h.textContent = s.title;
    box.appendChild(h);
    s.ids.forEach((id) => box.appendChild(optEl(id, s.pub)));
  });
  const custom = q.trim();
  if (custom && !allModels.includes(custom)) {
    const h = document.createElement('div');
    h.className = 'sec';
    h.textContent = 'Custom';
    box.appendChild(h);
    box.appendChild(optEl(custom, false, 'Use "' + custom + '" as the model id'));
    optEls[optEls.length - 1].dataset.id = custom;
  }
  if (!optEls.length) {
    const n = document.createElement('div');
    n.className = 'menu-note';
    n.textContent = allModels.length ? 'No models match your search.' : 'The model list has not loaded yet. Type a model id to use it.';
    box.appendChild(n);
  }
  const selIdx = optEls.findIndex((o) => o.classList.contains('sel'));
  setHl(q.trim() ? 0 : selIdx >= 0 ? selIdx : 0);
  if (!q.trim() && selIdx >= 0) optEls[selIdx].scrollIntoView({ block: 'center' });
}

function openMenu() {
  $('#modelMenu').classList.remove('hidden');
  $('#modelBtn').setAttribute('aria-expanded', 'true');
  $('#modelSearch').value = '';
  renderMenu();
  $('#modelSearch').focus();
}
function closeMenu() {
  $('#modelMenu').classList.add('hidden');
  $('#modelBtn').setAttribute('aria-expanded', 'false');
}
function chooseModel(id) {
  settings.model = id;
  settings.recent = [id, ...settings.recent.filter((x) => x !== id)].slice(0, 5);
  setModelLabel(); closeMenu(); persist();
  $('#input').focus();
}

$('#modelBtn').addEventListener('click', () => ($('#modelMenu').classList.contains('hidden') ? openMenu() : closeMenu()));
$('#modelSearch').addEventListener('input', renderMenu);
$('#modelSearch').addEventListener('keydown', (e) => {
  if (e.key === 'ArrowDown') { e.preventDefault(); setHl(hl + 1); }
  else if (e.key === 'ArrowUp') { e.preventDefault(); setHl(hl - 1); }
  else if (e.key === 'Enter') { e.preventDefault(); if (optEls[hl]) chooseModel(optEls[hl].dataset.id); }
  else if (e.key === 'Escape') { closeMenu(); $('#modelBtn').focus(); }
});
$('#modelScroll').addEventListener('click', (e) => { const o = e.target.closest('.opt'); if (o) chooseModel(o.dataset.id); });
$('#showAll').addEventListener('change', (e) => { showAllModels = e.target.checked; renderMenu(); });
document.addEventListener('click', (e) => { if (!e.target.closest('.picker')) closeMenu(); });

/* ---------- settings ---------- */
const dlg = $('#settings');
$('#openSettings').addEventListener('click', () => {
  $('#sysPrompt').value = settings.system;
  $('#temp').value = settings.temperature;
  $('#tempVal').textContent = settings.temperature;
  $('#maxTok').value = settings.maxTokens;
  $('#updateMsg').textContent = '';
  dlg.showModal();
});
$('#temp').addEventListener('input', (e) => ($('#tempVal').textContent = e.target.value));
$('#settingsCancel').addEventListener('click', () => dlg.close());
$('#settingsSave').addEventListener('click', () => {
  settings.system = $('#sysPrompt').value;
  settings.temperature = parseFloat($('#temp').value);
  settings.maxTokens = Math.max(64, parseInt($('#maxTok').value, 10) || 4096);
  persist(); dlg.close();
});
$('#changeKey').addEventListener('click', async () => {
  dlg.close();
  await api.clearKey();
  showSetup();
});

/* ---------- setup / boot ---------- */
function showSetup() {
  $('#app').classList.add('hidden');
  $('#setup').classList.remove('hidden');
  $('#keyInput').value = '';
  $('#keyInput').focus();
}

async function saveKey() {
  const r = await api.setKey($('#keyInput').value);
  const err = $('#setupError');
  if (!r.ok) { err.textContent = r.error; err.classList.remove('hidden'); return; }
  err.classList.add('hidden');
  showApp();
}
$('#keySave').addEventListener('click', saveKey);
$('#keyInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') saveKey(); });

async function loadModels() {
  const r = await api.models();
  const status = $('#status');
  if (!r.ok) { status.textContent = r.error; return; }
  allModels = r.models;
  status.textContent = allModels.filter((id) => !NON_CHAT.test(id)).length + ' chat models';
}

function showApp() {
  $('#setup').classList.add('hidden');
  $('#app').classList.remove('hidden');
  setModelLabel();
  if (!chats.length) newChat(); else { if (!active()) activeId = chats[0].id; renderList(); renderMessages(); }
  loadModels();
  $('#input').focus();
}

/* ---------- updates ---------- */
api.onUpdate((p) => {
  const banner = $('#updateBanner');
  if (p.state === 'downloading') {
    banner.classList.remove('hidden');
    $('#updateText').textContent = 'Downloading update' + (p.version ? ' ' + p.version : '') + '... ' + (p.percent || 0) + '%';
    $('#updateRestart').classList.add('hidden');
  } else if (p.state === 'ready') {
    banner.classList.remove('hidden');
    $('#updateText').textContent = 'Version ' + p.version + ' is ready to install.';
    $('#updateRestart').classList.remove('hidden');
  } else if (p.state === 'none') {
    $('#updateMsg').textContent = 'You have the latest version.';
  } else if (p.state === 'error') {
    $('#updateMsg').textContent = 'Could not check for updates.';
  }
});
$('#updateRestart').addEventListener('click', () => api.installUpdate());
$('#checkUpdate').addEventListener('click', async () => {
  $('#updateMsg').textContent = 'Checking...';
  const r = await api.checkUpdate();
  if (!r.ok) $('#updateMsg').textContent = r.message;
});
api.appVersion().then((v) => ($('#version').textContent = v));

(async function init() {
  const d = await api.loadStore();
  chats = d.chats || [];
  activeId = d.activeId || null;
  Object.assign(settings, d.settings || {});
  if (await api.keyStatus()) showApp(); else showSetup();
})();
