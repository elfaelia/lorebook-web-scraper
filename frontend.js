/**
 * Lorebook Web Scraper — frontend module. v1.5
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
    .lws-status { background: var(--lumiverse-fill-subtle); border: 1px solid var(--lumiverse-border);
      border-radius: var(--lumiverse-radius); padding: 9px 11px; max-height: 240px; overflow-y: auto;
      font-size: 12px; line-height: 1.5; color: var(--lumiverse-text-muted);
      white-space: pre-wrap; word-break: break-word; }
    .lws-statusbar { display: flex; gap: 6px; align-items: center; }
    .lws-statusbar .lws-btn { padding: 5px 10px; font-size: 12px; }
    .lws-statusbar span { flex: 1; font-size: 11.5px; letter-spacing: .04em;
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
    <div class="lws-status" id="lws-status">Starting up…</div>

    <p class="lws-lede">Each page becomes one entry. Text is extracted in your browser — no model is called.</p>

    <div class="lws-field">
      <label for="lws-book">Lorebook</label>
      <div class="lws-inline">
        <select id="lws-book"></select>
        <button class="lws-btn" data-act="refresh" title="Reload the list">↻</button>
      </div>
    </div>

    <div class="lws-field">
      <label for="lws-new">Or make a new one</label>
      <div class="lws-inline">
        <input id="lws-new" placeholder="New lorebook name" />
        <button class="lws-btn" data-act="create">Create</button>
      </div>
    </div>

    <div class="lws-field">
      <label for="lws-urls">Page URLs, one per line</label>
      <textarea id="lws-urls" placeholder="https://outlast.fandom.com/wiki/Easterman"></textarea>
    </div>

    <button class="lws-btn lws-btn-primary" data-act="scrape">Scrape into lorebook</button>

    <div class="lws-opts">
      <label><input type="checkbox" data-opt="headings" checked> Keep headings as markdown</label>
      <label><input type="checkbox" data-opt="tables" checked> Keep tables</label>
      <label><input type="checkbox" data-opt="source" checked> Record the source URL in the entry</label>
      <label><input type="checkbox" data-opt="autokeys" checked> Fill keywords from the page title</label>
      <label><input type="checkbox" data-opt="vectorize"> Vectorize new entries (semantic activation)</label>
      <label><input type="checkbox" data-opt="constant"> Make entries always active</label>
      <label><input type="checkbox" data-opt="disabled"> Create disabled so I can review them</label>
      <label><input type="checkbox" data-opt="split"> Split long pages at each H2</label>
      <div class="lws-num"><input type="number" data-opt="max" min="0" step="500" value="0"> character cap per entry (0 = none)</div>
    </div>
  `;
  tab.root.appendChild(wrap);

  const bookSelect = wrap.querySelector('#lws-book');
  const newBookInput = wrap.querySelector('#lws-new');
  const urlInput = wrap.querySelector('#lws-urls');
  const statusBox = wrap.querySelector('#lws-status');
  const scrapeBtn = wrap.querySelector('[data-act="scrape"]');

  let firstLine = true;
  function log(message) {
    if (firstLine) { statusBox.textContent = ''; firstLine = false; }
    const line = document.createElement('div');
    line.textContent = message;
    statusBox.appendChild(line);
    statusBox.scrollTop = statusBox.scrollHeight;
  }

  function options() {
    const read = (name) => wrap.querySelector(`[data-opt="${name}"]`).checked;
    return {
      headings: read('headings'),
      tables: read('tables'),
      source: read('source'),
      autokeys: read('autokeys'),
      vectorize: read('vectorize'),
      constant: read('constant'),
      disabled: read('disabled'),
      split: read('split'),
      max: Number(wrap.querySelector('[data-opt="max"]').value) || 0,
    };
  }

  async function loadBooks(selectId) {
    try {
      const result = await call('lws:list_books', {}, 25000);
      const books = result.books || [];
      bookSelect.innerHTML = '';

      if (!books.length) {
        const option = document.createElement('option');
        option.value = '';
        option.textContent = 'No lorebooks found';
        bookSelect.appendChild(option);
        log(`The host returned 0 lorebooks (response fields: ${result.rawShape}, reported total: ${result.total}). If you do have lorebooks, press Check setup.`);
        return;
      }

      for (const book of books) {
        const option = document.createElement('option');
        option.value = book.id;
        option.textContent = book.name;
        bookSelect.appendChild(option);
      }
      if (selectId) bookSelect.value = selectId;
      log(`Found ${books.length} ${books.length === 1 ? 'lorebook' : 'lorebooks'}.`);
    } catch (err) {
      log(err.message);
    }
  }

  async function diagnose() {
    try {
      const d = await call('lws:diag', {}, 25000);
      log('— Setup check —');
      log(`Extension version: 1.5`);
      log(`User ID: ${d.userId || 'this backend is too old to report it — the update did not take'}`);
      log(`Call shapes learned: ${d.shapes || 'n/a'}`);
      log(`Permissions granted by host: ${d.granted && d.granted.length ? d.granted.join(', ') : '(none)'}`);
      log(`world_books cached as granted: ${d.cachedWorldBooks}`);
      log(`cors_proxy cached as granted: ${d.cachedCors}`);
      log(`spindle.world_books is: ${d.worldBooksApi} / .entries is: ${d.entriesApi}`);
      log(`spindle.cors is: ${d.corsApi}`);
      log(`Available spindle APIs: ${d.spindleKeys}`);
    } catch (err) {
      log(err.message);
    }
  }

  wrap.querySelector('[data-act="refresh"]').addEventListener('click', () => loadBooks(bookSelect.value));
  wrap.querySelector('[data-act="diag"]').addEventListener('click', diagnose);
  wrap.querySelector('[data-act="clear"]').addEventListener('click', () => {
    statusBox.textContent = '';
    firstLine = false;
  });

  wrap.querySelector('[data-act="create"]').addEventListener('click', async (event) => {
    const button = event.currentTarget;
    const name = newBookInput.value.trim();
    if (!name) { log('Type a name for the new lorebook first.'); return; }
    button.disabled = true;
    try {
      const result = await call('lws:create_book', { name }, 25000);
      newBookInput.value = '';
      log(`Created lorebook "${name}".`);
      await loadBooks(result.book && result.book.id);
    } catch (err) {
      log(err.message);
    } finally {
      button.disabled = false;
    }
  });

  scrapeBtn.addEventListener('click', async () => {
    const urls = urlInput.value.split(/\s+/).map((u) => u.trim()).filter((u) => /^https?:\/\//i.test(u));
    const bookId = bookSelect.value;

    if (!urls.length) { log('Paste at least one URL beginning with http:// or https://'); return; }
    if (!bookId) { log('Choose a lorebook, or create one above.'); return; }

    const opts = options();
    scrapeBtn.disabled = true;
    scrapeBtn.textContent = 'Scraping…';
    let added = 0;

    for (const url of urls) {
      try {
        log(`Fetching ${url}`);
        const fetched = await call('lws:fetch', { url }, 60000);
        const { title, body } = extract(fetched.html, opts);
        if (!body) { log('  nothing readable on that page'); continue; }

        const pieces = opts.split ? splitSections(title || url, body) : [{ title: title || url, body }];

        for (const piece of pieces) {
          let content = piece.body;
          if (opts.max > 0 && content.length > opts.max) {
            content = `${content.slice(0, opts.max).replace(/\s\S*$/, '')}\n\n[truncated]`;
          }
          if (opts.source) content = `Source: ${url}\n\n${content}`;

          await call('lws:create_entry', {
            bookId,
            entry: {
              key: opts.autokeys ? keysFromTitle(piece.title) : [],
              keysecondary: [],
              content,
              comment: piece.title,
              position: 0,
              depth: 4,
              order_value: 100,
              selective: false,
              vectorized: opts.vectorize,
              constant: opts.constant,
              disabled: opts.disabled,
              probability: 100,
              use_probability: true,
              use_regex: false,
              case_sensitive: false,
              match_whole_words: false,
            },
          }, 30000);

          added++;
          log(`  added "${piece.title}" (${content.length} characters)`);
        }
      } catch (err) {
        log(`  failed — ${err.message}`);
      }
    }

    scrapeBtn.disabled = false;
    scrapeBtn.textContent = 'Scrape into lorebook';
    log(added ? `Done. ${added} ${added === 1 ? 'entry' : 'entries'} written.` : 'Nothing was written.');
    if (added) urlInput.value = '';
  });

  loadBooks();

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
      <span>Status</span>
      <button class="lws-btn" data-vact="clear">Clear</button>
    </div>
    <div class="lws-status" id="lwsv-status">Pick a lorebook to scan.</div>

    <p class="lws-lede">Vectorized entries activate on meaning rather than exact keywords. Needs an embedding provider set up in Settings → Embeddings.</p>

    <div class="lws-field">
      <label for="lwsv-book">Lorebook</label>
      <div class="lws-inline">
        <select id="lwsv-book"></select>
        <button class="lws-btn" data-vact="scan" title="Scan this book">↻</button>
      </div>
    </div>

    <div class="lws-opts">
      <button class="lws-btn lws-btn-primary" data-vact="vectorize">Vectorize every entry</button>
      <button class="lws-btn" data-vact="strip">Vectorize and clear keywords</button>
      <button class="lws-btn" data-vact="restore">Restore cleared keywords</button>
      <button class="lws-btn" data-vact="unvector">Un-vectorize every entry</button>
      <label><input type="checkbox" data-vopt="unvectorOnRestore" checked> Also un-vectorize when restoring</label>
      <hr style="border:0;border-top:1px solid var(--lumiverse-border);margin:4px 0;">
      <button class="lws-btn" data-vact="suggest">Suggest keywords from entry text</button>
      <button class="lws-btn" data-vact="applyKeywords">Apply suggested keywords</button>
      <label><input type="checkbox" data-vopt="onlyEmpty" checked> Only entries that have no keywords</label>
      <label><input type="checkbox" data-vopt="skipConstant" checked> Leave always-active entries alone</label>
      <label><input type="checkbox" data-vopt="skipDisabled" checked> Leave disabled entries alone</label>
    </div>
  `;
  vectorTab.root.appendChild(vWrap);

  const vBookSelect = vWrap.querySelector('#lwsv-book');
  const vStatus = vWrap.querySelector('#lwsv-status');
  let vFirstLine = true;
  let scanned = [];

  function vLog(text) {
    if (vFirstLine) { vStatus.textContent = ''; vFirstLine = false; }
    const line = document.createElement('div');
    line.textContent = text;
    vStatus.appendChild(line);
    vStatus.scrollTop = vStatus.scrollHeight;
  }

  const vOpt = (name) => vWrap.querySelector(`[data-vopt="${name}"]`).checked;

  async function vLoadBooks() {
    try {
      const result = await call('lws:list_books', {}, 25000);
      vBookSelect.innerHTML = '';
      for (const book of result.books || []) {
        const option = document.createElement('option');
        option.value = book.id;
        option.textContent = book.name;
        vBookSelect.appendChild(option);
      }
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
      const vectorized = scanned.filter((e) => e.vectorized).length;
      const withKeys = scanned.filter((e) => e.keyCount > 0).length;
      const backed = scanned.filter((e) => e.hasBackup).length;
      vLog(`${scanned.length} entries — ${vectorized} vectorized, ${withKeys} still have keywords${backed ? `, ${backed} with saved keywords` : ''}.`);
    } catch (err) {
      vLog(err.message);
      scanned = [];
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
    if (!targets.length) { vLog(`Nothing to change — no entries match for ${label}.`); return; }

    vLog(`${label}: ${targets.length} ${targets.length === 1 ? 'entry' : 'entries'}…`);
    let done = 0;
    let failed = 0;

    for (const entry of targets) {
      try {
        await call('lws:update_entry', { entryId: entry.id, patch: buildPatch(entry) }, 30000);
        done++;
        if (done % 10 === 0) vLog(`  ${done} of ${targets.length}…`);
      } catch (err) {
        failed++;
        if (failed <= 3) vLog(`  "${entry.comment}" failed — ${err.message}`);
      }
    }

    vLog(`${label} finished: ${done} updated${failed ? `, ${failed} failed` : ''}.`);
    await vScan();
  }

  vWrap.querySelector('[data-vact="clear"]').addEventListener('click', () => {
    vStatus.textContent = '';
    vFirstLine = false;
  });

  vWrap.querySelector('[data-vact="scan"]').addEventListener('click', vScan);
  vBookSelect.addEventListener('change', () => { scanned = []; vScan(); });

  vWrap.querySelector('[data-vact="vectorize"]').addEventListener('click', () => {
    applyToAll('Vectorize', () => ({ vectorized: true }), (e) => !e.vectorized);
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


  let suggestions = new Map();

  vWrap.querySelector('[data-vact="unvector"]').addEventListener('click', () => {
    applyToAll('Un-vectorize', () => ({ vectorized: false }), (e) => e.vectorized);
  });

  vWrap.querySelector('[data-vact="suggest"]').addEventListener('click', async () => {
    if (!scanned.length) await vScan();
    suggestions = new Map();

    const targets = scanned.filter((e) => (vOpt('onlyEmpty') ? e.keyCount === 0 : true));
    if (!targets.length) { vLog('No entries match — untick "only entries that have no keywords" to include them all.'); return; }

    let empty = 0;
    for (const entry of targets) {
      const words = suggestKeywords(entry, 6);
      if (!words.length) { empty++; continue; }
      suggestions.set(entry.id, words);
      vLog(`"${entry.comment}" → ${words.join(', ')}`);
    }

    vLog(`Suggested keywords for ${suggestions.size} of ${targets.length} entries${empty ? ` (${empty} had too little text)` : ''}. Read them, then press Apply.`);
    vLog('These come from words in the entry itself, so they favour names and topic terms. Add your own scene-language keywords by hand afterwards.');
  });

  vWrap.querySelector('[data-vact="applyKeywords"]').addEventListener('click', () => {
    if (!suggestions.size) { vLog('Press Suggest first so you can see what would be applied.'); return; }
    applyToAll('Apply suggested keywords', (entry) => {
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

  vLoadBooks().then(vScan);


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
