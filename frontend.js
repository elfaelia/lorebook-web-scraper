/**
 * Lorebook Web Scraper — frontend module. v1.9
 *
 * Registers a drawer tab. Pick a lorebook, paste URLs, press the button.
 * Each page is fetched by the backend through the CORS proxy, converted to
 * text here in the browser with DOMParser, and written back as one entry.
 *
 * The status box sits at the top of the panel so errors are the first thing
 * visible, not something buried below the fold on a phone.
 */

const ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M4 5.5A2.5 2.5 0 0 1 6.5 3H19v15H6.5A2.5 2.5 0 0 0 4 20.5z"/><path d="M9 7.5h6"/><path d="M9 11h6"/><path d="M9 14.5h3"/></svg>';

/* ------------------------------------------------------------------ */
/* HTML to text                                                        */
/* ------------------------------------------------------------------ */

const STRIP = [
  'script', 'style', 'noscript', 'svg', 'canvas', 'iframe', 'form', 'button',
  'select', 'textarea', 'input', 'nav', 'footer', 'aside', 'template',
  '[aria-hidden="true"]', '[role="navigation"]', '[role="banner"]', '[role="complementary"]',
  '.mw-editsection', '.reference', '.references', '.navbox', '.toc', '#toc', '#siteSub',
  '.sidebar', '.mw-jump-link', '.noprint', '.metadata', '.hatnote', '.portal',
  '.global-navigation', '.wds-global-footer', '.page-side-tools', '.page-header__actions',
  '.notifications-placeholder', '.advertisement', '.cookie-banner',
].join(',');

const MAIN_CANDIDATES = [
  '.mw-parser-output', '#mw-content-text', 'main', 'article', '[role="main"]',
  '.page-content', '.post-content', '.entry-content', '#bodyContent', '#content',
];

const inline = (el) => (el.textContent || '').replace(/\s+/g, ' ').trim();

function pickMain(doc) {
  let best = doc.body;
  let bestLength = ((doc.body && doc.body.textContent) || '').length * 0.4;
  for (const selector of MAIN_CANDIDATES) {
    for (const el of doc.querySelectorAll(selector)) {
      const length = (el.textContent || '').length;
      if (length > bestLength) { best = el; bestLength = length; }
    }
  }
  return best;
}

function tableToText(table) {
  const rows = [];
  for (const tr of table.querySelectorAll('tr')) {
    const cells = Array.from(tr.querySelectorAll('th,td')).map(inline).filter(Boolean);
    if (cells.length) rows.push(cells.join(' | '));
  }
  return rows.length ? `\n\n${rows.join('\n')}\n\n` : '';
}

function listToText(list, options, depth) {
  let out = '\n';
  let index = 0;
  for (const li of Array.from(list.children).filter((c) => c.tagName === 'LI')) {
    index++;
    const nested = Array.from(li.children).filter((c) => c.tagName === 'UL' || c.tagName === 'OL');
    nested.forEach((n) => n.remove());
    const marker = list.tagName === 'OL' ? `${index}.` : '-';
    const text = inline(li);
    if (text) out += `${'  '.repeat(depth)}${marker} ${text}\n`;
    for (const sub of nested) out += listToText(sub, options, depth + 1);
  }
  return `${out}\n`;
}

function nodeToText(node, options, depth) {
  if (node.nodeType === 3) return (node.nodeValue || '').replace(/\s+/g, ' ');
  if (node.nodeType !== 1) return '';

  const children = () => Array.from(node.childNodes).map((n) => nodeToText(n, options, depth)).join('');

  switch (node.tagName) {
    case 'BR': return '\n';
    case 'HR': return '\n\n---\n\n';
    case 'H1': case 'H2': case 'H3': case 'H4': case 'H5': case 'H6': {
      const text = inline(node);
      if (!text) return '';
      if (!options.headings) return `\n\n${text}\n\n`;
      return `\n\n${'#'.repeat(Number(node.tagName[1]))} ${text}\n\n`;
    }
    case 'P': case 'DIV': case 'SECTION': case 'DD': case 'DT': {
      const text = children();
      return text.trim() ? `\n\n${text.trim()}\n\n` : '';
    }
    case 'UL': case 'OL': return listToText(node, options, depth);
    case 'TABLE': return options.tables ? tableToText(node) : '';
    case 'PRE': {
      const text = (node.textContent || '').trim();
      return text ? `\n\n\`\`\`\n${text}\n\`\`\`\n\n` : '';
    }
    case 'BLOCKQUOTE': {
      const text = children().trim();
      return text ? `\n\n${text.split('\n').map((l) => `> ${l}`).join('\n')}\n\n` : '';
    }
    case 'IMG': case 'FIGURE': case 'FIGCAPTION': return '';
    default: return children();
  }
}

function tidy(text) {
  return text
    .replace(/\[\s*\d+\s*\]/g, '')
    .replace(/\[\s*(citation needed|edit|note \d+|clarification needed)\s*\]/gi, '')
    .split('\n')
    .map((line) => line.replace(/\s+$/, '').replace(/(?<=\S)[^\S\n]{2,}/g, ' '))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function extract(html, options) {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  doc.querySelectorAll(STRIP).forEach((el) => el.remove());
  const heading = doc.querySelector('h1');
  const title = ((heading && heading.textContent) || doc.title || '').replace(/\s+/g, ' ').trim();
  return { title, body: tidy(nodeToText(pickMain(doc), options, 0)) };
}

function splitSections(title, body) {
  const chunks = [];
  let heading = title;
  let buffer = [];

  const flush = () => {
    const text = tidy(buffer.join('\n'));
    if (text) chunks.push({ title: heading, body: text });
    buffer = [];
  };

  for (const line of body.split('\n')) {
    const match = /^##\s+(.*)$/.exec(line);
    if (match) { flush(); heading = `${title} — ${match[1].trim()}`; continue; }
    buffer.push(line);
  }
  flush();
  return chunks.length ? chunks : [{ title, body }];
}

function keysFromTitle(title) {
  const primary = title.split(/[|–—:(]/)[0].trim();
  const keys = [];
  if (primary.length > 1) keys.push(primary);
  if (title.trim() && title.trim() !== primary) keys.push(title.trim());
  return keys.slice(0, 3);
}


/* ------------------------------------------------------------------ */
/* Keyword suggestion (local, no model involved)                       */
/* ------------------------------------------------------------------ */

const STOPWORDS = new Set(`a about above after again against all also am an and any are aren as at be because been before
being below between both but by can cannot could couldn did didn do does doesn doing don down during each few for from
further had hadn has hasn have haven having he her here hers herself him himself his how i if in into is isn it its
itself just let me more most mustn my myself no nor not of off on once only or other ought our ours ourselves out over
own same shan she should shouldn so some such than that the their theirs them themselves then there these they this
those through to too under until up very was wasn we were weren what when where which while who whom why with won would
wouldn you your yours yourself yourselves one two three also may many much often used using use first second new like
source truncated`.split(/\s+/));

/** Proper-noun-ish phrases: runs of capitalised words, from the original casing. */
function properNouns(text) {
  const counts = new Map();
  const pattern = /\b([A-Z][a-z]{2,}(?:\s+[A-Z][a-z]{2,}){0,2})\b/g;
  let match;
  while ((match = pattern.exec(text)) !== null) {
    const phrase = match[1].trim();
    const head = phrase.split(/\s+/)[0].toLowerCase();
    if (STOPWORDS.has(head)) continue;
    counts.set(phrase, (counts.get(phrase) || 0) + 1);
  }
  return counts;
}

/** Frequent single words, ignoring stopwords and very short tokens. */
function frequentTerms(text) {
  const counts = new Map();
  for (const raw of text.toLowerCase().split(/[^a-z'-]+/)) {
    const word = raw.replace(/^[''-]+|[''-]+$/g, '');
    if (word.length < 4 || STOPWORDS.has(word)) continue;
    counts.set(word, (counts.get(word) || 0) + 1);
  }
  return counts;
}

/**
 * Suggest keywords for an entry from its own text. Proper nouns rank above
 * frequent common words; the entry label contributes its first phrase.
 */
function suggestKeywords(entry, limit) {
  const text = (entry.content || '').replace(/^Source:.*$/m, '');
  const max = limit || 6;
  const chosen = [];
  const seen = new Set();

  const push = (term) => {
    const clean = String(term).trim();
    const lower = clean.toLowerCase();
    if (clean.length < 3 || seen.has(lower)) return;
    seen.add(lower);
    chosen.push(clean);
  };

  const label = (entry.comment || '').split(/[|–—:(]/)[0].trim();
  if (label && label !== '(no label)') push(label);

  const nouns = [...properNouns(text)].filter(([, n]) => n >= 2).sort((a, b) => b[1] - a[1]);
  for (const [phrase] of nouns.slice(0, max)) push(phrase);

  const terms = [...frequentTerms(text)].filter(([, n]) => n >= 3).sort((a, b) => b[1] - a[1]);
  for (const [word] of terms) {
    if (chosen.length >= max) break;
    push(word);
  }

  return chosen.slice(0, max);
}

/* ------------------------------------------------------------------ */
/* Setup                                                               */
/* ------------------------------------------------------------------ */

export function setup(ctx) {
  const pending = new Map();

  const newId = () => {
    const c = globalThis.crypto;
    if (c && typeof c.randomUUID === 'function') return c.randomUUID();
    return `lws${Date.now()}${Math.random().toString(16).slice(2)}`;
  };

  /** Best guess at the current user ID from the frontend context, if exposed. */
  function clientUserId() {
    const c = ctx || {};
    return (c.user && c.user.id) || c.userId || (c.host && c.host.userId) || undefined;
  }

  function call(type, data, timeoutMs) {
    const requestId = newId();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(requestId);
        reject(new Error(`No answer from the backend for "${type}". The backend module may have failed to load — check the Lumiverse server console.`));
      }, timeoutMs || 60000);
      pending.set(requestId, { resolve, reject, timer });
      try {
        ctx.sendToBackend(Object.assign({ type, requestId, clientUserId: clientUserId() }, data || {}));
      } catch (err) {
        clearTimeout(timer);
        pending.delete(requestId);
        reject(new Error(`Could not reach the backend: ${err && err.message ? err.message : err}`));
      }
    });
  }

  const unsubscribe = ctx.onBackendMessage((payload) => {
    if (!payload || !payload.requestId) return;
    const entry = pending.get(payload.requestId);
    if (!entry) return;
    clearTimeout(entry.timer);
    pending.delete(payload.requestId);
    if (payload.type === 'lws:error') entry.reject(new Error(payload.error || 'Something went wrong.'));
    else entry.resolve(payload);
  });

  const removeStyle = ctx.dom.addStyle(`
    .lws-wrap { padding: 12px; display: flex; flex-direction: column; gap: 12px;
      color: var(--lumiverse-text); font-size: 13px; }
    .lws-wrap p.lws-lede { margin: 0; color: var(--lumiverse-text-muted); line-height: 1.5; }
    .lws-field { display: flex; flex-direction: column; gap: 5px; }
    .lws-field > label { font-size: 11.5px; letter-spacing: .04em; text-transform: uppercase;
      color: var(--lumiverse-text-dim, var(--lumiverse-text-muted)); }
    .lws-wrap select, .lws-wrap input, .lws-wrap textarea {
      width: 100%; padding: 7px 10px; background: var(--lumiverse-fill);
      border: 1px solid var(--lumiverse-border); border-radius: var(--lumiverse-radius);
      color: var(--lumiverse-text); font: inherit; }
    .lws-wrap textarea { min-height: 84px; resize: vertical; line-height: 1.45; }
    .lws-inline { display: flex; gap: 6px; }
    .lws-inline input { flex: 1; }
    .lws-btn { padding: 8px 14px; border-radius: var(--lumiverse-radius); cursor: pointer;
      border: 1px solid var(--lumiverse-border); background: var(--lumiverse-fill);
      color: var(--lumiverse-text); font: inherit; white-space: nowrap; }
    .lws-btn:hover:not(:disabled) { background: var(--lumiverse-fill-subtle); }
    .lws-btn:disabled { opacity: .5; cursor: default; }
    .lws-btn-primary { border-color: transparent; background: var(--lumiverse-accent, var(--lumiverse-fill-subtle)); }
    .lws-opts { display: flex; flex-direction: column; gap: 6px;
      padding-top: 10px; border-top: 1px solid var(--lumiverse-border); }
    .lws-opts label { display: flex; align-items: center; gap: 8px; cursor: pointer; }
    .lws-opts input[type=checkbox] { width: auto; }
    .lws-opts .lws-num { display: flex; align-items: center; gap: 8px; }
    .lws-opts .lws-num input { width: 100px; }
    .lws-status { position: relative; background: var(--lumiverse-fill-subtle);
      border: 1px solid var(--lumiverse-border); border-radius: var(--lumiverse-radius);
      padding: 7px 10px; max-height: 132px; overflow-y: auto;
      font-size: 11.5px; line-height: 1.35; color: var(--lumiverse-text-muted);
      display: flex; flex-direction: column; gap: 1px; word-break: break-word; }
    .lws-status .lws-line { display: flex; gap: 6px; align-items: baseline; padding: 1px 0; }
    .lws-status .lws-line::before { flex: none; width: 10px; text-align: center;
      opacity: 0.9; font-size: 11px; }
    .lws-status .lws-ok { color: var(--lumiverse-success, #6fcf8e); }
    .lws-status .lws-ok::before { content: "✓"; color: var(--lumiverse-success, #6fcf8e); }
    .lws-status .lws-err { color: var(--lumiverse-danger, #e07a7a); }
    .lws-status .lws-err::before { content: "✕"; color: var(--lumiverse-danger, #e07a7a); }
    .lws-status .lws-info::before { content: "·"; opacity: 0.5; }
    .lws-status .lws-head { color: var(--lumiverse-text); font-weight: 600;
      margin-top: 4px; letter-spacing: .02em; }
    .lws-status .lws-head::before { content: ""; }
    .lws-step { display: flex; flex-direction: column; gap: 7px;
      padding: 10px; border: 1px solid var(--lumiverse-border);
      border-radius: var(--lumiverse-radius); background: var(--lumiverse-fill-subtle); }
    .lws-steplabel { display: flex; align-items: center; gap: 7px;
      font-size: 11px; letter-spacing: .06em; text-transform: uppercase;
      color: var(--lumiverse-text-dim, var(--lumiverse-text-muted)); }
    .lws-steplabel b { display: inline-flex; align-items: center; justify-content: center;
      width: 17px; height: 17px; border-radius: 50%; font-size: 10.5px;
      background: var(--lumiverse-accent, var(--lumiverse-fill)); color: var(--lumiverse-text); }
    .lws-nav { margin-left: auto; display: flex; align-items: center; gap: 4px;
      text-transform: none; letter-spacing: 0; }
    .lws-btn.lws-mini { padding: 3px 8px; font-size: 12px; line-height: 1.2; }
    #lws-text { min-height: 150px; font-size: 12px; line-height: 1.45; }
    #lws-target { width: 84px; }
    .lws-step small { font-size: 11px; }
    .lws-bookpick { font-size: 13px; padding: 8px 10px; }
    .lws-stats { display: flex; flex-wrap: wrap; gap: 5px; }
    .lws-chip { display: inline-flex; align-items: baseline; gap: 4px;
      padding: 3px 8px; border-radius: 999px; font-size: 11px;
      background: var(--lumiverse-fill); color: var(--lumiverse-text-muted); }
    .lws-chip b { font-size: 12.5px; color: var(--lumiverse-text); }
    .lws-chip-ok b { color: var(--lumiverse-success, #6fcf8e); }
    .lws-sec { border: 1px solid var(--lumiverse-border);
      border-radius: var(--lumiverse-radius); background: var(--lumiverse-fill-subtle);
      overflow: hidden; }
    .lws-sec > summary { padding: 9px 11px; cursor: pointer; list-style: none;
      font-size: 11.5px; letter-spacing: .05em; text-transform: uppercase;
      color: var(--lumiverse-text-dim, var(--lumiverse-text-muted)); }
    .lws-sec > summary::-webkit-details-marker { display: none; }
    .lws-sec > summary::after { content: "＋"; float: right; opacity: .5; font-size: 12px; }
    .lws-sec[open] > summary::after { content: "－"; }
    .lws-sec[open] > summary { color: var(--lumiverse-text);
      border-bottom: 1px solid var(--lumiverse-border); }
    .lws-secbody { display: flex; flex-direction: column; gap: 6px; padding: 10px 11px; }
    .lws-secbody .lws-btn { width: 100%; text-align: center; }
    .lws-hint { margin: 0; font-size: 11px; line-height: 1.4;
      color: var(--lumiverse-text-dim, var(--lumiverse-text-muted)); opacity: .8; }
    .lws-chk { display: flex; align-items: center; gap: 7px; font-size: 12px; cursor: pointer; }
    .lws-chk input { width: auto; }
    .lws-row2 { display: flex; gap: 6px; align-items: flex-end; }
    .lws-row2 label { flex: 1; display: flex; flex-direction: column; gap: 3px;
      font-size: 11px; color: var(--lumiverse-text-dim, var(--lumiverse-text-muted)); }
    .lws-row2 .lws-btn { width: auto; flex: none; padding: 7px 14px; }
    .lws-num2 { display: flex; align-items: center; gap: 4px; font-size: 11px;
      color: var(--lumiverse-text-dim, var(--lumiverse-text-muted)); }
    .lws-num2 input { width: 70px; }
    .lws-step small.lws-ok { color: var(--lumiverse-success, #6fcf8e); }
    .lws-step small.lws-info { opacity: .65; }
    .lws-step .lws-opts { border-top: 1px solid var(--lumiverse-border); }
    .lws-preview { display: flex; flex-direction: column; gap: 6px;
      padding: 9px; border: 1px solid var(--lumiverse-border);
      border-radius: var(--lumiverse-radius); background: var(--lumiverse-fill-subtle); }
    .lws-preview textarea { min-height: 120px; font-size: 12px; line-height: 1.45; }
    .lws-preview small { font-size: 11px; opacity: 0.7; }
    .lws-statusbar { display: flex; gap: 6px; align-items: center; }
    .lws-statusbar .lws-btn { padding: 4px 9px; font-size: 11.5px; }
    .lws-statusbar span { flex: 1; font-size: 11px; letter-spacing: .05em;
      text-transform: uppercase; color: var(--lumiverse-text-dim, var(--lumiverse-text-muted)); }
  `);

  const tab = ctx.ui.registerDrawerTab({
    id: 'scraper',
    title: 'Lorebook Web Scraper',
    shortName: 'Scrape',
    headerTitle: 'Web Scraper',
    description: 'Turn web pages into world book entries',
    keywords: ['lorebook', 'world book', 'scrape', 'wiki', 'import', 'url'],
    iconSvg: ICON,
  });

  const wrap = document.createElement('div');
  wrap.className = 'lws-wrap';
  wrap.innerHTML = `
    <div class="lws-statusbar">
      <span>Status</span>
      <button class="lws-btn" data-act="diag">Check setup</button>
      <button class="lws-btn" data-act="clear">Clear</button>
    </div>
    <div class="lws-status" id="lws-status">Ready.</div>

    <div class="lws-step">
      <div class="lws-steplabel"><b>1</b> Fetch</div>
      <textarea id="lws-urls" rows="2" placeholder="One URL per line"></textarea>
      <button class="lws-btn lws-btn-primary" data-act="fetch">Fetch pages</button>
    </div>

    <div class="lws-step" id="lws-workspace" style="display:none;">
      <div class="lws-steplabel">
        <b>2</b> Review &amp; condense
        <span class="lws-nav">
          <button class="lws-btn lws-mini" data-act="prev">‹</button>
          <span id="lws-pos">1 / 1</span>
          <button class="lws-btn lws-mini" data-act="next">›</button>
        </span>
      </div>

      <input id="lws-title" placeholder="Entry title" />
      <textarea id="lws-text" rows="10" placeholder="Fetched text appears here"></textarea>
      <small id="lws-meta"></small>

      <input id="lws-focus" placeholder="Focus, optional — e.g. techniques and mechanisms" />
      <div class="lws-inline">
        <select id="lws-focusmode">
          <option value="prioritise">Mostly this, some context</option>
          <option value="only">Only this, ignore the rest</option>
        </select>
      </div>
      <div class="lws-inline">
        <select id="lws-conn"></select>
        <button class="lws-btn lws-mini" data-act="refreshConn" title="Reload connections">↻</button>
      </div>
      <div class="lws-inline">
        <label class="lws-num2">aim<input type="number" id="lws-target" min="50" step="25" value="250" /></label>
        <label class="lws-num2">max<input type="number" id="lws-hard" min="50" step="25" value="320" /></label>
        <button class="lws-btn lws-btn-primary" data-act="condense">Condense</button>
        <button class="lws-btn" data-act="revert">Revert</button>
      </div>
    </div>

    <div class="lws-step" id="lws-sendstep" style="display:none;">
      <div class="lws-steplabel"><b>3</b> Save</div>
      <div class="lws-inline">
        <select id="lws-book"></select>
        <button class="lws-btn lws-mini" data-act="refreshBooks" title="Reload lorebooks">↻</button>
      </div>
      <div class="lws-inline">
        <input id="lws-new" placeholder="Or new lorebook name" />
        <button class="lws-btn lws-mini" data-act="create">Create</button>
      </div>
      <div class="lws-inline">
        <button class="lws-btn lws-btn-primary" data-act="send">Save this entry</button>
        <button class="lws-btn" data-act="discard">Discard</button>
      </div>
      <div class="lws-opts">
        <label><input type="checkbox" data-opt="autokeys" checked> Keywords from title</label>
        <label><input type="checkbox" data-opt="vectorize"> Vectorized</label>
        <label><input type="checkbox" data-opt="constant"> Always active</label>
        <label><input type="checkbox" data-opt="disabled"> Create disabled</label>
        <label><input type="checkbox" data-opt="source" checked> Record source URL</label>
        <label><input type="checkbox" data-opt="headings" checked> Keep headings</label>
        <label><input type="checkbox" data-opt="tables" checked> Keep tables</label>
      </div>
    </div>
  `;
  tab.root.appendChild(wrap);

  const statusBox = wrap.querySelector('#lws-status');
  const $ = (sel) => wrap.querySelector(sel);

  function classifyLine(text) {
    const t = text.trim();
    if (/^— /.test(t)) return 'lws-head';
    if (/\b(failed|error|could not|couldn't|no answer|not available|rejected|missing|denied|discarded)\b/i.test(t)) return 'lws-err';
    if (/\b(done|added|saved|created|found|loaded|written|updated|condensed|fetched|ready)\b/i.test(t)) return 'lws-ok';
    return 'lws-info';
  }

  function appendLine(box, text) {
    const line = document.createElement('div');
    line.className = `lws-line ${classifyLine(text)}`;
    line.textContent = text;
    box.appendChild(line);
    box.scrollTop = box.scrollHeight;
  }

  let firstLine = true;
  function log(msg) {
    if (firstLine) { statusBox.textContent = ''; firstLine = false; }
    appendLine(statusBox, msg);
  }

  const opt = (name) => $(`[data-opt="${name}"]`).checked;

  /* ---- page queue ---- */
  let pages = [];      // { url, title, original, text, condensed }
  let index = 0;

  const workspace = $('#lws-workspace');
  const sendStep = $('#lws-sendstep');
  const titleInput = $('#lws-title');
  const textArea = $('#lws-text');
  const metaLine = $('#lws-meta');
  const posLabel = $('#lws-pos');
  const connSelect = $('#lws-conn');
  const bookSelect = $('#lws-book');

  function syncFromInputs() {
    const page = pages[index];
    if (!page) return;
    page.title = titleInput.value;
    page.text = textArea.value;
  }

  function render() {
    const page = pages[index];
    if (!page) {
      workspace.style.display = 'none';
      sendStep.style.display = 'none';
      return;
    }
    workspace.style.display = 'flex';
    sendStep.style.display = 'flex';
    titleInput.value = page.title;
    textArea.value = page.text;
    posLabel.textContent = `${index + 1} / ${pages.length}`;
    const shrunk = page.condensed
      ? ` · condensed from ${page.original.length}${page.tokens ? ` · ~${page.tokens} tokens` : ''}`
      : ' · not condensed';
    metaLine.textContent = `${page.text.length} characters${shrunk}`;
    metaLine.className = page.condensed ? 'lws-ok' : 'lws-info';
  }

  $('#lws-target').addEventListener('change', () => {
    const aim = Number($('#lws-target').value) || 250;
    const hard = Number($('#lws-hard').value) || 0;
    if (hard < aim) $('#lws-hard').value = Math.ceil(aim * 1.25);
  });

  const focusInput = $('#lws-focus');
  const focusMode = $('#lws-focusmode');
  function syncFocusMode() {
    const on = !!focusInput.value.trim();
    focusMode.disabled = !on;
    focusMode.style.opacity = on ? '1' : '0.45';
  }
  focusInput.addEventListener('input', syncFocusMode);
  syncFocusMode();

  titleInput.addEventListener('input', syncFromInputs);
  textArea.addEventListener('input', () => { syncFromInputs(); render(); });

  $('[data-act="prev"]').addEventListener('click', () => {
    syncFromInputs();
    if (index > 0) { index--; render(); }
  });
  $('[data-act="next"]').addEventListener('click', () => {
    syncFromInputs();
    if (index < pages.length - 1) { index++; render(); }
  });

  $('[data-act="clear"]').addEventListener('click', () => {
    statusBox.textContent = '';
    firstLine = false;
  });

  /* ---- step 1: fetch ---- */
  $('[data-act="fetch"]').addEventListener('click', async (e) => {
    const button = e.currentTarget;
    const urls = $('#lws-urls').value.split(/\s+/)
      .map((u) => u.trim()).filter((u) => /^https?:\/\//i.test(u));
    if (!urls.length) { log('Paste at least one URL beginning with http:// or https://'); return; }

    button.disabled = true;
    button.textContent = 'Fetching…';
    const extractOpts = { headings: opt('headings'), tables: opt('tables') };
    const fetched = [];

    for (const url of urls) {
      try {
        log(`Fetching ${url}`);
        const res = await call('lws:fetch', { url }, 60000);
        const { title, body } = extract(res.html, extractOpts);
        if (!body) { log(`  nothing readable at ${url}`); continue; }
        fetched.push({ url, title: title || url, original: body, text: body, condensed: false });
        log(`  fetched "${title || url}" (${body.length} characters)`);
      } catch (err) {
        log(`  failed — ${err.message}`);
      }
    }

    if (fetched.length) {
      pages = fetched;
      index = 0;
      render();
      log(`Ready to review ${fetched.length} page${fetched.length === 1 ? '' : 's'}. Nothing has been saved yet.`);
    }

    button.disabled = false;
    button.textContent = 'Fetch pages';
  });

  /* ---- step 2: condense ---- */
  $('[data-act="condense"]').addEventListener('click', async (e) => {
    syncFromInputs();
    const page = pages[index];
    if (!page) return;
    const button = e.currentTarget;
    button.disabled = true;
    button.textContent = 'Condensing…';
    try {
      log(`Condensing "${page.title}" (${page.text.length} chars)…`);
      const res = await call('lws:condense', {
        text: page.text,
        title: page.title,
        targetTokens: Number($('#lws-target').value) || 250,
        hardLimit: Number($('#lws-hard').value) || undefined,
        focus: $('#lws-focus').value.trim() || undefined,
        focusMode: $('#lws-focusmode').value,
        connectionId: connSelect.value || undefined,
      }, 180000);
      page.text = res.text;
      page.condensed = true;
      page.tokens = res.tokens;
      render();
      const tk = res.tokens ? `${res.tokens} tokens${res.exactTokens ? '' : ' est.'}` : `${res.text.length} chars`;
      const tightened = res.passes ? `, tightened ${res.passes}x` : '';
      log(`Condensed to ${tk} (limit ${res.hardLimit})${tightened}.`);
      if (res.tokens && res.hardLimit && res.tokens > res.hardLimit) {
        log(`Still over the limit — lower the aim or press Condense again.`);
      }
    } catch (err) {
      log(`Condensing failed — ${err.message}`);
    }
    button.disabled = false;
    button.textContent = 'Condense';
  });

  $('[data-act="revert"]').addEventListener('click', () => {
    const page = pages[index];
    if (!page) return;
    page.text = page.original;
    page.condensed = false;
    render();
    log('Reverted to the original fetched text.');
  });

  /* ---- step 3: save ---- */
  $('[data-act="send"]').addEventListener('click', async (e) => {
    syncFromInputs();
    const page = pages[index];
    const bookId = bookSelect.value;
    if (!page) return;
    if (!bookId) { log('Choose a lorebook first.'); return; }

    const button = e.currentTarget;
    button.disabled = true;
    let content = page.text;
    if (opt('source')) content = `Source: ${page.url}\n\n${content}`;

    try {
      await call('lws:create_entry', {
        bookId,
        entry: {
          key: opt('autokeys') ? keysFromTitle(page.title) : [],
          keysecondary: [],
          content,
          comment: page.title,
          position: 0,
          depth: 4,
          order_value: 100,
          selective: false,
          vectorized: opt('vectorize'),
          constant: opt('constant'),
          disabled: opt('disabled'),
          probability: 100,
          use_probability: true,
          use_regex: false,
          case_sensitive: false,
          match_whole_words: false,
        },
      }, 30000);

      log(`Saved "${page.title}" (${content.length} characters).`);
      pages.splice(index, 1);
      if (index >= pages.length) index = Math.max(0, pages.length - 1);
      render();
      if (!pages.length) log('All pages handled.');
    } catch (err) {
      log(`Could not save — ${err.message}`);
    }
    button.disabled = false;
  });

  $('[data-act="discard"]').addEventListener('click', () => {
    const page = pages[index];
    if (!page) return;
    log(`Discarded "${page.title}" — not saved.`);
    pages.splice(index, 1);
    if (index >= pages.length) index = Math.max(0, pages.length - 1);
    render();
  });

  /* ---- lorebooks & connections ---- */
  async function loadBooks(selectId) {
    try {
      const result = await call('lws:list_books', {}, 25000);
      bookSelect.innerHTML = '';
      const books = result.books || [];
      if (!books.length) {
        const o = document.createElement('option');
        o.value = ''; o.textContent = 'No lorebooks found';
        bookSelect.appendChild(o);
        return;
      }
      for (const book of books) {
        const o = document.createElement('option');
        o.value = book.id; o.textContent = book.name;
        bookSelect.appendChild(o);
      }
      if (selectId) bookSelect.value = selectId;
      log(`Found ${books.length} lorebooks.`);
    } catch (err) {
      log(err.message);
    }
  }

  async function loadConnections() {
    connSelect.innerHTML = '';
    const fallback = document.createElement('option');
    fallback.value = ''; fallback.textContent = 'Default connection';
    connSelect.appendChild(fallback);
    try {
      const result = await call('lws:list_connections', {}, 20000);
      for (const conn of result.connections || []) {
        const o = document.createElement('option');
        o.value = conn.id;
        o.textContent = conn.model ? `${conn.name} — ${conn.model}` : conn.name;
        connSelect.appendChild(o);
      }
      if ((result.connections || []).length) log(`Found ${result.connections.length} connections.`);
      else if (result.note) log(`Connections: ${result.note}`);
    } catch (err) {
      log(`Could not list connections: ${err.message}`);
    }
  }

  $('[data-act="refreshBooks"]').addEventListener('click', () => loadBooks(bookSelect.value));
  $('[data-act="refreshConn"]').addEventListener('click', loadConnections);

  $('[data-act="create"]').addEventListener('click', async () => {
    const name = $('#lws-new').value.trim();
    if (!name) { log('Type a name for the new lorebook first.'); return; }
    try {
      const result = await call('lws:create_book', { name }, 25000);
      $('#lws-new').value = '';
      log(`Created lorebook "${name}".`);
      await loadBooks(result.book && result.book.id);
    } catch (err) {
      log(err.message);
    }
  });

  async function diagnose() {
    try {
      const d = await call('lws:diag', {}, 25000);
      log('— Setup check —');
      log(`Frontend 2.15 · Backend ${d.backendVersion || 'older — it did not reload'}`);
      log(`generate: ${d.generateType} · ${d.generateMethods}`);
      log(`User ID: ${d.userId}`);
      log(`Granted: ${(d.granted || []).join(', ') || '(none)'}`);
    } catch (err) {
      log(err.message);
    }
  }
  $('[data-act="diag"]').addEventListener('click', diagnose);

  loadBooks();
  loadConnections();

  /* ---------------------------------------------------------------- */
  /* Vectorizer tab                                                    */
  /* ---------------------------------------------------------------- */

  const VECTOR_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><circle cx="6" cy="7" r="2.2"/><circle cx="18" cy="6" r="2.2"/><circle cx="12" cy="17" r="2.2"/><path d="M7.9 8.4 10.6 15"/><path d="M16.4 7.7 13.5 15.4"/><path d="M8.2 6.6h7.6"/></svg>';

  const vectorTab = ctx.ui.registerDrawerTab({
    id: 'vectorizer',
    title: 'Lorebook Vectorizer',
    shortName: 'Vectors',
    headerTitle: 'Vectorizer',
    description: 'Switch entries from keyword to semantic activation',
    keywords: ['vector', 'vectorize', 'semantic', 'embedding', 'lorebook', 'keywords'],
    iconSvg: VECTOR_ICON,
  });

  const vWrap = document.createElement('div');
  vWrap.className = 'lws-wrap';
  vWrap.innerHTML = `
    <div class="lws-statusbar">
      <span>Vectors</span>
      <button class="lws-btn lws-mini" data-vact="scan">Rescan</button>
      <button class="lws-btn lws-mini" data-vact="clear">Clear log</button>
    </div>

    <select id="lwsv-book" class="lws-bookpick"></select>

    <div class="lws-stats" id="lwsv-stats"></div>

    <div class="lws-status" id="lwsv-status"></div>

    <details class="lws-sec" open>
      <summary>Activation</summary>
      <div class="lws-secbody">
        <button class="lws-btn lws-btn-primary" data-vact="vectorize">Vectorize all</button>
        <button class="lws-btn" data-vact="strip">Vectorize + clear keywords</button>
        <button class="lws-btn" data-vact="unvector">Un-vectorize all</button>
        <button class="lws-btn" data-vact="restore">Restore saved keywords</button>
        <label class="lws-chk"><input type="checkbox" data-vopt="unvectorOnRestore" checked>Un-vectorize when restoring</label>
      </div>
    </details>

    <details class="lws-sec">
      <summary>Ranking</summary>
      <div class="lws-secbody">
        <p class="lws-hint">Higher priority wins retrieval slots. Give the books you want surfacing more often a higher number than the ones that dominate.</p>
        <div class="lws-row2">
          <label>Priority<input type="number" id="lwsv-priority" min="0" step="1" placeholder="10" /></label>
          <button class="lws-btn" data-vact="setPriority">Apply</button>
        </div>
        <div class="lws-row2">
          <label>Group<input type="text" id="lwsv-group" placeholder="none" /></label>
          <button class="lws-btn" data-vact="setGroup">Apply</button>
        </div>
        <div class="lws-row2">
          <label>Slots per turn<input type="number" id="lwsv-slots" min="1" max="12" step="1" placeholder="1" /></label>
          <button class="lws-btn" data-vact="splitGroups">Split</button>
        </div>
        <button class="lws-btn" data-vact="ungroup">Remove all grouping from this book</button>
        <p class="lws-hint">One entry fires per group name. Apply sets a single shared group, capping the book at one per turn. Split spreads entries across that many numbered sub-groups instead, so the book contributes that many per turn. Clear the group box and Apply to remove grouping.</p>
        <div class="lws-row2">
          <label>Sticky<input type="number" id="lwsv-sticky" min="0" step="1" placeholder="0" /></label>
          <button class="lws-btn" data-vact="setSticky">Apply</button>
        </div>
        <div class="lws-row2">
          <label>Cooldown<input type="number" id="lwsv-cooldown" min="0" step="1" placeholder="0" /></label>
          <button class="lws-btn" data-vact="setCooldown">Apply</button>
        </div>
      </div>
    </details>

    <details class="lws-sec">
      <summary>Retrieval cues</summary>
      <div class="lws-secbody">
        <p class="lws-hint">Clinical or formal entries rarely match narrative chat, so they never surface. This appends a few plain-language lines describing what the topic looks like in a scene. The entry keeps its own voice; only the embedding shifts.</p>
        <div class="lws-inline">
          <select id="lwsv-conn"></select>
          <button class="lws-btn lws-mini" data-vact="refreshVConn" title="Reload connections">↻</button>
        </div>
        <input id="lwsv-style" placeholder="Setting, optional — e.g. 1959 institutional psychiatry" />
        <button class="lws-btn lws-btn-primary" data-vact="addCues">Add cues to every entry</button>
        <button class="lws-btn" data-vact="stripCues">Remove cues</button>
      </div>
    </details>

    <details class="lws-sec">
      <summary>Keywords</summary>
      <div class="lws-secbody">
        <button class="lws-btn" data-vact="suggest">Suggest from entry text</button>
        <button class="lws-btn" data-vact="applyKeywords">Apply suggestions</button>
        <label class="lws-chk"><input type="checkbox" data-vopt="onlyEmpty" checked>Only entries with no keywords</label>
      </div>
    </details>

    <details class="lws-sec">
      <summary>Advanced</summary>
      <div class="lws-secbody">
        <button class="lws-btn" data-vact="inspect">Inspect entry fields</button>
        <div class="lws-row2">
          <label>Field<input type="text" id="lwsv-field" placeholder="priority" /></label>
          <label>Value<input type="text" id="lwsv-value" placeholder="20" /></label>
        </div>
        <button class="lws-btn" data-vact="bulkSet">Bulk set on this book</button>
      </div>
    </details>

    <details class="lws-sec">
      <summary>Safety</summary>
      <div class="lws-secbody">
        <label class="lws-chk"><input type="checkbox" data-vopt="skipConstant" checked>Skip always-active entries</label>
        <label class="lws-chk"><input type="checkbox" data-vopt="skipDisabled" checked>Skip disabled entries</label>
        <label class="lws-chk"><input type="checkbox" data-vopt="onlyVectorized" checked>Ranking changes affect vectorized only</label>
      </div>
    </details>
  `;
  vectorTab.root.appendChild(vWrap);

  const vBookSelect = vWrap.querySelector('#lwsv-book');
  const vStatus = vWrap.querySelector('#lwsv-status');
  const vStats = vWrap.querySelector('#lwsv-stats');
  let vFirstLine = true;
  let scanned = [];
  let suggestions = new Map();

  function vLog(text) {
    if (vFirstLine) { vStatus.textContent = ''; vFirstLine = false; }
    appendLine(vStatus, text);
  }

  const vOpt = (name) => vWrap.querySelector(`[data-vopt="${name}"]`).checked;
  const vVal = (id) => vWrap.querySelector(id).value.trim();

  function renderStats() {
    if (!scanned.length) { vStats.innerHTML = ''; return; }
    const vec = scanned.filter((e) => e.vectorized).length;
    const keys = scanned.filter((e) => e.keyCount > 0).length;
    const saved = scanned.filter((e) => e.hasBackup).length;
    const chip = (label, value, cls) =>
      `<span class="lws-chip ${cls || ''}"><b>${value}</b>${label}</span>`;
    vStats.innerHTML =
      chip('entries', scanned.length) +
      chip('vectorized', vec, vec ? 'lws-chip-ok' : '') +
      chip('keyworded', keys) +
      (saved ? chip('saved keys', saved) : '');
  }

  async function vLoadBooks(selectId) {
    try {
      const result = await call('lws:list_books', {}, 25000);
      vBookSelect.innerHTML = '';
      for (const book of result.books || []) {
        const o = document.createElement('option');
        o.value = book.id;
        o.textContent = book.name;
        vBookSelect.appendChild(o);
      }
      if (selectId) vBookSelect.value = selectId;
    } catch (err) {
      vLog(err.message);
    }
  }

  async function vScan() {
    const bookId = vBookSelect.value;
    if (!bookId) { vLog('Choose a lorebook first.'); return; }
    try {
      const result = await call('lws:list_entries', { bookId }, 60000);
      scanned = result.entries || [];
      renderStats();
    } catch (err) {
      vLog(err.message);
      scanned = [];
      renderStats();
    }
  }

  function eligible(entry) {
    if (vOpt('skipConstant') && entry.constant) return false;
    if (vOpt('skipDisabled') && entry.disabled) return false;
    return true;
  }

  async function applyToAll(label, buildPatch, filter) {
    const bookId = vBookSelect.value;
    if (!bookId) { vLog('Choose a lorebook first.'); return; }
    if (!scanned.length) await vScan();

    const targets = scanned.filter((e) => eligible(e) && filter(e));
    if (!targets.length) { vLog(`${label}: nothing matched.`); return; }

    vLog(`${label}: ${targets.length} entries…`);
    let done = 0;
    let failed = 0;
    for (const entry of targets) {
      try {
        await call('lws:update_entry', { entryId: entry.id, patch: buildPatch(entry) }, 30000);
        done++;
      } catch (err) {
        failed++;
        if (failed <= 2) vLog(`  "${entry.comment}" failed — ${err.message}`);
      }
    }
    vLog(`${label}: updated ${done}${failed ? `, ${failed} failed` : ''}.`);
    await vScan();
  }

  /* ---- field setter shared by the ranking controls ---- */
  async function setField(fieldLabel, field, rawValue, coerce) {
    if (rawValue === '') { vLog(`Enter a ${fieldLabel} value first.`); return; }
    const value = coerce ? coerce(rawValue) : rawValue;
    await applyToAll(
      `Set ${fieldLabel} to ${JSON.stringify(value)}`,
      () => ({ [field]: value }),
      (e) => (vOpt('onlyVectorized') ? e.vectorized : true),
    );
  }

  /* ---- wiring ---- */
  vBookSelect.addEventListener('change', () => { scanned = []; vScan(); });
  vWrap.querySelector('[data-vact="scan"]').addEventListener('click', vScan);
  vWrap.querySelector('[data-vact="clear"]').addEventListener('click', () => {
    vStatus.textContent = '';
    vFirstLine = false;
  });

  vWrap.querySelector('[data-vact="vectorize"]').addEventListener('click', () => {
    applyToAll('Vectorize', () => ({ vectorized: true }), (e) => !e.vectorized);
  });

  vWrap.querySelector('[data-vact="unvector"]').addEventListener('click', () => {
    applyToAll('Un-vectorize', () => ({ vectorized: false }), (e) => e.vectorized);
  });

  vWrap.querySelector('[data-vact="strip"]').addEventListener('click', () => {
    applyToAll('Vectorize and clear keywords', (entry) => ({
      vectorized: true,
      key: [],
      keysecondary: [],
      selective: false,
      extensions: {
        ...entry.extensions,
        lws_original_keys: {
          key: entry.key,
          keysecondary: entry.keysecondary,
          saved_at: Date.now(),
        },
      },
    }), (e) => e.keyCount > 0 || !e.vectorized);
  });

  vWrap.querySelector('[data-vact="restore"]').addEventListener('click', () => {
    applyToAll('Restore keywords', (entry) => {
      const backup = entry.extensions.lws_original_keys || {};
      const rest = { ...entry.extensions };
      delete rest.lws_original_keys;
      const patch = {
        key: Array.isArray(backup.key) ? backup.key : [],
        keysecondary: Array.isArray(backup.keysecondary) ? backup.keysecondary : [],
        extensions: rest,
      };
      if (vOpt('unvectorOnRestore')) patch.vectorized = false;
      return patch;
    }, (e) => e.hasBackup);
  });

  vWrap.querySelector('[data-vact="setPriority"]').addEventListener('click', () => {
    setField('priority', 'priority', vVal('#lwsv-priority'), (v) => Number(v) || 0);
  });
  vWrap.querySelector('[data-vact="setGroup"]').addEventListener('click', () => {
    setField('group', 'group_name', vVal('#lwsv-group'), (v) => String(v));
  });
  vWrap.querySelector('[data-vact="setSticky"]').addEventListener('click', () => {
    setField('sticky', 'sticky', vVal('#lwsv-sticky'), (v) => Number(v) || 0);
  });
  vWrap.querySelector('[data-vact="setCooldown"]').addEventListener('click', () => {
    setField('cooldown', 'cooldown', vVal('#lwsv-cooldown'), (v) => Number(v) || 0);
  });

  vWrap.querySelector('[data-vact="suggest"]').addEventListener('click', async () => {
    if (!scanned.length) await vScan();
    suggestions = new Map();
    const targets = scanned.filter((e) => (vOpt('onlyEmpty') ? e.keyCount === 0 : true));
    if (!targets.length) { vLog('No entries matched.'); return; }

    let thin = 0;
    for (const entry of targets) {
      const words = suggestKeywords(entry, 6);
      if (!words.length) { thin++; continue; }
      suggestions.set(entry.id, words);
      vLog(`${entry.comment} → ${words.join(', ')}`);
    }
    vLog(`Suggested for ${suggestions.size} of ${targets.length}${thin ? ` (${thin} too short)` : ''}.`);
  });

  vWrap.querySelector('[data-vact="applyKeywords"]').addEventListener('click', () => {
    if (!suggestions.size) { vLog('Run Suggest first.'); return; }
    applyToAll('Apply keywords', (entry) => {
      const proposed = suggestions.get(entry.id) || [];
      const merged = [];
      const seen = new Set();
      for (const word of [...entry.key, ...proposed]) {
        const lower = String(word).toLowerCase();
        if (!word || seen.has(lower)) continue;
        seen.add(lower);
        merged.push(word);
      }
      return { key: merged };
    }, (e) => suggestions.has(e.id));
  });

  vWrap.querySelector('[data-vact="inspect"]').addEventListener('click', async () => {
    const bookId = vBookSelect.value;
    if (!bookId) { vLog('Choose a lorebook first.'); return; }
    try {
      const res = await call('lws:inspect_entry', { bookId }, 30000);
      vLog(`— Fields on "${res.comment}" —`);
      for (const line of res.fields || []) vLog(`  ${line}`);
    } catch (err) {
      vLog(err.message);
    }
  });

  vWrap.querySelector('[data-vact="bulkSet"]').addEventListener('click', async (e) => {
    const bookId = vBookSelect.value;
    const field = vVal('#lwsv-field');
    const raw = vVal('#lwsv-value');
    if (!bookId) { vLog('Choose a lorebook first.'); return; }
    if (!field) { vLog('Type a field name. Use Inspect if unsure.'); return; }

    let value = raw;
    if (raw === 'true') value = true;
    else if (raw === 'false') value = false;
    else if (raw === 'null') value = null;
    else if (raw !== '' && !isNaN(Number(raw))) value = Number(raw);

    const button = e.currentTarget;
    button.disabled = true;
    try {
      const res = await call('lws:bulk_field', {
        bookId, field, value, onlyVectorized: vOpt('onlyVectorized'),
      }, 120000);
      vLog(`Set ${field} = ${JSON.stringify(value)} on ${res.updated} of ${res.attempted}.`);
      for (const f of res.failures || []) vLog(`  rejected: ${f}`);
      await vScan();
    } catch (err) {
      vLog(err.message);
    }
    button.disabled = false;
  });


  vWrap.querySelector('[data-vact="splitGroups"]').addEventListener('click', async () => {
    const base = vVal('#lwsv-group');
    const slots = Math.max(1, Math.min(12, Number(vVal('#lwsv-slots')) || 1));
    if (!base) { vLog('Type a group name first, then choose how many slots.'); return; }
    if (!vBookSelect.value) { vLog('Choose a lorebook first.'); return; }
    if (!scanned.length) await vScan();

    const targets = scanned.filter((e) => eligible(e) && (vOpt('onlyVectorized') ? e.vectorized : true));
    if (!targets.length) { vLog('No entries matched.'); return; }
    if (slots >= targets.length) {
      vLog(`${targets.length} entries but ${slots} slots — grouping would do nothing. Use a smaller number.`);
      return;
    }

    vLog(`Splitting ${targets.length} entries across ${slots} groups…`);
    let done = 0;
    let failed = 0;

    // Round-robin so semantically similar neighbours land in different groups,
    // which stops one group holding all the strong matches.
    for (let i = 0; i < targets.length; i++) {
      const groupName = `${base}-${(i % slots) + 1}`;
      try {
        await call('lws:update_entry', {
          entryId: targets[i].id,
          patch: { group_name: groupName },
        }, 30000);
        done++;
      } catch (err) {
        failed++;
        if (failed <= 2) vLog(`  "${targets[i].comment}" failed — ${err.message}`);
      }
    }

    vLog(`Split done: ${done} entries into ${base}-1 … ${base}-${slots}${failed ? `, ${failed} failed` : ''}.`);
    vLog(`This book can now contribute up to ${slots} entries per turn.`);
    await vScan();
  });


  const CUE_START = '\n\n[cues]\n';

  vWrap.querySelector('[data-vact="ungroup"]').addEventListener('click', () => {
    applyToAll('Remove grouping', () => ({ group_name: '' }), () => true);
  });

  vWrap.querySelector('[data-vact="stripCues"]').addEventListener('click', () => {
    applyToAll('Remove cues', (entry) => ({
      content: String(entry.content || '').split(CUE_START)[0].trimEnd(),
    }), (e) => String(e.content || '').includes(CUE_START));
  });

  vWrap.querySelector('[data-vact="addCues"]').addEventListener('click', async (e) => {
    const bookId = vBookSelect.value;
    if (!bookId) { vLog('Choose a lorebook first.'); return; }
    if (!scanned.length) await vScan();

    const style = vVal('#lwsv-style');
    const targets = scanned.filter((x) => eligible(x)
      && (vOpt('onlyVectorized') ? x.vectorized : true)
      && !String(x.content || '').includes(CUE_START));

    if (!targets.length) { vLog('Every entry already has cues, or none matched.'); return; }

    const button = e.currentTarget;
    button.disabled = true;
    vLog(`Generating cues for ${targets.length} entries…`);
    let done = 0;
    let failed = 0;

    for (const entry of targets) {
      try {
        const res = await call('lws:expand_entry', {
          content: entry.content,
          title: entry.comment,
          style: style || undefined,
          connectionId: vConnSelect.value || undefined,
        }, 120000);

        const cues = (res.cues || []).join('\n');
        if (!cues) { failed++; continue; }

        await call('lws:update_entry', {
          entryId: entry.id,
          patch: { content: `${entry.content.trimEnd()}${CUE_START}${cues}` },
        }, 30000);

        done++;
        vLog(`  ${entry.comment}: ${res.cues.length} cues`);
      } catch (err) {
        failed++;
        if (failed <= 2) vLog(`  "${entry.comment}" failed — ${err.message}`);
      }
    }

    vLog(`Cues added to ${done} entries${failed ? `, ${failed} failed` : ''}. Re-index for them to take effect.`);
    button.disabled = false;
    await vScan();
  });


  const vConnSelect = vWrap.querySelector('#lwsv-conn');

  async function vLoadConnections() {
    vConnSelect.innerHTML = '';
    const fallback = document.createElement('option');
    fallback.value = '';
    fallback.textContent = 'Default connection';
    vConnSelect.appendChild(fallback);
    try {
      const result = await call('lws:list_connections', {}, 20000);
      for (const conn of result.connections || []) {
        const o = document.createElement('option');
        o.value = conn.id;
        o.textContent = conn.model ? `${conn.name} — ${conn.model}` : conn.name;
        vConnSelect.appendChild(o);
      }
    } catch (err) {
      vLog(`Could not list connections: ${err.message}`);
    }
  }

  vWrap.querySelector('[data-vact="refreshVConn"]').addEventListener('click', vLoadConnections);

  vLoadBooks().then(vScan);
  vLoadConnections();

  return () => {
    for (const entry of pending.values()) clearTimeout(entry.timer);
    pending.clear();
    unsubscribe();
    tab.destroy();
    vectorTab.destroy();
    removeStyle();
    ctx.dom.cleanup();
  };
}
