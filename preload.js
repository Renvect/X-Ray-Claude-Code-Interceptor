/**
 * XRAY Preload — Claude Code npm Package Interceptor
 *
 * Injected before cli.js via NODE_OPTIONS=--import
 * Patches globalThis.fetch to capture full API request/response payloads,
 * process metadata, burst detection, stderr, and crash logging.
 *
 * Usage (automatic via claude-monitor.js):
 *   NODE_OPTIONS="--import /path/to/preload.js" ANTHROPIC_BASE_URL=http://127.0.0.1:3579 claude
 */

import fs   from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const LOG_DIR    = process.env.XRAY_LOG_DIR || path.dirname(fileURLToPath(import.meta.url));
const PKG_LOG    = path.join(LOG_DIR, 'package-capture.jsonl');
const STDERR_LOG = path.join(LOG_DIR, 'package-stderr.log');
const FS_READS_LOG = path.join(LOG_DIR, 'fs-reads.jsonl');

const startTime  = Date.now();

// ─── Current requestId — tags fs reads to the turn they happen in ─────────────
// Set when a fetch starts, cleared when response is received.
// Reads that happen BEFORE fetch (system prompt construction) get tagged with
// the PREVIOUS requestId — a turn_start marker in fs-reads.jsonl acts as separator.
let currentRequestId = null;

// ─── Path filter: only track files that could carry injected content ──────────
function shouldTrackPath(p) {
  if (!p || typeof p !== 'string') return false;
  const norm = p.toLowerCase().replace(/\\/g, '/');
  if (norm.includes('/node_modules/'))  return false;
  if (norm.includes('/.git/'))          return false;
  if (norm.endsWith('.map'))            return false;
  if (norm.endsWith('.js') || norm.endsWith('.ts')) return false;
  // Include anything that could contain injected prompt content
  if (norm.endsWith('.md'))                    return true;  // CLAUDE.md everywhere
  if (norm.includes('/.claude/'))              return true;  // Claude config dir
  if (norm.includes('memory'))                 return true;
  if (norm.includes('settings'))               return true;
  if (norm.includes('pinned'))                 return true;
  if (norm.includes('summary'))                return true;
  if (norm.includes('compact'))                return true;
  if (norm.includes('context'))                return true;
  if (norm.includes('prompt'))                 return true;
  return false;
}

function appendFsRead(p, bytes, stack) {
  if (!shouldTrackPath(p)) return;
  try {
    const frames = stack
      .split('\n')
      .slice(2, 9)               // skip Error header + appendFsRead + hook wrapper
      .map(l => l.trim())
      .filter(l => l.length > 0)
      .join(' | ');
    fs.appendFileSync(FS_READS_LOG, JSON.stringify({
      type:      'fs_read',
      ts:        new Date().toISOString(),
      requestId: currentRequestId,
      path:      p,
      bytes,
      estTok:    Math.round(bytes / 4),
      stack:     frames,
    }) + '\n');
  } catch (_) {}
}

// ─── Hook Node.js fs module reads ────────────────────────────────────────────
// Intercepts readFileSync, fs.promises.readFile, and fs.readFile (callback).
// Runs before cli.js is loaded so all reads from the bundle are captured.
;(function hookFsReads() {
  // ── readFileSync ──
  const origReadFileSync = fs.readFileSync;
  fs.readFileSync = function xrayReadFileSync(filePath, options) {
    const result = origReadFileSync.apply(this, arguments);
    try {
      const p   = typeof filePath === 'string' ? filePath : (filePath?.toString?.() ?? '');
      const buf = Buffer.isBuffer(result) ? result : Buffer.from(String(result));
      appendFsRead(p, buf.length, new Error().stack);
    } catch (_) {}
    return result;
  };

  // ── fs.promises.readFile (async/await) ──
  const origPromisesReadFile = fs.promises.readFile;
  fs.promises.readFile = function xrayPromisesReadFile(filePath, options) {
    const p     = typeof filePath === 'string' ? filePath : (filePath?.toString?.() ?? '');
    const stack = new Error().stack;
    return origPromisesReadFile.apply(this, arguments).then(result => {
      try {
        const buf = Buffer.isBuffer(result) ? result : Buffer.from(String(result));
        appendFsRead(p, buf.length, stack);
      } catch (_) {}
      return result;
    });
  };

  // ── fs.readFile (callback-style) ──
  const origReadFile = fs.readFile;
  fs.readFile = function xrayReadFile(filePath, options, callback) {
    const p     = typeof filePath === 'string' ? filePath : (filePath?.toString?.() ?? '');
    const stack = new Error().stack;
    const cb    = typeof options === 'function' ? options : callback;
    const opts  = typeof options === 'function' ? undefined : options;
    const wrapped = function(err, data) {
      if (!err && data) {
        try {
          const buf = Buffer.isBuffer(data) ? data : Buffer.from(String(data));
          appendFsRead(p, buf.length, stack);
        } catch (_) {}
      }
      if (typeof cb === 'function') cb.apply(this, arguments);
    };
    return opts !== undefined
      ? origReadFile.call(this, filePath, opts, wrapped)
      : origReadFile.call(this, filePath, wrapped);
  };
})();

// ─── In-flight request tracker (burst detection) ────────────────────────────
const inFlight = new Map(); // endpoint → [{startTs, requestId}]

// ─── Append to capture log ────────────────────────────────────────────────────
function appendCapture(entry) {
  try { fs.appendFileSync(PKG_LOG, JSON.stringify(entry) + '\n'); } catch (_) {}
}

// ─── 1. Capture process startup metadata ─────────────────────────────────────
appendCapture({
  type:        'process_start',
  ts:          new Date().toISOString(),
  pid:         process.pid,
  nodeVersion: process.version,
  argv:        process.argv,      // ALL flags passed to claude
  env: {
    ANTHROPIC_BASE_URL:                    process.env.ANTHROPIC_BASE_URL        || null,
    ANTHROPIC_MODEL:                       process.env.ANTHROPIC_MODEL           || null,
    CLAUDE_CODE_MAX_OUTPUT_TOKENS:         process.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS || null,
    CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS: process.env.CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS || null,
    NODE_OPTIONS:                          process.env.NODE_OPTIONS              || null,
    XRAY_LOG_DIR:                          process.env.XRAY_LOG_DIR              || null,
  },
});

// ─── 2. Helpers ──────────────────────────────────────────────────────────────
function serializeHeaders(headers) {
  if (!headers) return {};
  if (typeof headers.entries === 'function') {
    return Object.fromEntries(headers.entries());
  }
  if (typeof headers === 'object') return { ...headers };
  return {};
}

function countCacheMarkers(messages) {
  if (!Array.isArray(messages)) return 0;
  let count = 0;
  for (const msg of messages) {
    if (Array.isArray(msg.content)) {
      for (const block of msg.content) {
        if (block && block.cache_control) count++;
      }
    }
  }
  return count;
}

function extractUsageFromSse(text) {
  // Find last usage object in SSE stream (message_delta event carries it)
  let lastUsage = null;
  const re = /"usage":\s*\{([^}]+)\}/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    try { lastUsage = JSON.parse('{' + m[1] + '}'); } catch (_) {}
  }
  return lastUsage;
}

function buildWagonSummary(requestBody, headers) {
  if (!requestBody) return null;
  const h = serializeHeaders(headers);
  return {
    model:         requestBody.model       || null,
    messageCount:  Array.isArray(requestBody.messages) ? requestBody.messages.length : 0,
    hasSystem:     !!requestBody.system,
    systemBlocks:  Array.isArray(requestBody.system)
                     ? requestBody.system.length
                     : (requestBody.system ? 1 : 0),
    toolCount:     Array.isArray(requestBody.tools) ? requestBody.tools.length : 0,
    maxTokens:     requestBody.max_tokens  || null,
    stream:        requestBody.stream      || false,
    hasThinking:   requestBody.thinking?.type === 'enabled',
    cacheMarkers:  countCacheMarkers(requestBody.messages),
    betaHeader:    h['anthropic-beta']     || null,
    stainlessHelper: h['x-stainless-helper'] || null,
    apiKey:        h['x-api-key'] ? '[present]' : null,
  };
}

// ─── Block-level analysis (no base64 content — metadata only) ────────────────
const prevRequestState = new Map(); // endpoint → { msgCount, imageFingerprints }

function fingerprint(block) {
  // Quick fingerprint for image dedup — first 64 chars of base64 + length
  if (block.type === 'image' && block.source?.data) {
    return block.source.data.slice(0, 64) + ':' + block.source.data.length;
  }
  return null;
}

function buildBlockSummary(messages, endpoint) {
  if (!Array.isArray(messages) || messages.length === 0) return null;

  const prev      = prevRequestState.get(endpoint) || { msgCount: 0, imageFingerprints: [] };
  const isNew     = (i) => i >= prev.msgCount;
  const prevFps   = new Set(prev.imageFingerprints);

  const images        = [];
  const thinkingBlocks= [];
  const largeToolRes  = [];
  const writeBlocks   = [];

  messages.forEach((msg, i) => {
    const blocks = Array.isArray(msg.content) ? msg.content : [];
    blocks.forEach(block => {
      if (!block || typeof block !== 'object') return;

      if (block.type === 'image') {
        const bytes = block.source?.data?.length || 0;
        const fp    = fingerprint(block);
        images.push({
          msgIdx:   i,
          role:     msg.role,
          bytes,
          estTok:   Math.round(bytes / 4),
          mimeType: block.source?.media_type || null,
          isNew:    isNew(i),
          isRepeat: fp ? prevFps.has(fp) : false,
        });
      }

      if (block.type === 'thinking') {
        const chars = typeof block.thinking === 'string' ? block.thinking.length : 0;
        if (chars > 0) thinkingBlocks.push({ msgIdx: i, chars, isNew: isNew(i) });
      }

      if (block.type === 'tool_result') {
        const content = typeof block.content === 'string'
          ? block.content
          : JSON.stringify(block.content || '');
        const chars = content.length;
        if (chars > 2000) {
          largeToolRes.push({
            msgIdx:      i,
            toolUseId:   block.tool_use_id || null,
            chars,
            estTok:      Math.round(chars / 4),
            isNew:       isNew(i),
          });
        }
      }

      if (block.type === 'tool_use' && block.name === 'Write') {
        const chars = typeof block.input?.content === 'string' ? block.input.content.length : 0;
        if (chars > 0) {
          writeBlocks.push({
            msgIdx:   i,
            filePath: block.input?.file_path || null,
            chars,
            estTok:   Math.round(chars / 4),
            isNew:    isNew(i),
          });
        }
      }
    });
  });

  // Update delta state
  const newImageFps = images.map(im => {
    const msg   = messages[im.msgIdx];
    const block = Array.isArray(msg?.content) && msg.content.find(b => b.type === 'image');
    return block ? fingerprint(block) : null;
  }).filter(Boolean);
  prevRequestState.set(endpoint, { msgCount: messages.length, imageFingerprints: newImageFps });

  return {
    totalMsgs:   messages.length,
    prevMsgCount: prev.msgCount,
    newMsgs:     messages.length - prev.msgCount,
    images,
    thinkingBlocks,
    largeToolRes,
    writeBlocks,
    totalImageBytes: images.reduce((s, im) => s + im.bytes, 0),
    totalImageEstTok: images.reduce((s, im) => s + im.estTok, 0),
    newImageCount:   images.filter(im => im.isNew).length,
    carriedImageCount: images.filter(im => !im.isNew).length,
  };
}

// ─── 3. Patch globalThis.fetch ────────────────────────────────────────────────
const originalFetch = globalThis.fetch;

if (!originalFetch) {
  appendCapture({ type: 'warn', ts: new Date().toISOString(), msg: 'globalThis.fetch not available — preload interception skipped' });
} else {

globalThis.fetch = async function xrayFetch(input, init) {
  const url = typeof input === 'string'
    ? input
    : (input && typeof input === 'object' && input.url) ? input.url : String(input);

  // Only intercept Anthropic / proxy calls
  const proxyBase  = process.env.ANTHROPIC_BASE_URL || '';
  const isAnthropicDirect = url.includes('api.anthropic.com');
  const isProxyCall = proxyBase && url.startsWith(proxyBase);
  if (!isAnthropicDirect && !isProxyCall) {
    return originalFetch.apply(this, arguments);
  }

  const requestId = `req_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  const startTs   = Date.now();

  // Tag fs reads from this point forward to this request turn.
  // Reads that built the system prompt happened BEFORE this fetch call —
  // the turn_start marker below acts as the separator in fs-reads.jsonl.
  currentRequestId = requestId;
  try {
    fs.appendFileSync(FS_READS_LOG, JSON.stringify({
      type:      'turn_start',
      ts:        new Date().toISOString(),
      requestId,
      url,
      endpoint: (() => { try { return new URL(url).pathname; } catch { return url; } })(),
    }) + '\n');
  } catch (_) {}

  // Read body before it's consumed (may be a ReadableStream, string, or Buffer)
  let bodyStr      = null;
  let requestBody  = null;
  let bodyConsumed = false;

  try {
    const rawBody = init?.body;
    if (rawBody == null) {
      bodyStr = null;
    } else if (typeof rawBody === 'string') {
      bodyStr = rawBody;
    } else if (rawBody instanceof Uint8Array || Buffer.isBuffer?.(rawBody)) {
      bodyStr = Buffer.from(rawBody).toString('utf8');
    } else if (rawBody && typeof rawBody.getReader === 'function') {
      // ReadableStream — tee it so we can read without consuming
      const [streamForCapture, streamForRequest] = rawBody.tee();
      const reader = streamForCapture.getReader();
      const chunks = [];
      let done = false;
      while (!done) {
        const result = await reader.read();
        done = result.done;
        if (result.value) chunks.push(result.value);
      }
      bodyStr = Buffer.concat(chunks.map(c => Buffer.from(c))).toString('utf8');
      // Replace body in init with the untouched stream
      init = { ...init, body: streamForRequest };
      bodyConsumed = true;
    } else {
      // Fallback: try Response wrapper
      bodyStr = await new Response(rawBody).text();
    }
    if (bodyStr) requestBody = JSON.parse(bodyStr);
  } catch (_) {}

  // ── Burst detection ──
  let endpoint;
  try { endpoint = new URL(url).pathname; } catch { endpoint = url; }
  const prevCalls   = inFlight.get(endpoint) || [];
  const recentCalls = prevCalls.filter(c => Date.now() - c.startTs < 30000);
  const isBurst     = recentCalls.length > 0;
  recentCalls.push({ startTs, requestId });
  inFlight.set(endpoint, recentCalls.slice(-10));

  const wagonSummary  = buildWagonSummary(requestBody, init?.headers);
  const blockSummary  = buildBlockSummary(requestBody?.messages || [], endpoint);

  // ── Log request capture (metadata only — no base64 body) ──
  appendCapture({
    type:          'request',
    ts:            new Date().toISOString(),
    requestId,
    url,
    endpoint,
    method:        init?.method || 'POST',
    headers:       serializeHeaders(init?.headers),
    wagonSummary,
    blockSummary,
    isBurst,
    burstCount:    recentCalls.length,
    bodyBytes:     bodyStr ? Buffer.byteLength(bodyStr, 'utf8') : 0,
  });

  // ── Alert on new large blocks (images or big tool results just introduced) ──
  if (blockSummary) {
    const newImages = blockSummary.images.filter(im => im.isNew);
    const newLarge  = blockSummary.largeToolRes.filter(b => b.isNew && b.estTok > 500);
    if (newImages.length > 0 || newLarge.length > 0) {
      appendCapture({
        type:       'large_block_alert',
        ts:         new Date().toISOString(),
        requestId,
        newImages:  newImages.map(im => ({ msgIdx: im.msgIdx, bytes: im.bytes, estTok: im.estTok, mimeType: im.mimeType })),
        newLarge:   newLarge.map(b  => ({ msgIdx: b.msgIdx, toolUseId: b.toolUseId, estTok: b.estTok })),
      });
    }
  }

  // ── Make the actual request ──
  let response;
  let firstByteTs = null;

  try {
    // Re-use original init; if we teed the stream, init.body was replaced above
    response = await originalFetch.apply(this, [input, init]);
    firstByteTs = Date.now();

    // ── Intercept streaming response ──
    if (requestBody?.stream && response.body) {
      let streamA, streamB;
      try {
        [streamA, streamB] = response.body.tee();
      } catch (_) {
        // tee() failed (already read), return as-is
        appendCapture({ type: 'warn', ts: new Date().toISOString(), requestId, msg: 'response.body.tee() failed' });
        return response;
      }

      // Read our copy in the background — don't block the main stream
      ;(async () => {
        const reader  = streamA.getReader();
        const decoder = new TextDecoder();
        let   fullSse = '';
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            fullSse += decoder.decode(value, { stream: true });
          }
        } catch (_) {}

        appendCapture({
          type:               'response_stream',
          ts:                 new Date().toISOString(),
          requestId,
          status:             response.status,
          durationMs:         Date.now() - startTs,
          firstByteMs:        firstByteTs ? firstByteTs - startTs : null,
          usage:              extractUsageFromSse(fullSse),
          compactionDetected: fullSse.includes('"type":"compaction"'),
          errorDetected:      fullSse.includes('"type":"error"'),
          rawSseBytes:        Buffer.byteLength(fullSse, 'utf8'),
        });
      })();

      // Return the untouched stream to the bundle
      return new Response(streamB, {
        status:     response.status,
        statusText: response.statusText,
        headers:    response.headers,
      });

    } else {
      // Non-streaming response — clone and read in background
      const cloned = response.clone();
      cloned.json().then(body => {
        appendCapture({
          type:       'response',
          ts:         new Date().toISOString(),
          requestId,
          status:     response.status,
          durationMs: Date.now() - startTs,
          usage:      body.usage || null,
          body,
        });
      }).catch(() => {});
      return response;
    }

  } catch (err) {
    appendCapture({
      type:       'request_error',
      ts:         new Date().toISOString(),
      requestId,
      url,
      error:      err.message,
      stack:      err.stack,
      durationMs: Date.now() - startTs,
    });
    throw err;
  }
};

} // end if (originalFetch)

// ─── 4. Capture stderr (warnings and internal errors from bundle) ─────────────
const origStderrWrite = process.stderr.write.bind(process.stderr);
process.stderr.write = function xrayStderrWrite(chunk, encoding, callback) {
  const text = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
  try {
    fs.appendFileSync(STDERR_LOG, text);
    // Also capture structured to package-capture.jsonl if it looks like an error
    if (/error|warn|fail|exception|throw/i.test(text) && text.trim().length > 0) {
      appendCapture({ type: 'stderr', ts: new Date().toISOString(), text: text.trim() });
    }
  } catch (_) {}
  return origStderrWrite(chunk, encoding, callback);
};

// ─── 5. Process-level error and exit capture ─────────────────────────────────
process.on('uncaughtException', (err, origin) => {
  appendCapture({
    type:   'uncaught_exception',
    ts:     new Date().toISOString(),
    error:  err.message,
    stack:  err.stack,
    origin,
  });
  // Re-throw so Node's default handler runs (prints and exits)
  throw err;
});

process.on('unhandledRejection', (reason, promise) => {
  appendCapture({
    type:   'unhandled_rejection',
    ts:     new Date().toISOString(),
    reason: String(reason),
    stack:  reason instanceof Error ? reason.stack : null,
  });
});

process.on('exit', (code) => {
  appendCapture({
    type:       'process_exit',
    ts:         new Date().toISOString(),
    exitCode:   code,
    durationMs: Date.now() - startTime,
  });
});

// ─── Startup confirmation ────────────────────────────────────────────────────
process.stderr.write('[XRAY preload] interceptor active — logging to ' + PKG_LOG + '\n');
process.stderr.write('[XRAY preload] fs-read hooks active — logging to ' + FS_READS_LOG + '\n');
