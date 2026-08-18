/**
 * Lorebook Web Scraper — backend module. v2.0
 *
 * Runs in an isolated Spindle runtime. It does three jobs:
 *   1. lists the user's world books,
 *   2. fetches a page through the host CORS proxy,
 *   3. writes finished entries into a world book.
 *
 * HTML is parsed in the frontend module, where a real DOMParser exists.
 *
 * Operator-scoped installs (the extension installed globally rather than for a
 * single user) require the user ID on every data call. The host is not
 * explicit about where that argument goes, so each call is attempted in a few
 * shapes and the one that works is remembered for the rest of the session.
 */

const winningShape = {};

function message(err) {
  return err && err.message ? String(err.message) : String(err);
}

/**
 * Run the first variant that succeeds. Variants are [label, fn] pairs.
 * Once one works for a given operation it is used directly from then on.
 */
async function attempt(operation, variants) {
  const remembered = winningShape[operation];
  if (remembered) {
    const match = variants.find((v) => v[0] === remembered);
    if (match) {
      try {
        return await match[1]();
      } catch (err) {
        delete winningShape[operation];
        throw err;
      }
    }
  }

  const failures = [];
  for (const [label, run] of variants) {
    try {
      const result = await run();
      winningShape[operation] = label;
      spindle.log.info(`Lorebook Web Scraper: ${operation} succeeded using ${label}`);
      return result;
    } catch (err) {
      failures.push(`  ${label} → ${message(err)}`);
    }
  }
  throw new Error(`${operation} failed in every call shape:\n${failures.join('\n')}`);
}

function partsToText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((part) => part && part.type === 'text' && typeof part.text === 'string')
    .map((part) => part.text)
    .join('');
}

function textOf(body) {
  if (typeof body === 'string') return body;
  if (body == null) return '';
  return String(body);
}

/** The host may hand back {data:[...]}, a bare array, or {books:[...]}. */
function asBookList(result) {
  if (!result) return [];
  if (Array.isArray(result)) return result;
  if (Array.isArray(result.data)) return result.data;
  if (Array.isArray(result.books)) return result.books;
  if (Array.isArray(result.items)) return result.items;
  return [];
}

/** Count tokens via the host if possible, else estimate from characters. */
async function countTokens(text, userId) {
  const t = spindle.tokens;
  if (t) {
    const tries = [
      () => t.count({ text, userId }),
      () => t.count(text, userId),
      () => t.count({ content: text, userId }),
    ];
    for (const run of tries) {
      try {
        const r = await run();
        const n = typeof r === 'number' ? r
          : r && typeof r.count === 'number' ? r.count
          : r && typeof r.tokens === 'number' ? r.tokens
          : Array.isArray(r) ? r.length
          : null;
        if (typeof n === 'number' && n > 0) return { tokens: n, exact: true };
      } catch (e) { /* try the next shape */ }
    }
  }
  return { tokens: Math.ceil(text.length / 4), exact: false };
}

async function grantedList() {
  try {
    const granted = await spindle.permissions.getGranted();
    return Array.isArray(granted) ? granted : [];
  } catch (err) {
    return [`<could not read: ${message(err)}>`];
  }
}

/**
 * The handler's userId argument is the primary source. If the host leaves it
 * empty, fall back to whatever the frontend could see, then to the users API.
 */
async function resolveUserId(handlerUserId, payload) {
  if (handlerUserId) return { id: handlerUserId, from: 'message handler' };
  if (payload && payload.clientUserId) return { id: payload.clientUserId, from: 'frontend context' };

  const probes = [
    ['users.getCurrent', () => spindle.users.getCurrent()],
    ['users.current', () => spindle.users.current()],
    ['users.me', () => spindle.users.me()],
    ['users.list', () => spindle.users.list({ limit: 1 })],
  ];
  for (const [label, run] of probes) {
    try {
      const result = await run();
      const found = Array.isArray(result) ? result[0]
        : result && Array.isArray(result.data) ? result.data[0]
        : result;
      if (found && found.id) return { id: found.id, from: label };
    } catch (err) { /* try the next probe */ }
  }
  return { id: undefined, from: 'nowhere — none of the sources had one' };
}




/** Host error text can surface where content is expected; never treat it as output. */
const ERROR_PHRASES = [
  'deadline has expired',
  'unknown provider',
  'no connection profile',
  'permission_denied',
  'rate limit',
  'timed out',
  'timeout',
  'request failed',
  'internal error',
];

function looksLikeError(text) {
  if (typeof text !== 'string') return false;
  const t = text.trim().toLowerCase();
  if (t.length > 400) return false;          // long output is real content
  return ERROR_PHRASES.some((p) => t.includes(p));
}

/** Find the longest string anywhere in a response object, with its path. */
function deepestString(value, path, depth) {
  const p = path || '$';
  const d = depth || 0;
  if (typeof value === 'string') return { text: value, path: p };
  if (!value || typeof value !== 'object' || d > 6) return { text: '', path: p };

  let best = { text: '', path: p };
  const entries = Array.isArray(value)
    ? value.map((v, i) => [String(i), v])
    : Object.entries(value);

  for (const [key, child] of entries) {
    if (/^(id|uuid|model|role|type|status|provider|finishReason|stop_reason)$/i.test(key)) continue;
    const found = deepestString(child, `${p}.${key}`, d + 1);
    if (found.text.length > best.text.length) best = found;
  }
  return best;
}

/**
 * One generation path shared by condensing and cue writing, so whatever call
 * shape works for one works for the other. Records the winning shape and
 * reuses it for the rest of the session.
 */
let generationShape = null;

async function runGeneration(prompt, opts) {
  const o = opts || {};
  opts = o;
  const gen = spindle.generate;
  if (!gen || typeof gen !== 'object') throw new Error('spindle.generate is unavailable.');

  const body = {
    messages: [{ role: 'user', content: prompt }],
    maxTokens: o.maxTokens || 1024,
    temperature: typeof o.temperature === 'number' ? o.temperature : 0.3,
    userId: o.userId,
  };

  const readText = (r) => (
    typeof r === 'string' ? r
    : r && typeof r.text === 'string' ? r.text
    : r && typeof r.content === 'string' ? r.content
    : r && typeof r.output === 'string' ? r.output
    : r && r.message && typeof r.message.content === 'string' ? r.message.content
    : r && Array.isArray(r.content) ? partsToText(r.content)
    : r && r.choices && r.choices[0] && r.choices[0].message
      ? String(r.choices[0].message.content || '')
    : ''
  ).trim();

  const methods = Object.keys(gen).filter((k) => typeof gen[k] === 'function');
  const order = ['quiet', 'raw', 'quietTracked', 'batch'].filter((m) => methods.includes(m));

  // connections.list on this build takes the user id as a bare first argument
  // rather than inside an options object, so generation very likely does too.
  // Positional shapes are tried first for that reason. The list is kept short:
  // every failed attempt costs a round trip, and too many blow the host's
  // interceptor deadline before a working shape is reached.
  const withConn = (obj) => (opts.connectionId ? { ...obj, connectionId: opts.connectionId } : obj);
  const bare = { messages: body.messages, maxTokens: body.maxTokens, temperature: body.temperature };

  const buildVariants = (m) => [
    [`${m}|userId,body+conn`, () => gen[m](opts.userId, withConn(bare))],
    [`${m}|userId,body`, () => gen[m](opts.userId, bare)],
    [`${m}|body.userId+conn`, () => gen[m](withConn({ ...bare, userId: opts.userId }))],
    [`${m}|body.userId`, () => gen[m]({ ...bare, userId: opts.userId })],
  ];

  const variants = [];
  if (generationShape) {
    const m = generationShape.split('|')[0];
    if (order.includes(m)) {
      for (const v of buildVariants(m)) if (v[0] === generationShape) variants.push(v);
    }
  }
  for (const m of order) {
    for (const v of buildVariants(m)) {
      if (v[0] !== generationShape) variants.push(v);
    }
  }

  const failures = [];
  for (const [label, run] of variants) {
    try {
      const raw = await run();
      const out = readText(raw);
      if (out && looksLikeError(out)) {
        failures.push(`${label}: host error "${out.trim().slice(0, 60)}"`);
        continue;
      }
      if (out) {
        if (generationShape !== label) {
          generationShape = label;
          spindle.log.info(`Lorebook Web Scraper: generation works via ${label}`);
        }
        return out;
      }

      // The call succeeded but the text is somewhere unexpected. Walk the object
      // for the longest string so the response shape does not have to be guessed.
      const found = deepestString(raw);
      if (found.text && looksLikeError(found.text)) {
        failures.push(`${label}: host error "${found.text.trim().slice(0, 60)}"`);
        continue;
      }
      if (found.text && found.text.length > 20) {
        generationShape = label;
        spindle.log.info(`Lorebook Web Scraper: generation works via ${label}, text at ${found.path}`);
        return found.text.trim();
      }

      const shape = raw && typeof raw === 'object'
        ? `keys[${Object.keys(raw).join(',')}]`
        : typeof raw;
      failures.push(`${label}: no text, ${shape}`);
    } catch (err) {
      failures.push(`${label}: ${message(err)}`);
    }
  }

  throw new Error(`Generation failed in all ${variants.length} shapes. ${failures.join(' | ')}`);
}

spindle.onFrontendMessage(async (payload, handlerUserId) => {
  const resolved = await resolveUserId(handlerUserId, payload);
  const userId = resolved.id;
  const requestId = payload && payload.requestId;
  const reply = (body) => spindle.sendToFrontend({ requestId, ...body }, userId || handlerUserId);
  const fail = (error) => reply({ type: 'lws:error', error });

  if (!payload || typeof payload.type !== 'string') return;
  if (!payload.type.startsWith('lws:')) return;

  const books = () => spindle.world_books;
  const entries = () => spindle.world_books.entries;

  try {
    switch (payload.type) {
      case 'lws:diag': {
        const granted = await grantedList();
        let cachedBooks = 'error';
        let cachedCors = 'error';
        try { cachedBooks = spindle.permissions.has('world_books'); } catch (e) { /* leave as error */ }
        try { cachedCors = spindle.permissions.has('cors_proxy'); } catch (e) { /* leave as error */ }

        return reply({
          type: 'lws:diag_result',
          backendVersion: '2.3.0',
          generateType: typeof spindle.generate,
          generateMethods: (spindle.generate && typeof spindle.generate === 'object')
            ? Object.keys(spindle.generate).filter((k) => typeof spindle.generate[k] === 'function').join(', ')
            : 'n/a',
          granted,
          userId: userId ? `${String(userId).slice(0, 8)}… (from ${resolved.from})` : `missing — ${resolved.from}`,
          cachedWorldBooks: cachedBooks,
          cachedCors,
          worldBooksApi: typeof spindle.world_books,
          entriesApi: spindle.world_books ? typeof spindle.world_books.entries : 'n/a',
          corsApi: typeof spindle.cors,
          shapes: Object.keys(winningShape).length
            ? Object.entries(winningShape).map(([k, v]) => `${k}=${v}`).join(', ')
            : 'none learned yet',
          spindleKeys: Object.keys(spindle || {}).sort().join(', '),
        });
      }

      case 'lws:list_books': {
        const options = { limit: 200, offset: 0 };
        let result;
        try {
          result = await attempt('world_books.list', [
            ['options.userId', () => books().list({ ...options, userId })],
            ['second argument', () => books().list(options, userId)],
            ['no userId', () => books().list(options)],
          ]);
        } catch (err) {
          const granted = await grantedList();
          return fail(`${message(err)}\nHost says these are granted: ${granted.length ? granted.join(', ') : '(none)'}`);
        }

        const list = asBookList(result)
          .map((b) => ({ id: b.id, name: b.name || b.title || '(unnamed)' }))
          .filter((b) => b.id);

        return reply({
          type: 'lws:books',
          books: list,
          rawShape: result && typeof result === 'object' ? Object.keys(result).join(', ') : typeof result,
          total: result && typeof result.total === 'number' ? result.total : list.length,
        });
      }

      case 'lws:create_book': {
        const name = String(payload.name || '').trim();
        if (!name) return fail('Give the new lorebook a name.');
        const input = { name, description: 'Created by Lorebook Web Scraper' };

        const book = await attempt('world_books.create', [
          ['second argument', () => books().create(input, userId)],
          ['input.userId', () => books().create({ ...input, userId })],
          ['no userId', () => books().create(input)],
        ]);

        return reply({ type: 'lws:book_created', book: { id: book.id, name: book.name } });
      }

      case 'lws:fetch': {
        const url = String(payload.url || '').trim();
        if (!/^https?:\/\//i.test(url)) return fail(`Not a usable URL: ${url}`);

        const init = {
          method: 'GET',
          responseType: 'text',
          headers: {
            Accept: 'text/html,application/xhtml+xml',
            'Accept-Language': 'en',
          },
        };

        const response = await attempt('cors', [
          ['no userId', () => spindle.cors(url, init)],
          ['third argument', () => spindle.cors(url, init, userId)],
        ]);

        const status = response && typeof response.status === 'number' ? response.status : 0;
        if (status >= 400 || status === 0) {
          return fail(`The server returned ${status || 'no response'} for ${url}`);
        }

        const html = textOf(response.body);
        if (html.length < 40) return fail(`That page came back empty (${url})`);

        return reply({ type: 'lws:fetched', url, html });
      }

      case 'lws:create_entry': {
        const bookId = String(payload.bookId || '').trim();
        if (!bookId) return fail('No lorebook selected.');
        const entry = payload.entry || {};

        const created = await attempt('world_books.entries.create', [
          ['third argument', () => entries().create(bookId, entry, userId)],
          ['input.userId', () => entries().create(bookId, { ...entry, userId })],
          ['no userId', () => entries().create(bookId, entry)],
        ]);

        return reply({ type: 'lws:entry_created', id: created && created.id, comment: entry.comment });
      }

      case 'lws:list_entries': {
        const bookId = String(payload.bookId || '').trim();
        if (!bookId) return fail('No lorebook selected.');

        const collected = [];
        let offset = 0;
        let total = 0;

        for (let page = 0; page < 40; page++) {
          const options = { limit: 200, offset };
          const result = await attempt('world_books.entries.list', [
            ['options.userId', () => entries().list(bookId, { ...options, userId })],
            ['third argument', () => entries().list(bookId, options, userId)],
            ['no userId', () => entries().list(bookId, options)],
          ]);

          const batch = result && Array.isArray(result.data) ? result.data
            : Array.isArray(result) ? result : [];
          if (typeof (result || {}).total === 'number') total = result.total;

          collected.push(...batch);
          if (batch.length < options.limit) break;
          offset += batch.length;
        }

        return reply({
          type: 'lws:entries',
          total: total || collected.length,
          entries: collected.map((e) => ({
            id: e.id,
            comment: e.comment || '(no label)',
            content: typeof e.content === 'string' ? e.content.slice(0, 6000) : '',
            vectorized: !!e.vectorized,
            keyCount: Array.isArray(e.key) ? e.key.length : 0,
            constant: !!e.constant,
            disabled: !!e.disabled,
            hasBackup: !!(e.extensions && e.extensions.lws_original_keys),
            key: Array.isArray(e.key) ? e.key : [],
            keysecondary: Array.isArray(e.keysecondary) ? e.keysecondary : [],
            extensions: e.extensions && typeof e.extensions === 'object' ? e.extensions : {},
          })),
        });
      }

      case 'lws:update_entry': {
        const entryId = String(payload.entryId || '').trim();
        if (!entryId) return fail('No entry id supplied.');
        const patch = payload.patch || {};

        const updated = await attempt('world_books.entries.update', [
          ['third argument', () => entries().update(entryId, patch, userId)],
          ['input.userId', () => entries().update(entryId, { ...patch, userId })],
          ['no userId', () => entries().update(entryId, patch)],
        ]);

        return reply({ type: 'lws:entry_updated', id: updated && updated.id });
      }

      case 'lws:list_connections': {
        const conn = spindle.connections;
        if (!conn || typeof conn.list !== 'function') {
          return reply({ type: 'lws:connections', connections: [], note: 'spindle.connections.list is not available on this build.' });
        }

        // Arity and source tell us the real signature when the docs don't.
        let signature = `arity=${conn.list.length}`;
        try {
          const src = Function.prototype.toString.call(conn.list);
          const head = src.slice(0, 200).replace(/\s+/g, ' ');
          signature += ` src=${head}`;
        } catch (e) { signature += ' src=unavailable'; }

        const options = { limit: 200, offset: 0 };
        const variants = [
          ['userId as string', () => conn.list(userId)],
          ['userId, options', () => conn.list(userId, options)],
          ['userId, {}', () => conn.list(userId, {})],
          ['options.userId', () => conn.list({ ...options, userId })],
          ['{userId}', () => conn.list({ userId })],
          ['options, userId', () => conn.list(options, userId)],
          ['options only', () => conn.list(options)],
          ['no arguments', () => conn.list()],
        ];

        let result;
        let usedShape = 'none';
        const failures = [];
        for (const [label, run] of variants) {
          try {
            const r = await run();
            if (r != null) { result = r; usedShape = label; break; }
            failures.push(`${label}: returned null`);
          } catch (err) {
            failures.push(`${label}: ${message(err)}`);
          }
        }

        const raw = Array.isArray(result) ? result
          : result && Array.isArray(result.data) ? result.data
          : result && Array.isArray(result.connections) ? result.connections
          : result && Array.isArray(result.items) ? result.items
          : result && Array.isArray(result.profiles) ? result.profiles
          : [];

        const connections = raw
          .map((c) => ({
            id: c.id || c.connectionId || c.uuid || c._id,
            name: c.name || c.label || c.displayName || c.title || c.model || '(unnamed)',
            model: c.model || c.modelId || '',
          }))
          .filter((c) => c.id);

        if (connections.length) {
          spindle.log.info(`Lorebook Web Scraper: connections.list worked via ${usedShape}`);
          return reply({ type: 'lws:connections', connections, note: `Loaded ${connections.length} via ${usedShape}.` });
        }

        return reply({
          type: 'lws:connections',
          connections: [],
          note: `connections.list signature: ${signature}`,
          detail: failures.slice(0, 8).join(' | '),
          rawKeys: result && typeof result === 'object' ? Object.keys(result).join(', ') : typeof result,
        });
      }

      case 'lws:condense': {
        const text = String(payload.text || '').trim();
        const targetTokens = Number(payload.targetTokens) || 150;
        const connectionId = payload.connectionId ? String(payload.connectionId) : undefined;
        const title = String(payload.title || 'this topic');
        const focus = String(payload.focus || '').trim();
        if (!text) return fail('Nothing to condense.');

        const hardLimit = Number(payload.hardLimit) || Math.ceil(targetTokens * 1.25);
        const aimWords = Math.round(targetTokens * 0.72);
        const maxWords = Math.round(hardLimit * 0.72);

        const focusMode = String(payload.focusMode || 'prioritise');

        let focusLine;
        if (!focus) {
          focusLine = [
            'SCOPE: General overview.',
            'Cover the subject broadly and proportionally: what it is, how it works, its main forms',
            'and its defining details. Do not over-weight any single section of the article.',
          ].join(' ');
        } else if (focusMode === 'only') {
          focusLine = [
            `SCOPE: Restricted. Write about ONE thing only: ${focus}.`,
            'This is not a summary of the article. Ignore every part of the source that does not',
            `bear directly on ${focus}, however prominent it is in the original. Omit background,`,
            'history, definitions of the wider subject, and adjacent topics entirely.',
            `If the article covers ${focus} only briefly, write only that much — a short accurate`,
            'entry is correct, padding it with general material is not.',
          ].join(' ');
        } else {
          focusLine = [
            `SCOPE: Weighted toward ${focus}.`,
            `Spend most of the entry on ${focus}, in concrete detail. Include wider context only`,
            'where it is needed to make that material intelligible, and keep it to a sentence or two.',
            'Do not drift into a general summary of the whole subject.',
          ].join(' ');
        }

        const prompt = [
          `Compress the reference article below into a lorebook entry about ${title}.`,
          '',
          focusLine,
          '',
          `LENGTH: Aim for ${aimWords} words. Never exceed ${maxWords} words.`,
          'Count as you write. If you are running long, cut the least relevant detail first.',
          'Select what matters, then write it out complete. Never truncate. Never stop mid-sentence.',
          '',
          'Rules:',
          '- Flowing prose, neutral encyclopedic register. No headings, no bullets, no markdown.',
          '- Keep concrete specifics: named techniques, mechanisms, terminology, cause and effect.',
          '- Remove citations, footnote numbers, see-also lists, navigation text and publication details.',
          '- Remove who studied it, when and where it was published. Keep only what it IS and how it works.',
          '- Do not address the reader. Do not mention the article, the source, or that this is a summary.',
          '- Output only the entry text: no preamble, no title, no closing remark.',
          '',
          focus ? `Reminder before you begin: ${focusMode === 'only' ? 'write only about' : 'centre the entry on'} ${focus}.` : '',
          '',
          'Article:',
          '"""',
          text.slice(0, 60000),
          '"""',
        ].join('\n');

        const maxTokens = Math.max(512, Math.ceil(hardLimit * 1.6));

        let condensed = '';
        try {
          condensed = await runGeneration(prompt, {
            maxTokens, temperature: 0.3, connectionId, userId,
          });
        } catch (err) {
          return fail(message(err));
        }
        if (!condensed) return fail('The condenser returned nothing.');

        // Models drift long. If it overshoots the ceiling, ask it to tighten rather
        // than truncating, so sentences stay whole.
        let finalText = condensed;
        let measured = await countTokens(finalText, userId);
        let passes = 0;

        while (measured.tokens > hardLimit && passes < 2) {
          passes++;
          const over = measured.tokens - hardLimit;
          const tightenPrompt = [
            `The note below is ${measured.tokens} tokens. It must be at most ${hardLimit} tokens`,
            `(about ${maxWords} words). Cut roughly ${over} tokens.`,
            '',
            'Remove the least essential detail, redundancy, and repeated framing.',
            'Keep the core definition, mechanisms, and terminology.',
            'Return complete sentences only. Do not truncate. Output only the shortened note.',
            '',
            '"""',
            finalText,
            '"""',
          ].join('\n');

          try {
            const tightened = await runGeneration(tightenPrompt, {
              maxTokens: Math.max(512, Math.ceil(hardLimit * 1.4)),
              temperature: 0.3,
              connectionId,
              userId,
            });
            if (!tightened) break;
            finalText = tightened;
            measured = await countTokens(finalText, userId);
          } catch (err) {
            spindle.log.error(`Lorebook Web Scraper: tighten pass failed - ${message(err)}`);
            break;
          }
        }

        return reply({
          type: 'lws:condensed',
          text: finalText,
          shape: generationShape || 'unknown',
          originalLength: text.length,
          tokens: measured.tokens,
          exactTokens: measured.exact,
          hardLimit,
          passes,
        });
      }

      case 'lws:expand_entry': {
        const content = String(payload.content || '').trim();
        const title = String(payload.title || 'this topic');
        const connectionId = payload.connectionId ? String(payload.connectionId) : undefined;
        const style = String(payload.style || '');
        if (!content) return fail('Entry has no content to expand.');

        const prompt = [
          'You are improving how a reference note is found by semantic search.',
          '',
          'The note below is written in formal clinical prose. The conversations that should surface it',
          'are informal narrative fiction, so the wording never overlaps and the note is never retrieved.',
          'Write retrieval cues that bridge that gap.',
          '',
          `Produce 4 to 6 short lines describing concrete situations, behaviours and phrasings that mean`,
          `${title} is happening, as they would actually appear in a scene rather than in a textbook.`,
          'Use plain narrative language: what someone does, says, feels, or notices.',
          'No clinical terms, no jargon, no definitions, no headings, no numbering.',
          'One situation per line, under fifteen words each.',
          style ? `Setting for context: ${style}` : '',
          '',
          'Output only those lines, nothing else.',
          '',
          'Note:',
          '"""',
          content.slice(0, 2500),
          '"""',
        ].filter(Boolean).join('\n');

        let out = '';
        try {
          out = await runGeneration(prompt, {
            maxTokens: 220, temperature: 0.5, connectionId, userId,
          });
        } catch (err) {
          return fail(message(err));
        }
        if (!out) return fail('The model returned nothing for this entry.');

        const cues = out.split('\n')
          .map((l) => l.replace(/^[-*\d.)\s]+/, '').trim())
          .filter((l) => l.length > 3)
          .slice(0, 6);

        return reply({ type: 'lws:expanded', cues });
      }

      default:
        return;
    }
  } catch (err) {
    const text = message(err);
    spindle.log.error(`Lorebook Web Scraper: ${text}`);
    if (text.includes('PERMISSION_DENIED')) {
      const granted = await grantedList();
      return fail(`${text}\nHost says these are granted: ${granted.length ? granted.join(', ') : '(none)'}`);
    }
    return fail(text);
  }
});


/* ------------------------------------------------------------------ */
/* Continue fix for Claude 4.6+                                        */
/* ------------------------------------------------------------------ */

/*
 * Anthropic removed assistant-message prefill at Opus 4.6. Any request whose
 * final message has role "assistant" is rejected with a 400 — "the
 * conversation must end with a user message". Lumiverse builds a Continue by
 * leaving the partial reply as the last message, so Continue fails on 4.6+
 * whenever that message survives context trimming.
 *
 * This interceptor only touches generationType === "continue". It lifts the
 * trailing assistant fragment out of the messages array and restates it inside
 * a final user turn asking for the continuation only. The request then ends on
 * a user message and is accepted.
 *
 * Lumiverse appends continue output to the existing chat message itself, so
 * the reply still grows in place rather than starting a new bubble.
 */

/** Messages carry either a plain string or an array of typed parts. */
function contentToText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((part) => part && part.type === 'text' && typeof part.text === 'string')
    .map((part) => part.text)
    .join('');
}

function continuationInstruction(fragment) {
  return [
    'Continue your previous reply from exactly where it stops. That reply so far was:',
    '',
    '<partial_reply>',
    fragment,
    '</partial_reply>',
    '',
    'You are resuming a reply that is already in progress. You are NOT starting a new one.',
    '',
    'Do not open a new status block, info panel, header, tracker, stat line, date or time line,',
    'location line, or any other structured block that normally begins one of your replies.',
    'Those belong at the start of a reply and this reply already started. If the partial text above',
    'already contains such a block, it has been written and must not be written again.',
    '',
    'Output only the continuation of the prose. Do not repeat any part of the text above, do not',
    'restate the last sentence, and do not open with a summary, preamble, or acknowledgement.',
    'Your output will be joined directly onto the end of that text, so begin with the exact next',
    'character - including a leading space if one is needed, or the rest of the word if it stops',
    'mid-word. Keep the same voice, tense, and formatting.',
  ].join('\n');
}

spindle.registerInterceptor(async (messages, context) => {
  const generationType = context && context.generationType;

  try {
    const roles = Array.isArray(messages) ? messages.map((m) => m && m.role).join(',') : 'not-an-array';
    spindle.log.info(`[continue-fix] invoked: generationType=${generationType} count=${Array.isArray(messages) ? messages.length : 0} tail=${roles.split(',').slice(-4).join(',')}`);

    if (generationType !== 'continue') return messages;
    if (!Array.isArray(messages) || !messages.length) return messages;

    // Find the last assistant turn that has no user turn after it. Some presets
    // append system blocks below the reply being continued, so the assistant
    // message is not always literally last.
    let index = -1;
    for (let i = messages.length - 1; i >= 0; i--) {
      const role = messages[i] && messages[i].role;
      if (role === 'user') break;
      if (role === 'assistant') { index = i; break; }
    }

    if (index === -1) {
      // Lumiverse already ends the prompt on a user turn, so no prefill rewrite is
      // needed. Append the no-new-status-block rule to that final turn instead,
      // which is the only place an instruction will actually reach the model.
      const lastIdx = messages.length - 1;
      const last = messages[lastIdx];
      if (!last || last.role !== 'user') {
        spindle.log.info('[continue-fix] prompt does not end on a user turn; leaving it alone');
        return messages;
      }

      const rule = [
        '',
        '',
        '[Continuation rules: you are resuming a reply already in progress, not starting a new one.',
        'Do not write a status block, info panel, header, tracker, or any Date / Time / Location /',
        'Present / Activity lines. Those belong only at the very start of a reply and this reply has',
        'already started. Continue the prose only, from exactly where it stops.]',
      ].join('\n');

      const existing = contentToText(last.content);
      if (existing.includes('[Continuation rules:')) return messages;

      const rebuilt = messages.slice(0, lastIdx);
      rebuilt.push({ ...last, content: existing + rule });

      spindle.log.info('[continue-fix] appended continuation rules to the final user turn');
      return {
        messages: rebuilt,
        breakdown: [{ messageIndex: rebuilt.length - 1, name: 'Continue rules' }],
      };
    }

    const fragment = contentToText(messages[index].content).replace(/\s+$/, '');
    if (!fragment) {
      spindle.log.info(`[continue-fix] assistant turn at ${index} had no text content — leaving prompt alone`);
      return messages;
    }

    const rebuilt = messages.slice(0, index).concat(messages.slice(index + 1));
    rebuilt.push({ role: 'user', content: continuationInstruction(fragment) });

    spindle.log.info(`[continue-fix] rewrote assistant turn ${index} as a trailing user turn (${fragment.length} chars, ${messages.length} → ${rebuilt.length} messages)`);

    return {
      messages: rebuilt,
      breakdown: [{ messageIndex: rebuilt.length - 1, name: 'Continue (prefill rewritten)' }],
    };
  } catch (err) {
    spindle.log.error(`[continue-fix] failed, passing prompt through unchanged: ${message(err)}`);
    return messages;
  }
}, 200);



/* ------------------------------------------------------------------ */
/* Continue: strip a duplicated opening block                          */
/* ------------------------------------------------------------------ */

/*
 * Replies here begin with a status board, so the model has learned that a block
 * of output starts with one. On a continue it writes another. Instructions lose
 * to dozens of in-history examples, so the board is removed after the fact
 * instead: anything from the first board marker onward is cut from the
 * continuation, since a board can only legitimately appear at the very start of
 * a reply and a continuation is never the start.
 */

const BOARD_MARKERS = [
  /\n[^\n]{0,4}(?:\u{1F4C5}|\u{1F5D3})/u,        // calendar emoji
  /\n[^\n]{0,4}(?:\u{1F552}|\u{23F0}|\u{1F570})/u, // clock emoji
  /\n[^\n]{0,4}(?:\u{1F5FA})/u,                   // map emoji
  /\n\s*\*{0,2}Date:\*{0,2}\s/i,
  /\n\s*\*{0,2}Time:\*{0,2}\s/i,
  /\n\s*\*{0,2}Location:\*{0,2}\s/i,
];

function stripTrailingBoard(text) {
  if (typeof text !== 'string' || !text) return { text, cut: 0 };
  let earliest = -1;
  for (const re of BOARD_MARKERS) {
    const m = re.exec(text);
    if (m && (earliest === -1 || m.index < earliest)) earliest = m.index;
  }
  if (earliest === -1) return { text, cut: 0 };
  const kept = text.slice(0, earliest).trimEnd();
  return { text: kept, cut: text.length - kept.length };
}

if (typeof spindle.registerMessageContentProcessor === 'function') {
  spindle.registerMessageContentProcessor(async (content, context) => {
    try {
      if (!context || context.generationType !== 'continue') return content;
      if (typeof content !== 'string') return content;
      const { text, cut } = stripTrailingBoard(content);
      if (cut > 0) spindle.log.info(`[continue] removed ${cut} chars of duplicated status board`);
      return text;
    } catch (err) {
      spindle.log.error(`[continue] board strip failed - ${message(err)}`);
      return content;
    }
  });
  spindle.log.info('Lorebook Web Scraper: continue board stripper registered.');
} else {
  spindle.log.info('Lorebook Web Scraper: registerMessageContentProcessor unavailable; board stripping disabled.');
}

spindle.log.info('Lorebook Web Scraper backend ready (v2.11). Continue fix registered.');
