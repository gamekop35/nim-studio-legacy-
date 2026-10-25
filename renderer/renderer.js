'use strict';
const $ = (s) => document.querySelector(s);
const FENCE = '`'.repeat(3);
const EXT = { javascript: 'js', js: 'js', typescript: 'ts', ts: 'ts', python: 'py', py: 'py', html: 'html', css: 'css', json: 'json', bash: 'sh', sh: 'sh', powershell: 'ps1', ps1: 'ps1', java: 'java', c: 'c', cpp: 'cpp', csharp: 'cs', cs: 'cs', go: 'go', rust: 'rs', rs: 'rs', sql: 'sql', yaml: 'yml', yml: 'yml', markdown: 'md', md: 'md' };

const PRESETS = [
  { id: 'coding', name: 'Coding assistant', prompt: 'You are a precise, helpful coding assistant. Give working code in fenced code blocks with the language tag, and keep explanations short.' },
  { id: 'review', name: 'Code reviewer', prompt: 'You are a senior engineer doing a code review. List bugs, security problems and unclear code in order of importance. Give concrete fixes as code. Be concise and direct.' },
  { id: 'debug', name: 'Debugger', prompt: 'You are a debugging expert. Explain the most likely root cause first, then give the smallest fix, then say how to verify it. Ask for missing details only when they are essential.' },
  { id: 'explain', name: 'Explain simply', prompt: 'You explain programming and technical topics to a beginner. Use plain language, short examples and analogies. Define any jargon you use.' },
  { id: 'writer', name: 'Writing helper', prompt: 'You are a careful editor. Improve clarity and tone while keeping the original meaning. Show the revised text first, then briefly list what you changed.' },
  { id: 'custom', name: 'Custom (from Settings)', prompt: null }
];

let chats = [];
let activeId = null;
let settings = {
  model: 'meta/llama-3.3-70b-instruct',
  system: 'You are a precise, helpful coding assistant. Give working code in fenced code blocks and keep explanations short.',
  temperature: 0.4,
  maxTokens: 4096,
  recent: [],
  favorites: [],
  preset: 'coding',
  theme: 'dark'
};
let streaming = null; // { id, chat, msg, t0, stopped }
let attachments = [];
let saveTimer = null;
let chatFilter = '';

const active = () => chats.find((c) => c.id === activeId);

/* ---------- persistence ---------- */
function persist() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => api.saveStore({ chats, settings, activeId }), 400);
}

/* ---------- theme ---------- */
const darkQuery = window.matchMedia('(prefers-color-scheme: dark)');
function applyTheme() {
  const t = settings.theme;
  const dark = t === 'dark' || (t === 'system' && darkQuery.matches);
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
}
darkQuery.addEventListener('change', applyTheme);

/* ---------- syntax highlighting (small built-in highlighter) ---------- */
const KW_ALL = new Set(('as async await break case catch class const continue default delete do else enum export extends false finally for from function if implements import in instanceof interface let new null of private protected public readonly return static super switch this throw true try type typeof undefined var void while with yield ' +
  'and assert def del elif except global is lambda None nonlocal not or pass raise self True False ' +
  'abstract bool char double fn float impl int long mod mut namespace override package pub struct trait unsafe use using virtual where func go defer chan map range select ').split(' ').filter(Boolean));
const KW_SH = new Set('if then else elif fi for foreach while do done case esac function in echo cd export local return exit set unset source alias sudo param true false'.split(' '));
const KW_SQL = new Set('select insert into update delete create table drop alter from where and or not null join left right inner outer on group by order having limit values set as distinct union primary key foreign references index view case when then else end like in is between exists asc desc'.split(' '));
const HASH_LANGS = /^(py|python|sh|bash|shell|zsh|powershell|ps1|yaml|yml|ruby|rb|toml|r|perl|dockerfile|makefile|ini|conf)$/;
const NO_HL = /^(|text|txt|plaintext|plain|output|console|log|markdown|md|diff)$/;
const RE_STR = /"(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'|`(?:\\.|[^`\\])*`/;
const RE_NUM = /\b\d[\w.]*\b/;
const RE_WORD = /\b[A-Za-z_$][\w$]*\b/;
const RE_COMMENT = { c: /\/\/[^\n]*|\/\*[\s\S]*?\*\//, hash: /#[^\n]*/, dash: /--[^\n]*/, html: /<!--[\s\S]*?-->/, css: /\/\*[\s\S]*?\*\// };

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function highlight(code, lang) {
  const l = (lang || '').replace(/^language-/, '');
  if (NO_HL.test(l) || code.length > 30000) return esc(code);
  const isSh = /^(sh|bash|shell|zsh|powershell|ps1)$/.test(l);
  const isSql = l === 'sql';
  const comment = HASH_LANGS.test(l) ? RE_COMMENT.hash
    : isSql ? RE_COMMENT.dash
    : /^(html|xml|svg|vue)$/.test(l) ? RE_COMMENT.html
    : l === 'css' ? RE_COMMENT.css
    : RE_COMMENT.c;
  const kw = isSh ? KW_SH : isSql ? KW_SQL : KW_ALL;
  const re = new RegExp('(' + comment.source + ')|(' + RE_STR.source + ')|(' + RE_NUM.source + ')|(' + RE_WORD.source + ')', 'g');
  let out = '', last = 0, m;
  while ((m = re.exec(code))) {
    const t = m[0];
    out += esc(code.slice(last, m.index));
    const key = isSql ? t.toLowerCase() : t;
    const cls = m[1] ? 'c' : m[2] ? 's' : m[3] ? 'n' : kw.has(key) ? 'k' : /^[A-Z][a-z]/.test(t) ? 't' : '';
    out += cls ? '<span class="tk-' + cls + '">' + esc(t) + '</span>' : esc(t);
    last = m.index + t.length;
  }
  return out + esc(code.slice(last));
}

/* ---------- markdown ---------- */
function inline(s) {
  s = esc(s);
  s = s.replace(/`([^`\n]+)`/g, '<code>$1</code>');
  s = s.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>');
  s = s.replace(/\[([^\]]+)\]\((https:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noreferrer">$1</a>');
  return s;
}

const TABLE_SEP = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;
const cells = (l) => l.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());

function textBlock(text) {
  let out = '', list = null, para = [];
  const flushP = () => { if (para.length) { out += '<p>' + inline(para.join('\n')).replace(/\n/g, '<br>') + '</p>'; para = []; } };
  const flushL = () => { if (list) { out += `</${list}>`; list = null; } };
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    let m;
    if (l.includes('|') && i + 1 < lines.length && TABLE_SEP.test(lines[i + 1])) {
      flushP(); flushL();
      const head = cells(l);
      const rows = [];
      i += 2;
      while (i < lines.length && lines[i].trim() && lines[i].includes('|')) { rows.push(cells(lines[i])); i++; }
      i--;
      out += '<div class="tablewrap"><table><thead><tr>' + head.map((c) => '<th>' + inline(c) + '</th>').join('') +
        '</tr></thead><tbody>' + rows.map((r) => '<tr>' + r.map((c) => '<td>' + inline(c) + '</td>').join('') + '</tr>').join('') + '</tbody></table></div>';
    } else if ((m = l.match(/^(#{1,4})\s+(.*)/))) {
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
    return `<div class="codeblock" data-lang="${esc(lang)}"><div class="codebar"><span class="lang">${esc(lang || 'text')}</span><button class="copy">Copy</button><button class="save">Save as file</button></div><pre><code>${highlight(code, lang)}</code></pre></div>`;
  }).join('');
}

/* ---------- rendering ---------- */
function msgHtml(m, isStreaming) {
  let h = '';
  if (m.reasoning) h += `<details class="think"><summary>Reasoning</summary><div>${esc(m.reasoning)}</div></details>`;
  h += renderMarkdown(m.content || '');
  if (isStreaming && !m.content) h += `<span class="muted">${m.reasoning ? 'Thinking...' : 'Waiting for the model...'}</span>`;
  if (m.error) h += `<div class="msg-error">${esc(m.error)}<button class="ghost open-logs">Open Logs</button></div>`;
  return h;
}

function msgEl(m, isStreaming, idx, isLast) {
  const d = document.createElement('div');
  d.className = 'msg ' + m.role + (isLast ? ' last' : '');
  d.innerHTML = `<div class="who">${m.role === 'user' ? 'You' : 'Assistant'}</div><div class="body${isStreaming ? ' cursor' : ''}">${msgHtml(m, isStreaming)}</div>`;
  if (!isStreaming) {
    const a = document.createElement('div');
    a.className = 'actions';
    let h = `<button class="ghost" data-action="copy" data-idx="${idx}">Copy</button>`;
    if (m.role === 'user') h += `<button class="ghost" data-action="edit" data-idx="${idx}">Edit</button>`;
    else if (isLast) h += `<button class="ghost" data-action="regen" data-idx="${idx}">Regenerate</button>`;
    if (m.role === 'assistant' && m.ms && m.content) h += `<span class="stat">${(m.ms / 1000).toFixed(1)} s, about ${Math.max(1, Math.round(m.content.length / 4))} tokens</span>`;
    a.innerHTML = h;
    d.appendChild(a);
  }
  return d;
}

function renderMessages() {
  const box = $('#messages');
  box.innerHTML = '';
  const chat = active();
  if (!chat || !chat.messages.length) {
    box.innerHTML = '<div class="empty"><h2>What are you working on?</h2><p>Ask a question, paste a stack trace, or attach source files with Attach (or drag them in). Pick a Mode at the top to change how the assistant behaves.</p></div>';
    return;
  }
  const n = chat.messages.length;
  chat.messages.forEach((m, i) => box.appendChild(msgEl(m, !!streaming && streaming.msg === m, i, i === n - 1)));
  box.scrollTop = box.scrollHeight;
}

let raf = 0;
function updateStreaming() {
  if (raf) return;
  raf = requestAnimationFrame(() => {
    raf = 0;
    if (!streaming) return;
    const box = $('#messages');
    const el = box.lastElementChild && box.lastElementChild.querySelector('.body');
    if (!el) return;
    const near = box.scrollHeight - box.scrollTop - box.clientHeight < 120;
    el.innerHTML = msgHtml(streaming.msg, true);
    if (near) box.scrollTop = box.scrollHeight;
  });
}

function startRename(c, span) {
  const inp = document.createElement('input');
  inp.className = 'rename';
  inp.value = c.title;
  span.replaceWith(inp);
  inp.focus(); inp.select();
  let finished = false;
  const done = (save) => {
    if (finished) return;
    finished = true;
    if (save && inp.value.trim()) { c.title = inp.value.trim().slice(0, 80); persist(); }
    renderList();
  };
  inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') done(true); else if (e.key === 'Escape') done(false); });
  inp.addEventListener('blur', () => done(true));
  inp.addEventListener('click', (e) => e.stopPropagation());
}

function renderList() {
  const list = $('#chatList');
  list.innerHTML = '';
  const shown = chats.filter((c) => !chatFilter || c.title.toLowerCase().includes(chatFilter) || c.messages.some((m) => (m.content || '').toLowerCase().includes(chatFilter)));
  if (!shown.length) {
    const n = document.createElement('div');
    n.className = 'note';
    n.textContent = chatFilter ? 'No chats match your search.' : 'No chats yet.';
    list.appendChild(n);
    return;
  }
  shown.forEach((c) => {
    const row = document.createElement('div');
    row.className = 'chat-item' + (c.id === activeId ? ' active' : '');
    row.innerHTML = `<span title="Double-click to rename">${esc(c.title)}</span><button title="Delete chat" aria-label="Delete chat">×</button>`;
    row.addEventListener('click', () => selectChat(c.id));
    row.querySelector('span').addEventListener('dblclick', (e) => { e.stopPropagation(); startRename(c, e.currentTarget); });
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
  if (id === activeId) { $('#input').focus(); return; }
  activeId = id;
  renderList(); renderMessages(); persist();
  $('#input').focus();
}

function deleteChat(id) {
  if (streaming) return;
  chats = chats.filter((c) => c.id !== id);
  if (!chats.length) { activeId = null; return newChat(); }
  if (activeId === id) activeId = chats[0].id;
  renderList(); renderMessages(); persist();
}

/* ---------- sending ---------- */
const systemPrompt = () => {
  const p = PRESETS.find((x) => x.id === settings.preset) || PRESETS[0];
  return p.prompt === null ? settings.system : p.prompt;
};

function setBusy(busy) {
  const b = $('#send');
  b.textContent = busy ? 'Stop' : 'Send';
  b.classList.toggle('primary', !busy);
}

function stopStream() {
  if (!streaming) return;
  streaming.stopped = true;
  api.stop(streaming.id);
}

function startStream(chat) {
  const msg = { role: 'assistant', content: '', reasoning: '' };
  chat.messages.push(msg);
  const history = chat.messages.slice(0, -1).filter((m) => m.content).map(({ role, content }) => ({ role, content }));
  const sys = systemPrompt().trim();
  if (sys) history.unshift({ role: 'system', content: sys });

  const id = crypto.randomUUID();
  streaming = { id, chat, msg, t0: Date.now(), stopped: false };
  setBusy(true); renderList(); renderMessages();
  api.stream(id, { model: settings.model, messages: history, temperature: settings.temperature, max_tokens: settings.maxTokens });
}

function send() {
  if (streaming) { stopStream(); return; }
  const input = $('#input');
  const text = input.value.trim();
  if (!text && !attachments.length) return;

  let content = text;
  for (const a of attachments) {
    const ext = (a.name.split('.').pop() || '').toLowerCase();
    content += `\n\n${a.name}\n${FENCE}${ext}\n${a.content}\n${FENCE}`;
  }
  const chat = active();
  if (!chat) return;
  if (!chat.messages.length) chat.title = (text || attachments[0].name).slice(0, 48);
  chat.messages.push({ role: 'user', content: content.trim() });

  input.value = ''; input.style.height = 'auto';
  attachments = []; renderChips();
  startStream(chat);
}

function finish() {
  const s = streaming;
  streaming = null;
  if (s) {
    s.msg.ms = Date.now() - s.t0;
    if (!s.msg.content && !s.msg.error && !s.stopped) {
      s.msg.error = 'The model returned no answer text. If it is a reasoning model, raise Max response tokens in Settings, or try another model.';
    }
  }
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

/* ---------- message actions (copy, edit, regenerate) ---------- */
async function flash(btn, text) {
  const old = btn.textContent;
  btn.textContent = text;
  setTimeout(() => (btn.textContent = old), 1200);
}

$('#messages').addEventListener('click', async (e) => {
  if (e.target.classList.contains('open-logs')) { openLogsDialog(); return; }

  const act = e.target.closest('[data-action]');
  if (act) {
    const chat = active();
    const idx = parseInt(act.dataset.idx, 10);
    if (!chat || !chat.messages[idx]) return;
    const m = chat.messages[idx];
    if (act.dataset.action === 'copy') {
      await navigator.clipboard.writeText(m.content || '');
      flash(act, 'Copied');
    } else if (act.dataset.action === 'edit' && !streaming) {
      const input = $('#input');
      input.value = m.content;
      chat.messages.splice(idx);
      renderMessages(); persist();
      input.dispatchEvent(new Event('input'));
      input.focus();
    } else if (act.dataset.action === 'regen' && !streaming && idx === chat.messages.length - 1) {
      chat.messages.pop();
      startStream(chat);
    }
    return;
  }

  const block = e.target.closest('.codeblock');
  if (!block) return;
  const code = block.querySelector('code').textContent;
  if (e.target.classList.contains('copy')) {
    await navigator.clipboard.writeText(code);
    flash(e.target, 'Copied');
  } else if (e.target.classList.contains('save')) {
    await api.saveFile('snippet.' + (EXT[block.dataset.lang] || 'txt'), code);
  }
});

/* ---------- events ---------- */
$('#send').addEventListener('click', send);
$('#newChat').addEventListener('click', newChat);
$('#chatSearch').addEventListener('input', (e) => { chatFilter = e.target.value.trim().toLowerCase(); renderList(); });

const input = $('#input');
input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(); }
});
input.addEventListener('input', () => { input.style.height = 'auto'; input.style.height = Math.min(input.scrollHeight, 220) + 'px'; });

document.addEventListener('keydown', (e) => {
  if ($('#app').classList.contains('hidden')) return;
  const k = e.key.toLowerCase();
  if (e.ctrlKey && k === 'n') { e.preventDefault(); newChat(); }
  else if (e.ctrlKey && k === 'k') { e.preventDefault(); openMenu(); }
  else if (e.ctrlKey && k === 'l') { e.preventDefault(); $('#input').focus(); }
  else if (e.key === 'Escape' && streaming && e.target.id !== 'modelSearch' && !document.querySelector('dialog[open]')) stopStream();
});

/* attach files: button and drag and drop */
function note(text) { $('#status').textContent = text; }

async function addFiles(files) {
  for (const f of files) {
    if (f.size > 400 * 1024) { note(f.name + ': larger than 400 KB.'); continue; }
    let text = '';
    try { text = await f.text(); } catch { note(f.name + ': could not be read.'); continue; }
    if (text.includes('\u0000')) { note(f.name + ': not a text file.'); continue; }
    attachments.push({ name: f.name, content: text });
  }
  renderChips();
}

$('#attach').addEventListener('click', async () => {
  const files = await api.openFiles();
  const bad = files.filter((f) => f.error);
  attachments.push(...files.filter((f) => !f.error));
  renderChips();
  if (bad.length) note(bad.map((f) => `${f.name}: ${f.error}`).join(' '));
});
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => {
  e.preventDefault();
  if ($('#app').classList.contains('hidden') || !e.dataTransfer) return;
  addFiles([...e.dataTransfer.files]);
});

/* export chat as markdown */
$('#exportChat').addEventListener('click', async () => {
  const chat = active();
  if (!chat || !chat.messages.length) { note('Nothing to export yet.'); return; }
  const md = '# ' + chat.title + '\n\n' + chat.messages
    .map((m) => '## ' + (m.role === 'user' ? 'You' : 'Assistant') + '\n\n' + (m.content || '') + '\n')
    .join('\n');
  const name = chat.title.replace(/[^\w\- ]+/g, '').trim().slice(0, 40) || 'chat';
  const ok = await api.saveFile(name + '.md', md);
  if (ok) note('Chat exported.');
});

/* ---------- mode (presets) ---------- */
function buildPresetSelect() {
  const sel = $('#preset');
  sel.innerHTML = '';
  PRESETS.forEach((p) => { const o = document.createElement('option'); o.value = p.id; o.textContent = p.name; sel.appendChild(o); });
  sel.value = settings.preset;
  sel.addEventListener('change', () => { settings.preset = sel.value; persist(); });
}

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
  const match = (id) => !q || id.toLowerCase().includes(q);
  const ids = allModels.filter((id) => (showAllModels || !NON_CHAT.test(id)) && match(id));
  const out = [];
  const favs = settings.favorites.filter(match);
  if (favs.length) out.push({ title: 'Favorites', ids: favs, pub: true });
  const recent = settings.recent.filter((id) => match(id) && !settings.favorites.includes(id));
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
  const left = document.createElement('span');
  left.className = 'opt-l';
  if (!label) {
    const fav = settings.favorites.includes(id);
    const st = document.createElement('span');
    st.className = 'star' + (fav ? ' on' : '');
    st.textContent = fav ? '\u2605' : '\u2606';
    st.title = fav ? 'Remove from favorites' : 'Add to favorites';
    left.appendChild(st);
  }
  const n = document.createElement('span');
  n.textContent = label || shortName(id);
  left.appendChild(n);
  d.appendChild(left);
  if (showPub && !label) {
    const p = document.createElement('span');
    p.className = 'p';
    p.textContent = publisher(id);
    d.appendChild(p);
  }
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
function toggleFav(id) {
  const f = settings.favorites;
  const i = f.indexOf(id);
  if (i >= 0) f.splice(i, 1); else f.unshift(id);
  persist();
  const box = $('#modelScroll');
  const top = box.scrollTop;
  renderMenu();
  box.scrollTop = top;
}

$('#modelBtn').addEventListener('click', () => ($('#modelMenu').classList.contains('hidden') ? openMenu() : closeMenu()));
$('#modelSearch').addEventListener('input', renderMenu);
$('#modelSearch').addEventListener('keydown', (e) => {
  if (e.key === 'ArrowDown') { e.preventDefault(); setHl(hl + 1); }
  else if (e.key === 'ArrowUp') { e.preventDefault(); setHl(hl - 1); }
  else if (e.key === 'Enter') { e.preventDefault(); if (optEls[hl]) chooseModel(optEls[hl].dataset.id); }
  else if (e.key === 'Escape') { closeMenu(); $('#modelBtn').focus(); }
});
$('#modelScroll').addEventListener('click', (e) => {
  const o = e.target.closest('.opt');
  if (!o) return;
  if (e.target.classList.contains('star')) toggleFav(o.dataset.id);
  else chooseModel(o.dataset.id);
});
$('#showAll').addEventListener('change', (e) => { showAllModels = e.target.checked; renderMenu(); });
document.addEventListener('click', (e) => {
  if (!e.composedPath().some((el) => el.classList && el.classList.contains('picker'))) closeMenu();
});

/* ---------- settings ---------- */
const dlg = $('#settings');
$('#openSettings').addEventListener('click', () => {
  $('#sysPrompt').value = settings.system;
  $('#temp').value = settings.temperature;
  $('#tempVal').textContent = settings.temperature;
  $('#maxTok').value = settings.maxTokens;
  $('#theme').value = settings.theme;
  $('#updateMsg').textContent = '';
  dlg.showModal();
});
$('#temp').addEventListener('input', (e) => ($('#tempVal').textContent = e.target.value));
$('#settingsCancel').addEventListener('click', () => dlg.close());
$('#settingsSave').addEventListener('click', () => {
  settings.system = $('#sysPrompt').value;
  settings.temperature = parseFloat($('#temp').value);
  settings.maxTokens = Math.max(64, parseInt($('#maxTok').value, 10) || 4096);
  settings.theme = $('#theme').value;
  applyTheme(); persist(); dlg.close();
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

/* ---------- logs ---------- */
const logView = $('#logView');
const logCache = [];
let unseenErrors = 0;

const fmtTime = (t) => { const d = new Date(t); return d.toTimeString().slice(0, 8) + '.' + String(d.getMilliseconds()).padStart(3, '0'); };

function addLog(e, silent) {
  const stamp = fmtTime(e.t) + ' ' + e.level.toUpperCase().padEnd(5) + ' ';
  logCache.push(stamp + e.msg);
  const line = document.createElement('div');
  line.className = 'log-line log-' + e.level;
  const t = document.createElement('span');
  t.className = 'log-time';
  t.textContent = stamp;
  line.appendChild(t);
  line.appendChild(document.createTextNode(e.msg));
  const near = logView.scrollHeight - logView.scrollTop - logView.clientHeight < 80;
  logView.appendChild(line);
  if (near) logView.scrollTop = logView.scrollHeight;
  if (!silent && e.level === 'error' && !$('#logs').open) {
    unseenErrors++;
    $('#openLogs').textContent = 'Logs (' + unseenErrors + ')';
  }
}

function openLogsDialog() {
  unseenErrors = 0;
  $('#openLogs').textContent = 'Logs';
  if (!$('#logs').open) $('#logs').showModal();
  logView.scrollTop = logView.scrollHeight;
}

api.onLog((e) => addLog(e, false));
api.listLogs().then((list) => list.forEach((e) => addLog(e, true)));
$('#openLogs').addEventListener('click', openLogsDialog);
$('#closeLogs').addEventListener('click', () => $('#logs').close());
$('#clearLogs').addEventListener('click', async () => { await api.clearLogs(); logView.innerHTML = ''; logCache.length = 0; });
$('#openLogFile').addEventListener('click', () => api.showLogFile());
$('#copyLogs').addEventListener('click', async () => {
  await navigator.clipboard.writeText(logCache.join('\n'));
  flash($('#copyLogs'), 'Copied');
});
$('#runTest').addEventListener('click', async () => {
  const b = $('#runTest');
  b.disabled = true; b.textContent = 'Testing...';
  try { await api.runTest(settings.model); } finally { b.disabled = false; b.textContent = 'Run connection test'; }
});
window.addEventListener('error', (e) => api.logRenderer('error', e.message + ' (' + (e.filename || '').split('/').pop() + ':' + e.lineno + ')'));
window.addEventListener('unhandledrejection', (e) => api.logRenderer('error', 'Unhandled: ' + (e.reason && e.reason.message ? e.reason.message : e.reason)));

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
  if (!Array.isArray(settings.favorites)) settings.favorites = [];
  if (!Array.isArray(settings.recent)) settings.recent = [];
  if (!PRESETS.some((p) => p.id === settings.preset)) settings.preset = 'coding';
  buildPresetSelect();
  applyTheme();
  if (await api.keyStatus()) showApp(); else showSetup();
})();
