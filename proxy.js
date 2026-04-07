'use strict';

const http     = require('http');
const https    = require('https');
const fs       = require('fs');
const path     = require('path');
const cp       = require('child_process');
const readline = require('readline');

// ─── SSE Clients ─────────────────────────────────────────────────────────────
const sseClients = new Set();

function sseWrite(res, event, data) {
  try { res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); } catch (_) {}
}

function broadcast(event, data) {
  for (const res of sseClients) sseWrite(res, event, data);
}

// Heartbeat every 10s
setInterval(() => broadcast('heartbeat', {}), 10000);

// ─── Config ─────────────────────────────────────────────────────────────────
const PORT        = 3579;
const TARGET_HOST = 'api.anthropic.com';
const LOG_DIR     = __dirname;
const MANIFEST_LOG     = path.join(LOG_DIR, 'manifest.jsonl');
const SESSION_LOG      = path.join(LOG_DIR, 'session.jsonl');
const WAGON_LOG        = path.join(LOG_DIR, 'wagon.jsonl');
const PKG_CAPTURE_LOG  = path.join(LOG_DIR, 'package-capture.jsonl');
const BLOCKS_LOG       = path.join(LOG_DIR, 'blocks.jsonl');
const FS_READS_LOG     = path.join(LOG_DIR, 'fs-reads.jsonl');

// Token estimation: ~4 chars per token (rough but consistent)
const CHARS_PER_TOKEN = 4;

// ─── Runtime Config (toggled via /config endpoint) ───────────────────────────
const config = {
  stripping:       false, // master toggle — enables smart stripping
  stripKeepLast:   6,     // keep last N messages fully intact
  stripImages:     true,  // strip image base64 after stripImageAfter turns (always beneficial)
  stripImageAfter: 2,     // strip images older than this many messages from end
  stripThinking:   true,  // strip old thinking block content
};

// ─── Session State ───────────────────────────────────────────────────────────
const session = {
  startTime:        Date.now(),
  turnCount:        0,
  cumulativeTokens: { system: 0, tools: 0, messages: 0, total: 0 },
  prevTotalTokens:  0,
  prevSystemHash:   null,
  systemIdentical:  0,     // turns where system was identical to previous
  systemChanged:    0,     // turns where system changed
  systemChangeTurns: [],   // turn numbers where system changed
  // Wagon tracking
  sessionId:        null,  // ISO timestamp set on first turn
  prevMsgCount:     0,     // messages array length from previous turn
  // Strip tracking
  stripHistory:     [],    // { turn, beforeTokens, afterTokens, savedTokens, count, ts }
  // Block analysis tracking
  blocksHistory:    [],    // { turn, ts, analysis } — per-turn block-level breakdown
  // Section diff tracking — Map<header, { chars, tokens }> from previous turn
  prevSectionMap:   null,
};

// Last seen system blocks (full content) — served via /system endpoint
let lastSystem = null;

// ─── Utilities ───────────────────────────────────────────────────────────────

function appendLog(file, obj) {
  try { fs.appendFileSync(file, JSON.stringify(obj) + '\n'); } catch (_) {}
}

function est(chars) {
  return Math.round(chars / CHARS_PER_TOKEN);
}

function kb(bytes) {
  return (bytes / 1024).toFixed(1) + 'KB';
}

function fmt(n) {
  return n.toLocaleString();
}

function elapsed() {
  const ms  = Date.now() - session.startTime;
  const s   = Math.floor(ms / 1000);
  const m   = Math.floor(s / 60);
  const h   = Math.floor(m / 60);
  if (h > 0)  return `${h}h ${m % 60}m`;
  if (m > 0)  return `${m}m ${s % 60}s`;
  return `${s}s`;
}

function getMcpServer(name) {
  const m = (name || '').match(/^mcp__([^_]+)/);
  return m ? m[1] : null;
}

function contentLength(content) {
  if (!content) return 0;
  if (typeof content === 'string') return content.length;
  return JSON.stringify(content).length;
}

// ─── System Section Analysis ─────────────────────────────────────────────────

const KNOWN_SECTIONS = {
  'system':                       { origin: 'core', fixed: true,  fn: 'QpY()', desc: 'Tool permissions, hooks, prompt injection' },
  'doing tasks':                  { origin: 'core', fixed: true,  fn: 'dpY()', desc: 'Scope control, no gold-plating rules' },
  'executing actions with care':  { origin: 'core', fixed: true,  fn: 'cpY()', desc: 'Reversibility, blast radius, confirmations' },
  'using your tools':             { origin: 'core', fixed: true,  fn: 'lpY()', desc: 'Tool selection, parallelism patterns' },
  'tone and style':               { origin: 'core', fixed: true,  fn: 'apY()', desc: 'Emoji, conciseness, file format' },
  'output efficiency':            { origin: 'core', fixed: true,  fn: 'opY()', desc: 'Brevity rules' },
  'session-specific guidance':    { origin: 'core', fixed: true,  fn: 'rpY()', desc: 'Tool denial, subagent, search selection' },
  'committing changes with git':  { origin: 'core', fixed: true,  fn: 'lpY()', desc: 'Git commit/PR workflow rules' },
  'creating pull requests':       { origin: 'core', fixed: true,  fn: 'lpY()', desc: 'PR creation workflow' },
  'other common operations':      { origin: 'core', fixed: true,  fn: 'lpY()', desc: 'GitHub operations' },
  'auto memory':                  { origin: 'user', fixed: false, fn: 'bl8()', desc: 'Memory system — shrinks if memory empty' },
  'environment':                  { origin: 'env',  fixed: false, fn: 'glK()', desc: 'Platform, CWD, OS, git status' },
};

function classifySection(header) {
  const key = header.toLowerCase().replace(/^#+\s*/, '');
  const match = KNOWN_SECTIONS[key];
  if (match) return match;
  // Heuristic fallback
  const t = key.toLowerCase();
  if (t.includes('memory') || t.includes('remember'))             return { origin: 'user', fixed: false, fn: 'bl8()', desc: 'Memory system' };
  if (t.includes('skill') || t.includes('command'))               return { origin: 'user', fixed: false, fn: 'rpY()', desc: 'Skills/commands' };
  if (t.includes('environment') || t.includes('platform'))        return { origin: 'env',  fixed: false, fn: 'glK()', desc: 'Environment info' };
  if (t.includes('hook'))                                         return { origin: 'user', fixed: false, fn: 'ppY()', desc: 'Hooks config' };
  return { origin: 'unknown', fixed: null, fn: null, desc: null };
}

function parseBlockSections(text) {
  const lines = text.split('\n');
  const sections = [];
  let cur = { header: '(preamble)', depth: 0, startLine: 0, bodyLines: [] };

  for (let i = 0; i < lines.length; i++) {
    const hMatch = lines[i].match(/^(#{1,3})\s+(.+)/);
    if (hMatch) {
      if (cur.bodyLines.length || cur.header !== '(preamble)') sections.push(cur);
      cur = { header: hMatch[2].trim(), depth: hMatch[1].length, startLine: i, bodyLines: [] };
    } else {
      cur.bodyLines.push(lines[i]);
    }
  }
  if (cur.bodyLines.length || sections.length === 0) sections.push(cur);

  return sections.map(s => {
    const body = s.bodyLines.join('\n');
    const chars = (s.header === '(preamble)' ? 0 : s.header.length + s.depth + 1) + body.length;
    const meta = classifySection(s.header);
    return {
      header:    s.header,
      depth:     s.depth,
      chars,
      tokens:    est(chars),
      lineCount: s.bodyLines.length,
      startLine: s.startLine,
      origin:    meta.origin,
      fixed:     meta.fixed,
      fn:        meta.fn,
      desc:      meta.desc,
    };
  });
}

function simpleHash(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) {
    h = ((h << 5) - h + str.charCodeAt(i)) | 0;
  }
  return h;
}

// ─── Analysis ────────────────────────────────────────────────────────────────

/**
 * Per-turn block-level analysis — what's in context, what's new, image lifecycle.
 * Returns a compact metadata object (no base64 content).
 */
function buildBlockAnalysis(messages, toolIdMap, prevMsgCount) {
  if (!Array.isArray(messages)) return null;

  const images       = [];
  const thinkBlocks  = [];
  const largeTools   = [];
  const writeBlocks  = [];

  const fp = (block) => {
    if (block.type === 'image' && block.source?.data)
      return block.source.data.slice(0, 64) + ':' + block.source.data.length;
    return null;
  };

  messages.forEach((msg, i) => {
    const age    = messages.length - i;   // turns old (1 = most recent)
    const isNew  = i >= (prevMsgCount || 0);
    const blocks = Array.isArray(msg.content) ? msg.content : [];

    blocks.forEach(block => {
      if (!block || typeof block !== 'object') return;

      if (block.type === 'image') {
        const bytes = block.source?.data?.length || 0;
        images.push({ msgIdx: i, role: msg.role, age, bytes, estTok: Math.round(bytes / 4),
          mimeType: block.source?.media_type || null, isNew, fp: fp(block) });
      }

      if (block.type === 'thinking') {
        const chars = typeof block.thinking === 'string' ? block.thinking.length : 0;
        if (chars > 0) thinkBlocks.push({ msgIdx: i, age, chars, estTok: Math.round(chars / 4), isNew });
      }

      if (block.type === 'tool_result') {
        const content = typeof block.content === 'string' ? block.content
          : JSON.stringify(block.content || '');
        const chars = content.length;
        if (chars > 800) {
          const toolName = toolIdMap[block.tool_use_id] || 'unknown';
          largeTools.push({ msgIdx: i, age, toolName, chars, estTok: Math.round(chars / 4), isNew });
        }
      }

      if (block.type === 'tool_use' && block.name === 'Write') {
        const chars = typeof block.input?.content === 'string' ? block.input.content.length : 0;
        if (chars > 0) {
          writeBlocks.push({ msgIdx: i, age, filePath: block.input?.file_path || null,
            chars, estTok: Math.round(chars / 4), isNew });
        }
      }
    });
  });

  return {
    totalMsgs:          messages.length,
    prevMsgCount:       prevMsgCount || 0,
    newMsgs:            messages.length - (prevMsgCount || 0),
    images,
    thinkBlocks,
    largeTools,
    writeBlocks,
    imageTotalBytes:    images.reduce((s, x) => s + x.bytes, 0),
    imageTotalEstTok:   images.reduce((s, x) => s + x.estTok, 0),
    newImageCount:      images.filter(x => x.isNew).length,
    carriedImageCount:  images.filter(x => !x.isNew).length,
  };
}

function buildToolUseIdMap(messages) {
  const map = {};
  for (const msg of messages) {
    if (msg.role === 'assistant' && Array.isArray(msg.content)) {
      for (const b of msg.content) {
        if (b.type === 'tool_use' && b.id) map[b.id] = b.name || 'unknown';
      }
    }
  }
  return map;
}

function detectSystemBlockLabel(text) {
  const firstLine = text.trimStart().split('\n')[0].trim();
  if (firstLine.startsWith('#')) return firstLine.replace(/^#+\s*/, '').slice(0, 60);
  const t = text.toLowerCase();
  if (t.includes('you are claude') || (t.includes('anthropic') && t.includes('assistant'))) return 'Core Identity / Instructions';
  if (t.includes('memory') && (t.includes('remember') || t.includes('stored') || t.includes('past'))) return 'Memory';
  if (t.includes('skill') || t.includes('slash command')) return 'Skills / Commands';
  if (t.includes('platform:') || t.includes('working directory') || t.includes('shell:') || t.includes('os version')) return 'Environment';
  if (t.includes('hook') || t.includes('settings.json')) return 'Hooks / Config';
  if (t.includes('claude.md') || t.includes('project instruction')) return 'Project Context (CLAUDE.md)';
  if (t.includes('tool') && (t.includes('available') || t.includes('use the following'))) return 'Tool Instructions';
  return firstLine.slice(0, 60) || `Block`;
}

function analyzeSystem(system) {
  if (!system) return null;

  function buildBlock(text, i, cached) {
    const sections = parseBlockSections(text);
    const fixedTok    = sections.filter(s => s.fixed === true).reduce((a, s) => a + s.tokens, 0);
    const dynamicTok  = sections.filter(s => s.fixed !== true).reduce((a, s) => a + s.tokens, 0);
    return {
      i, chars: text.length, tokens: est(text.length), cached,
      label:    detectSystemBlockLabel(text),
      lines:    text.split('\n').length,
      headers:  [...text.matchAll(/^#{1,4}\s+(.+)$/gm)].map(m => m[1].trim()).slice(0, 30),
      preview:  text.slice(0, 600),
      sections,
      fixedTok,
      dynamicTok,
    };
  }

  let perBlock, allText;

  if (typeof system === 'string') {
    const b = buildBlock(system, 0, null);
    perBlock = [b];
    allText = system;
  } else if (Array.isArray(system)) {
    perBlock = system.map((b, i) => {
      const text = b.text || JSON.stringify(b);
      return buildBlock(text, i, b.cache_control?.type || null);
    });
    allText = system.map(b => b.text || JSON.stringify(b)).join('\n\n');
  } else {
    return null;
  }

  const chars = perBlock.reduce((s, b) => s + b.chars, 0);
  const totalFixed   = perBlock.reduce((s, b) => s + b.fixedTok, 0);
  const totalDynamic = perBlock.reduce((s, b) => s + b.dynamicTok, 0);

  // Cross-turn change tracking
  const hash = simpleHash(allText);
  let systemChanged = false;
  if (session.prevSystemHash !== null) {
    if (hash !== session.prevSystemHash) {
      session.systemChanged++;
      session.systemChangeTurns.push(session.turnCount);
      systemChanged = true;
    } else {
      session.systemIdentical++;
    }
  }
  session.prevSystemHash = hash;

  // Store full content + sections for /system endpoint
  const fullBlocks = perBlock.map((pb, i) => ({
    ...pb,
    full: typeof system === 'string' ? system : (system[i].text || JSON.stringify(system[i])),
  }));
  lastSystem = {
    blocks: fullBlocks,
    totalFixed,
    totalDynamic,
    systemChanged,
    crossTurn: {
      identical: session.systemIdentical,
      changed:   session.systemChanged,
      changeTurns: session.systemChangeTurns.slice(-20),
    },
  };

  return {
    blocks:       perBlock.length,
    chars,
    tokens:       est(chars),
    cacheControl: perBlock.map(b => b.cached),
    perBlock,
    totalFixed,
    totalDynamic,
    systemChanged,
  };
}

// ─── Section Diff ─────────────────────────────────────────────────────────────
// Compares system prompt sections between turns to pinpoint what grew.
// Returns a diff object with added/removed/grown/shrunk arrays and a spike flag.

const SPIKE_TOKEN_THRESHOLD = 300; // alert when system prompt net-grows by this many tokens

function diffSections(prevMap, curSections) {
  if (!curSections || curSections.length === 0) return null;

  // Build current map keyed by header
  const curMap = new Map();
  for (const sec of curSections) curMap.set(sec.header, sec);

  if (!prevMap) {
    // First turn — record baseline, no diff to compute
    return { firstTurn: true };
  }

  const added   = [];
  const removed = [];
  const grown   = [];
  const shrunk  = [];
  let   unchanged = 0;

  for (const sec of curSections) {
    const prev = prevMap.get(sec.header);
    if (!prev) {
      added.push({ header: sec.header, chars: sec.chars, tokens: sec.tokens,
                   fn: sec.fn || null, origin: sec.origin || null });
    } else {
      const delta = sec.tokens - prev.tokens;
      if (Math.abs(delta) < 5) {
        unchanged++;
      } else if (delta > 0) {
        grown.push({ header: sec.header, prevTokens: prev.tokens, curTokens: sec.tokens,
                     delta, fn: sec.fn || null, origin: sec.origin || null });
      } else {
        shrunk.push({ header: sec.header, prevTokens: prev.tokens, curTokens: sec.tokens,
                      delta, fn: sec.fn || null, origin: sec.origin || null });
      }
    }
  }

  for (const [header, prev] of prevMap.entries()) {
    if (!curMap.has(header)) {
      removed.push({ header, tokens: prev.tokens });
    }
  }

  const totalAdded   = added.reduce((s, x) => s + x.tokens, 0)
                     + grown.reduce((s, x) => s + x.delta, 0);
  const totalRemoved = removed.reduce((s, x) => s + x.tokens, 0)
                     + shrunk.reduce((s, x) => s + Math.abs(x.delta), 0);
  const totalDelta   = totalAdded - totalRemoved;

  const isSpike = totalDelta >= SPIKE_TOKEN_THRESHOLD
               || grown.some(g => g.delta >= SPIKE_TOKEN_THRESHOLD)
               || added.some(a => a.tokens >= SPIKE_TOKEN_THRESHOLD);

  return { added, removed, grown, shrunk, unchanged, totalDelta, isSpike };
}

function analyzeTools(tools) {
  if (!Array.isArray(tools) || !tools.length) return null;
  const chars = JSON.stringify(tools).length;
  const perTool = tools.map(t => {
    const c = JSON.stringify(t).length;
    return { name: t.name, chars: c, tokens: est(c), mcp: !!getMcpServer(t.name) };
  }).sort((a, b) => b.tokens - a.tokens);
  return {
    count:    tools.length,
    chars,
    tokens:   est(chars),
    names:    tools.map(t => t.name),
    mcpNames: tools.map(t => t.name).filter(n => getMcpServer(n)),
    perTool,
  };
}

function analyzeMessages(messages, toolIdMap) {
  const stats = {
    total:            messages.length,
    byRole:           {},
    chars:            0,
    tokens:           0,
    toolUseBlocks:    0,
    toolResultBlocks: 0,
    toolResultByName: {},   // name → { count, chars, tokens, turns[] }
    mcpServers:       [],
    cacheBlocks:      0,
    textChars:        0,
  };
  const mcpSet = new Set();

  for (let i = 0; i < messages.length; i++) {
    const msg   = messages[i];
    const role  = msg.role;
    stats.byRole[role] = (stats.byRole[role] || 0) + 1;

    const msgStr = JSON.stringify(msg);
    stats.chars += msgStr.length;

    if (!Array.isArray(msg.content)) continue;

    for (const block of msg.content) {
      if (block.cache_control) stats.cacheBlocks++;

      if (block.type === 'text') {
        stats.textChars += (block.text || '').length;

      } else if (block.type === 'tool_use') {
        stats.toolUseBlocks++;

      } else if (block.type === 'tool_result') {
        stats.toolResultBlocks++;
        const name  = toolIdMap[block.tool_use_id] || 'unknown';
        const chars = contentLength(block.content);

        if (!stats.toolResultByName[name]) {
          stats.toolResultByName[name] = { count: 0, chars: 0, tokens: 0, turns: [] };
        }
        stats.toolResultByName[name].count++;
        stats.toolResultByName[name].chars += chars;
        stats.toolResultByName[name].tokens += est(chars);
        stats.toolResultByName[name].turns.push(i);

        const srv = getMcpServer(name);
        if (srv) mcpSet.add(srv);
      }
    }
  }

  stats.tokens    = est(stats.chars);
  stats.mcpServers = [...mcpSet];
  return stats;
}

// ─── Wagon Inventory ─────────────────────────────────────────────────────────
// Builds a per-message breakdown of what the wagon is carrying and what's new.
// Returns { summary } for the SSE broadcast (compact) and { full } for wagon.jsonl.

const NPM_CMD_RE  = /\b(npm|yarn|pnpm|bun|pip|pip3|cargo|npx|deno)\b/i;
const PKG_FILE_RE = /package\.json|requirements\.txt|Cargo\.toml|go\.mod|Gemfile|pyproject\.toml/i;

function computeWagonInventory(messages, toolIdMap, tools, prevMsgCount) {
  if (!Array.isArray(messages)) return null;

  // ── Per-message inventory ──
  const inventory = messages.map((msg, idx) => {
    const msgStr = JSON.stringify(msg);
    const chars  = msgStr.length;
    const blocks = [];

    if (Array.isArray(msg.content)) {
      for (let bi = 0; bi < msg.content.length; bi++) {
        const block     = msg.content[bi];
        const blockStr  = JSON.stringify(block);
        const blockChars = blockStr.length;
        const entry     = {
          type:     block.type || 'unknown',
          chars:    blockChars,
          tokens:   est(blockChars),
        };
        if (block.type === 'tool_use') {
          entry.toolName = block.name || 'unknown';
          // Detect npm/package commands in Bash input
          if (block.name === 'Bash' && block.input?.command) {
            const m = block.input.command.match(NPM_CMD_RE);
            if (m) {
              entry.npmFlag = true;
              entry.npmCommand = block.input.command.slice(0, 200);
            }
          }
          // Detect Write/Edit/Read touching package files
          if (['Write', 'Edit', 'NotebookEdit', 'Read'].includes(block.name)) {
            const fp = block.input?.file_path || block.input?.notebook_path || '';
            if (fp && PKG_FILE_RE.test(fp)) {
              entry.npmFlag    = true;
              entry.npmCommand = `[pkg file ${block.name.toLowerCase()}] ${fp}`;
            }
          }
        } else if (block.type === 'tool_result') {
          entry.toolName = toolIdMap[block.tool_use_id] || 'unknown';
        }
        if (block.cache_control) entry.cacheControl = block.cache_control.type;
        blocks.push(entry);
      }
    }

    return { idx, role: msg.role, chars, tokens: est(chars), blocks };
  });

  // ── Delta: what's new this turn ──
  const newMessages  = messages.slice(prevMsgCount);
  let   newChars     = 0;
  const npmCommands  = [];
  for (let i = 0; i < newMessages.length; i++) {
    const inv = inventory[prevMsgCount + i];
    if (inv) newChars += inv.chars;
    // Collect npm flags from new messages only
    if (inv && Array.isArray(inv.blocks)) {
      for (const b of inv.blocks) {
        if (b.npmFlag) npmCommands.push({ msgIdx: prevMsgCount + i, command: b.npmCommand });
      }
    }
  }
  const newTokens   = est(newChars);
  const newMsgCount = newMessages.length;
  const growthRate  = newMsgCount > 0 ? Math.round(newTokens / newMsgCount) : 0;

  // ── Top 5 heaviest messages ──
  const sorted  = [...inventory].sort((a, b) => b.tokens - a.tokens);
  const heaviest = sorted.slice(0, 5).map(m => {
    const topBlock = m.blocks && m.blocks.length
      ? m.blocks.reduce((a, b) => b.tokens > a.tokens ? b : a, m.blocks[0])
      : null;
    return {
      idx:          m.idx,
      role:         m.role,
      tokens:       m.tokens,
      topBlockType: topBlock?.type || null,
      topBlockTool: topBlock?.toolName || null,
    };
  });

  // ── Tool definitions weight by server ──
  const toolsByServer = {};
  if (Array.isArray(tools)) {
    for (const t of tools) {
      const srv    = getMcpServer(t.name) || 'builtin';
      const chars  = JSON.stringify(t).length;
      toolsByServer[srv] = (toolsByServer[srv] || 0) + est(chars);
    }
  }

  const npmFlags = npmCommands.map(c => c.command);

  return {
    summary: {
      newMsgCount,
      newTokens,
      totalMsgCount: messages.length,
      growthRate,
      heaviest,
      npmFlags,
      toolsByServer,
    },
    full: {
      inventory,
      delta: { prevMsgCount, newMsgCount, newChars, newTokens },
      npmCommands,
    },
  };
}

// ─── Console Output ──────────────────────────────────────────────────────────

function printObservation(turn, bodyBytes, parsed, msgStats, sysStats, toolsStats, delta) {
  const totalTokens = (sysStats ? sysStats.tokens : 0)
    + (toolsStats ? toolsStats.tokens : 0)
    + msgStats.tokens;

  const deltaSign  = delta >= 0 ? '+' : '';

  // Sort tool results by chars desc
  const toolResults = Object.entries(msgStats.toolResultByName)
    .sort((a, b) => b[1].chars - a[1].chars);

  const toolResultTotalChars = toolResults.reduce((s, [, v]) => s + v.chars, 0);

  console.log(`\n╔═ [XRAY] Turn ${turn}  ·  Session ${elapsed()}  ══════════════════`);
  console.log(`║`);
  console.log(`║  PAYLOAD  ${kb(bodyBytes).padStart(9)}  ≈ ${fmt(totalTokens)} tokens  (${deltaSign}${fmt(delta)} this turn)`);
  console.log(`║  ─────────────────────────────────────────────────`);

  if (sysStats) {
    const cacheTag = sysStats.cacheControl.filter(Boolean).length
      ? `  [${sysStats.cacheControl.filter(Boolean).length} cached]`
      : '';
    console.log(`║  system prompt  : ${sysStats.blocks} blocks  ≈ ${fmt(sysStats.tokens)} tokens${cacheTag}`);
  }

  if (toolsStats) {
    const mcpServers = [...new Set(toolsStats.mcpNames.map(n => getMcpServer(n)))];
    const mcpTag = mcpServers.length ? `  [MCP: ${mcpServers.join(', ')}]` : '';
    console.log(`║  tool defs      : ${toolsStats.count} tools   ≈ ${fmt(toolsStats.tokens)} tokens${mcpTag}`);
    if (toolsStats.perTool) {
      const top5 = toolsStats.perTool.slice(0, 5);
      for (const t of top5) {
        const bar = '█'.repeat(Math.round(t.tokens / toolsStats.perTool[0].tokens * 12));
        console.log(`║    ${(t.name + (t.mcp ? ' ★' : '')).padEnd(36)} ${bar.padEnd(12)} ${fmt(t.tokens).padStart(6)} tok`);
      }
      if (toolsStats.perTool.length > 5) {
        console.log(`║    … +${toolsStats.perTool.length - 5} more tools`);
      }
    }
  }

  console.log(`║  messages       : ${msgStats.total} msgs    ≈ ${fmt(msgStats.tokens)} tokens`);
  console.log(`║    ├ user:  ${msgStats.byRole.user || 0}   assistant: ${msgStats.byRole.assistant || 0}`);
  console.log(`║    ├ tool_use results  : ${msgStats.toolResultBlocks} blocks  ≈ ${fmt(est(toolResultTotalChars))} tokens`);
  console.log(`║    └ text/other        : ${msgStats.toolUseBlocks} tool_use  +  text ≈ ${fmt(est(msgStats.textChars))} tokens`);
  console.log(`║  cache_control marks : ${msgStats.cacheBlocks}`);

  if (toolResults.length) {
    console.log(`║`);
    console.log(`║  TOOL RESULT CARGO (what the wagon is carrying)`);
    console.log(`║  ${'tool'.padEnd(28)} ${'calls'.padStart(5)}  ${'chars'.padStart(9)}  ${'~tokens'.padStart(8)}`);
    console.log(`║  ${'─'.repeat(54)}`);
    for (const [name, v] of toolResults) {
      const mcpTag = getMcpServer(name) ? ' ★' : '  ';
      console.log(`║  ${(name + mcpTag).padEnd(28)} ${String(v.count).padStart(5)}  ${String(v.chars).padStart(9)}  ${fmt(v.tokens).padStart(8)}`);
    }
    const pct = msgStats.chars > 0
      ? ((toolResultTotalChars / msgStats.chars) * 100).toFixed(0)
      : 0;
    console.log(`║  ${'─'.repeat(54)}`);
    console.log(`║  ${'TOTAL tool results'.padEnd(28)} ${String(msgStats.toolResultBlocks).padStart(5)}  ${String(toolResultTotalChars).padStart(9)}  ${fmt(est(toolResultTotalChars)).padStart(8)}  (${pct}% of messages)`);
  }

  if (msgStats.mcpServers.length) {
    console.log(`║`);
    console.log(`║  MCP servers active: ${msgStats.mcpServers.join(', ')}`);
  }

  console.log(`╚${'═'.repeat(56)}`);
}

// ─── Smart Stripping ─────────────────────────────────────────────────────────

// Per-tool strip thresholds for tool_result blocks.
// after: strip when message is older than (total - keepLast - after) from end
//        0 = use keepLast boundary; positive = extra buffer beyond keepLast
// minChars: only strip if content exceeds this char count
const STRIP_THRESHOLDS = {
  ExitPlanMode: { after: 2,  minChars: 0   },
  Write:        { after: 2,  minChars: 0   },
  Read:         { after: 0,  minChars: 1200 }, // ~300 tok
  Grep:         { after: 0,  minChars: 800  }, // ~200 tok
  Glob:         { after: 0,  minChars: 800  },
  Agent:        { after: 0,  minChars: 0   },
  Bash:         { after: 4,  minChars: 2000 }, // ~500 tok, extra buffer
};

function smartStrip(messages, cfg, toolIdMap) {
  const total   = messages.length;
  const keepFrom = Math.max(0, total - cfg.stripKeepLast);
  const stats   = { images: 0, thinking: 0, toolResults: 0, writeContent: 0, savedChars: 0 };

  const result = messages.map((msg, i) => {
    if (!Array.isArray(msg.content)) return msg;
    const age = total - i; // messages from the end (1 = most recent)

    const newContent = msg.content.map(block => {

      // ── Images ────────────────────────────────────────────────────────────
      if (block.type === 'image' && cfg.stripImages && age > cfg.stripImageAfter) {
        const chars = block.source?.data?.length || 0;
        if (chars === 0) return block;
        stats.images++;
        stats.savedChars += chars;
        return { type: 'text', text: `[image ~${est(chars)} tok stripped after ${age} turns — re-share if needed]` };
      }

      // ── Thinking blocks ───────────────────────────────────────────────────
      if (block.type === 'thinking' && cfg.stripThinking && age > 2) {
        const chars = contentLength(block.thinking);
        if (chars === 0) return block;
        stats.thinking++;
        stats.savedChars += chars;
        return { ...block, thinking: `[thinking stripped ~${est(chars)} tok]` };
      }

      // ── tool_use/Write — strip file body, keep path ───────────────────────
      if (block.type === 'tool_use' && block.name === 'Write' && age > 2) {
        const chars = contentLength(block.input?.content);
        if (chars === 0) return block;
        stats.writeContent++;
        stats.savedChars += chars;
        return { ...block, input: { ...block.input, content: `[file content stripped ~${est(chars)} tok]` } };
      }

      // ── tool_result — per-tool thresholds ────────────────────────────────
      if (block.type === 'tool_result') {
        const toolName  = (toolIdMap && toolIdMap[block.tool_use_id]) || 'unknown';
        const threshold = STRIP_THRESHOLDS[toolName];
        if (!threshold) return block;
        const stripBefore = keepFrom - threshold.after; // strip msgs older than this index
        if (i >= stripBefore) return block;             // within protected window
        const chars = contentLength(block.content);
        if (chars <= threshold.minChars) return block;
        stats.toolResults++;
        stats.savedChars += chars;
        return { ...block, content: `[${toolName} result stripped ~${est(chars)} tok]` };
      }

      return block;
    });

    return { ...msg, content: newContent };
  });

  return { messages: result, stats, savedTokens: est(stats.savedChars) };
}

// Legacy wrapper kept for backward compat
function stripMessages(messages, keepLast) {
  const r = smartStrip(messages, { ...config, stripKeepLast: keepLast, stripImages: false, stripThinking: false }, {});
  return { messages: r.messages, stripped: r.stats.toolResults, savedChars: r.stats.savedChars, savedTokens: r.savedTokens };
}

// ─── Session API Helpers ─────────────────────────────────────────────────────

// Stream-parse a JSONL file line by line (avoids buffering the whole file)
function streamJsonl(filePath, onEntry) {
  return new Promise((resolve, reject) => {
    if (!fs.existsSync(filePath)) { resolve(); return; }
    const rl = readline.createInterface({
      input:     fs.createReadStream(filePath),
      crlfDelay: Infinity,
    });
    rl.on('line', line => {
      if (!line.trim()) return;
      try { onEntry(JSON.parse(line)); } catch (_) {}
    });
    rl.on('close', resolve);
    rl.on('error', reject);
  });
}

// Read all sessions from manifest.jsonl, grouped by sessionId
async function readManifestSessions() {
  const sessions = new Map(); // id → {id, startTs, endTs, turns, maxTokens, totalTokens, model, topTool}

  await streamJsonl(MANIFEST_LOG, (entry) => {
    // Determine session: use explicit sessionId if present, else detect by turn===1
    const sid = entry.sessionId || (entry.turn === 1 ? entry.ts?.slice(0, 19).replace(/:/g, '-') : null);
    if (!sid) return;

    if (!sessions.has(sid)) {
      sessions.set(sid, {
        id:          sid,
        startTs:     entry.ts || null,
        endTs:       entry.ts || null,
        turns:       0,
        maxTokens:   0,
        totalTokens: 0,
        model:       entry.model || null,
        topTool:     null,
        _toolToks:   {},
      });
    }
    const s = sessions.get(sid);
    s.endTs      = entry.ts || s.endTs;
    s.turns++;
    s.model      = entry.model || s.model;
    const tok    = entry.tokens?.total || 0;
    if (tok > s.maxTokens) s.maxTokens = tok;
    s.totalTokens += (entry.tokens?.delta || 0);

    // Track top tool
    const tr = entry.messages?.toolResultByName || {};
    for (const [name, v] of Object.entries(tr)) {
      s._toolToks[name] = (s._toolToks[name] || 0) + (v.tokens || 0);
    }
  });

  // Finalise
  const result = [];
  for (const s of sessions.values()) {
    const topTool = Object.entries(s._toolToks).sort((a, b) => b[1] - a[1])[0]?.[0] || null;
    delete s._toolToks;
    s.topTool  = topTool;
    s.isActive = (s.id === session.sessionId);
    result.push(s);
  }
  // Sort newest first
  return result.sort((a, b) => (b.startTs || '').localeCompare(a.startTs || ''));
}

// Return all turns for a given sessionId from manifest.jsonl
async function readSessionTurns(sessionId) {
  const turns = [];
  await streamJsonl(MANIFEST_LOG, (entry) => {
    const sid = entry.sessionId || null;
    if (sid === sessionId) turns.push(entry);
    // Also catch old entries without sessionId: match by turn===1 boundary detection
    // (not perfect but best effort for pre-sessionId data)
  });
  return turns.sort((a, b) => (a.turn || 0) - (b.turn || 0));
}

// Return wagon inventory for a given sessionId+turn from wagon.jsonl
async function readWagonEntry(sessionId, turn) {
  let found = null;
  await streamJsonl(WAGON_LOG, (entry) => {
    if (!found && entry.sessionId === sessionId && entry.turn === turn) {
      found = entry;
    }
  });
  return found;
}

// Return package-capture entries correlated to a session time window
async function readPackageCapture(sessionId, startTs, endTs) {
  const entries = [];
  const start = startTs ? new Date(startTs).getTime() : 0;
  const end   = endTs   ? new Date(endTs).getTime() + 60000 : Date.now(); // +1 min buffer
  await streamJsonl(PKG_CAPTURE_LOG, (entry) => {
    const t = entry.ts ? new Date(entry.ts).getTime() : 0;
    if (t >= start && t <= end) entries.push(entry);
  });
  return entries;
}

// ─── Intercept ───────────────────────────────────────────────────────────────

function observeAndPassthrough(clientReq, clientRes, rawBody) {
  let parsed;
  try { parsed = JSON.parse(rawBody); } catch (_) {
    return forward(clientReq, clientRes, rawBody);
  }
  if (!parsed.messages) return forward(clientReq, clientRes, rawBody);

  session.turnCount++;
  const turn      = session.turnCount;
  const bodyBytes = Buffer.byteLength(rawBody);

  // Assign sessionId on first turn (ISO timestamp, colon-safe)
  if (!session.sessionId) {
    session.sessionId = new Date().toISOString().slice(0, 19).replace(/:/g, '-');
  }
  const sessionId = session.sessionId;

  const toolIdMap  = buildToolUseIdMap(parsed.messages);
  const msgStats   = analyzeMessages(parsed.messages, toolIdMap);
  const sysStats   = analyzeSystem(parsed.system);
  const toolsStats = analyzeTools(parsed.tools);

  // ── Section diff: compare system prompt sections to previous turn ──
  let sectionDiff    = null;
  let nextSectionMap = session.prevSectionMap; // updated below if system present
  if (sysStats) {
    // Flatten all sections across all system blocks
    const allSections = sysStats.perBlock.flatMap(b => b.sections || []);
    sectionDiff = diffSections(session.prevSectionMap, allSections);
    // Build new map for next turn
    nextSectionMap = new Map();
    for (const sec of allSections) {
      nextSectionMap.set(sec.header, { chars: sec.chars, tokens: sec.tokens });
    }
  }

  // Wagon inventory (new each turn)
  const wagonResult = computeWagonInventory(parsed.messages, toolIdMap, parsed.tools, session.prevMsgCount);

  const totalTokens = (sysStats?.tokens || 0) + (toolsStats?.tokens || 0) + msgStats.tokens;
  const delta = totalTokens - session.prevTotalTokens;

  printObservation(turn, bodyBytes, parsed, msgStats, sysStats, toolsStats, delta);

  // ── Spike alert (printed after the observation box) ──
  if (sectionDiff && !sectionDiff.firstTurn && sectionDiff.isSpike) {
    console.log(`\n  !! [SPIKE] system prompt grew +${sectionDiff.totalDelta} tok this turn`);
    for (const g of sectionDiff.grown) {
      console.log(`     ↑ "${g.header}"  ${g.prevTokens} → ${g.curTokens} tok  (+${g.delta})  [${g.fn || g.origin || '?'}]`);
    }
    for (const a of sectionDiff.added) {
      console.log(`     + "${a.header}"  +${a.tokens} tok  (new section)  [${a.fn || a.origin || '?'}]`);
    }
  }

  // ── manifest.jsonl (full structured record) ──
  appendLog(MANIFEST_LOG, {
    ts:          new Date().toISOString(),
    sessionId,
    sessionAge:  elapsed(),
    turn,
    model:       parsed.model,
    stream:      parsed.stream || false,

    tokens: {
      system:   sysStats?.tokens   || 0,
      tools:    toolsStats?.tokens || 0,
      messages: msgStats.tokens,
      total:    totalTokens,
      delta,
    },

    system: sysStats,
    sectionDiff: (sectionDiff && !sectionDiff.firstTurn) ? sectionDiff : null,

    tools: toolsStats ? {
      count:      toolsStats.count,
      tokens:     toolsStats.tokens,
      names:      toolsStats.names,
      mcpServers: [...new Set(toolsStats.mcpNames.map(n => getMcpServer(n)).filter(Boolean))],
    } : null,

    messages: {
      total:            msgStats.total,
      byRole:           msgStats.byRole,
      chars:            msgStats.chars,
      tokens:           msgStats.tokens,
      toolUseBlocks:    msgStats.toolUseBlocks,
      toolResultBlocks: msgStats.toolResultBlocks,
      toolResultByName: msgStats.toolResultByName,
      mcpServers:       msgStats.mcpServers,
      cacheBlocks:      msgStats.cacheBlocks,
      textTokens:       est(msgStats.textChars),
    },

    bodyBytes,
  });

  // ── wagon.jsonl (per-turn full message inventory) ──
  if (wagonResult) {
    appendLog(WAGON_LOG, {
      ts:        new Date().toISOString(),
      sessionId,
      turn,
      ...wagonResult.full,
    });
  }

  // ── session.jsonl (lightweight per-turn summary) ──
  appendLog(SESSION_LOG, {
    ts:        new Date().toISOString(),
    sessionId,
    turn,
    tokens:    totalTokens,
    model:     parsed.model,
    topTool:   Object.entries(msgStats.toolResultByName).sort((a,b) => b[1].chars - a[1].chars)[0]?.[0] || null,
  });

  // ── Broadcast to dashboard SSE clients ──
  broadcast('turn', {
    ts:          new Date().toISOString(),
    sessionId,
    sessionAge:  elapsed(),
    turn,
    model:       parsed.model,
    stream:      parsed.stream || false,
    tokens: {
      system:   sysStats?.tokens   || 0,
      tools:    toolsStats?.tokens || 0,
      messages: msgStats.tokens,
      total:    totalTokens,
      delta,
    },
    system:  sysStats,
    tools:   toolsStats ? {
      count:      toolsStats.count,
      tokens:     toolsStats.tokens,
      names:      toolsStats.names,
      mcpServers: [...new Set((toolsStats.names || []).filter(n => n.match(/^mcp__/)).map(n => n.split('__')[1]))],
      perTool:    toolsStats.perTool,
    } : null,
    messages: {
      total:            msgStats.total,
      byRole:           msgStats.byRole,
      chars:            msgStats.chars,
      tokens:           msgStats.tokens,
      toolUseBlocks:    msgStats.toolUseBlocks,
      toolResultBlocks: msgStats.toolResultBlocks,
      toolResultByName: msgStats.toolResultByName,
      mcpServers:       msgStats.mcpServers,
      cacheBlocks:      msgStats.cacheBlocks,
      textTokens:       est(msgStats.textChars),
    },
    wagon:       wagonResult ? wagonResult.summary : null,
    bodyBytes:   bodyBytes,
    sectionDiff: (sectionDiff && !sectionDiff.firstTurn) ? sectionDiff : null,
  });

  // ── Broadcast spike as a separate event for dashboard alerting ──
  if (sectionDiff && !sectionDiff.firstTurn && sectionDiff.isSpike) {
    broadcast('system_spike', {
      ts: new Date().toISOString(),
      sessionId,
      turn,
      totalDelta:  sectionDiff.totalDelta,
      added:       sectionDiff.added,
      grown:       sectionDiff.grown,
      removed:     sectionDiff.removed,
    });
  }

  // ── Block-level analysis (metadata only, no base64) ──
  const blockAnalysis = buildBlockAnalysis(parsed.messages, toolIdMap, session.prevMsgCount);
  if (blockAnalysis) {
    const blockEntry = { turn, ts: new Date().toISOString(), analysis: blockAnalysis };
    session.blocksHistory.push(blockEntry);
    broadcast('blocks', blockEntry);
    // Append to blocks.jsonl for deep inspection
    appendLog(path.join(LOG_DIR, 'blocks.jsonl'), blockEntry);
    // Alert if new images introduced
    const newImgs = blockAnalysis.images.filter(im => im.isNew);
    if (newImgs.length > 0) {
      console.log(`║  [BLOCKS] ${newImgs.length} NEW image(s) introduced: ` +
        newImgs.map(im => `msg[${im.msgIdx}] ~${fmt(im.estTok)} tok`).join(', '));
    }
    if (blockAnalysis.carriedImageCount > 0) {
      console.log(`║  [BLOCKS] ${blockAnalysis.carriedImageCount} image(s) carried (~${fmt(blockAnalysis.imageTotalEstTok)} tok total)`);
    }
  }

  // ── Update session state ──
  session.prevTotalTokens = totalTokens;
  session.prevMsgCount    = parsed.messages.length;
  if (nextSectionMap !== session.prevSectionMap) {
    session.prevSectionMap = nextSectionMap;
  }

  // ── Strip or passthrough ──
  if (config.stripping) {
    const beforeTokens = est(Buffer.byteLength(rawBody, 'utf8'));
    const { messages: stripped, stats, savedTokens } = smartStrip(parsed.messages, config, toolIdMap);
    const totalStripped = stats.images + stats.thinking + stats.toolResults + stats.writeContent;
    if (totalStripped > 0) {
      const modifiedBody = JSON.stringify({ ...parsed, messages: stripped });
      const afterTokens  = est(Buffer.byteLength(modifiedBody, 'utf8'));
      const stripEntry   = {
        turn, beforeTokens, afterTokens, savedTokens,
        count: totalStripped,
        images: stats.images, thinking: stats.thinking,
        toolResults: stats.toolResults, writeContent: stats.writeContent,
        ts: new Date().toISOString(),
      };
      session.stripHistory.push(stripEntry);
      const parts = [
        stats.images      && `${stats.images} img`,
        stats.thinking    && `${stats.thinking} think`,
        stats.toolResults && `${stats.toolResults} tool_result`,
        stats.writeContent && `${stats.writeContent} write`,
      ].filter(Boolean).join(', ');
      console.log(`║  [STRIP] ${parts}  saved ~${fmt(savedTokens)} tok  (${fmt(beforeTokens)} → ${fmt(afterTokens)} tok)`);
      broadcast('strip', stripEntry);
      return forward(clientReq, clientRes, modifiedBody);
    }
  }
  forward(clientReq, clientRes, rawBody);
}

// ─── Transparent Forward ─────────────────────────────────────────────────────

function forward(clientReq, clientRes, body) {
  const bodyBuf = body ? Buffer.from(body, 'utf8') : Buffer.alloc(0);
  const headers = {
    ...clientReq.headers,
    'host':           TARGET_HOST,
    'content-length': bodyBuf.length,
  };

  const options = {
    hostname: TARGET_HOST,
    port:     443,
    path:     clientReq.url,
    method:   clientReq.method,
    headers,
  };

  const proxyReq = https.request(options, proxyRes => {
    clientRes.writeHead(proxyRes.statusCode, proxyRes.headers);
    proxyRes.pipe(clientRes);  // stream passthrough — zero buffering
  });

  proxyReq.on('error', err => {
    console.error('[XRAY] upstream error:', err.message);
    if (!clientRes.headersSent) { clientRes.writeHead(502); clientRes.end('Bad Gateway'); }
  });

  if (bodyBuf.length > 0) proxyReq.write(bodyBuf);
  proxyReq.end();
}

// ─── Server ──────────────────────────────────────────────────────────────────

const DASHBOARD_PATH = path.join(__dirname, 'dashboard.html');

const server = http.createServer(async (req, res) => {
  // ── Dashboard HTML ──
  if (req.method === 'GET' && (req.url === '/' || req.url === '/dashboard')) {
    try {
      const html = fs.readFileSync(DASHBOARD_PATH);
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(html);
    } catch {
      res.writeHead(404); res.end('dashboard.html not found');
    }
    return;
  }

  // ── CORS preflight ──
  if (req.method === 'OPTIONS') {
    res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET,POST', 'Access-Control-Allow-Headers': 'Content-Type' });
    res.end(); return;
  }

  // ── System GET (full block content) ──
  if (req.method === 'GET' && req.url === '/system') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify(lastSystem || { blocks: [] })); return;
  }

  // ── Config GET ──
  if (req.method === 'GET' && req.url === '/config') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify(config)); return;
  }

  // ── Config POST ──
  if (req.method === 'POST' && req.url === '/config') {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (typeof body.stripping      === 'boolean') config.stripping      = body.stripping;
        if (typeof body.stripKeepLast  === 'number')  config.stripKeepLast  = body.stripKeepLast;
        if (typeof body.stripImages    === 'boolean') config.stripImages    = body.stripImages;
        if (typeof body.stripImageAfter === 'number') config.stripImageAfter = body.stripImageAfter;
        if (typeof body.stripThinking  === 'boolean') config.stripThinking  = body.stripThinking;
        console.log(`\n[XRAY] config updated:`, config);
        broadcast('config', config);
        res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
        res.end(JSON.stringify(config));
      } catch {
        res.writeHead(400); res.end('Bad JSON');
      }
    }); return;
  }

  // ── SSE endpoint ──
  if (req.method === 'GET' && req.url === '/events') {
    res.writeHead(200, {
      'Content-Type':  'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection':    'keep-alive',
      'Access-Control-Allow-Origin': '*',
    });
    res.write(':\n\n'); // comment to flush
    sseWrite(res, 'connected', { port: PORT });
    sseClients.add(res);
    req.on('close', () => sseClients.delete(res));
    return;
  }

  // ── GET /sessions — list all sessions from manifest.jsonl ──
  if (req.method === 'GET' && req.url === '/sessions') {
    try {
      const sessions = await readManifestSessions();
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify(sessions));
    } catch (err) {
      res.writeHead(500); res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  // ── GET /sessions/:id/turns — all turns for a session ──
  const sessionTurnsMatch = req.url?.match(/^\/sessions\/([^/?]+)\/turns(\?.*)?$/);
  if (req.method === 'GET' && sessionTurnsMatch) {
    try {
      const sid   = decodeURIComponent(sessionTurnsMatch[1]);
      const turns = await readSessionTurns(sid);
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify(turns));
    } catch (err) {
      res.writeHead(500); res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  // ── GET /wagon?turn=N[&session=S] — full wagon inventory ──
  if (req.method === 'GET' && req.url?.startsWith('/wagon')) {
    try {
      const params    = new URLSearchParams((req.url.includes('?') ? req.url.slice(req.url.indexOf('?') + 1) : ''));
      const turnNum   = parseInt(params.get('turn') || '0', 10);
      const targetSid = params.get('session') || session.sessionId;
      if (!targetSid || !turnNum) {
        res.writeHead(400); res.end(JSON.stringify({ error: 'Requires ?turn=N' })); return;
      }
      const entry = await readWagonEntry(targetSid, turnNum);
      if (!entry) {
        res.writeHead(404); res.end(JSON.stringify({ error: 'Wagon data not found. Session may predate wagon.jsonl feature.' })); return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify(entry));
    } catch (err) {
      res.writeHead(500); res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  // ── GET /package-capture?session=S — package-capture entries correlated to session ──
  if (req.method === 'GET' && req.url?.startsWith('/package-capture')) {
    try {
      const params    = new URLSearchParams((req.url.includes('?') ? req.url.slice(req.url.indexOf('?') + 1) : ''));
      const targetSid = params.get('session') || session.sessionId;
      // Find the session time window from the sessions list
      const sessions  = await readManifestSessions();
      const sess      = sessions.find(s => s.id === targetSid);
      const entries   = await readPackageCapture(targetSid, sess?.startTs, sess?.endTs);
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify(entries));
    } catch (err) {
      res.writeHead(500); res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  // ── GET /fs-reads/analyze — per-turn analysis of which files fed the system prompt ──
  // Groups reads by turn, computes timing relative to turn_start fetch call,
  // categorises files, and flags reads that happened before the fetch (= system prompt builders).
  if (req.method === 'GET' && req.url?.startsWith('/fs-reads/analyze')) {
    try {
      const allEntries = [];
      await streamJsonl(FS_READS_LOG, e => allEntries.push(e));

      const CATEGORIES = {
        commands:    p => /[\\/]commands[\\/]/.test(p) && p.endsWith('.md'),
        agents:      p => /[\\/]agents[\\/]/.test(p) && p.endsWith('.md'),
        skills:      p => /[\\/]skills[\\/]/.test(p) && p.endsWith('.md'),
        plugin_json: p => p.endsWith('plugin.json') || p.endsWith('marketplace.json'),
        memory:      p => /memory/i.test(p),
        settings:    p => /settings/i.test(p),
        summary:     p => /summary|compact/i.test(p),
        claude_md:   p => path.basename(p).toUpperCase() === 'CLAUDE.MD',
        changelog:   p => p.includes('changelog'),
        other:       () => true,
      };

      function categorize(p) {
        for (const [cat, test] of Object.entries(CATEGORIES)) {
          if (test(p)) return cat;
        }
        return 'other';
      }

      // Build turn groups
      const turns = [];
      let cur = null;
      let turnIdx = 0;
      for (const e of allEntries) {
        if (e.type === 'turn_start') {
          if (cur) turns.push(cur);
          cur = {
            turnIdx: turnIdx++,
            requestId: e.requestId,
            url: e.url,
            endpoint: e.endpoint,
            ts: e.ts,
            fetchTs: new Date(e.ts).getTime(),
            reads: [],
          };
        } else if (e.type === 'fs_read' && cur) {
          const readTs = new Date(e.ts).getTime();
          const msBeforeFetch = cur.fetchTs - readTs; // positive = happened BEFORE fetch
          cur.reads.push({
            path:        e.path,
            bytes:       e.bytes,
            estTok:      e.estTok,
            category:    categorize(e.path),
            msBeforeFetch,
            likelySystemPrompt: msBeforeFetch > 0 && msBeforeFetch < 2000, // read within 2s before fetch
            stack:       e.stack,
            ts:          e.ts,
          });
        }
      }
      if (cur) turns.push(cur);

      // Summarise each turn
      const analyzed = turns.map(t => {
        const byCategory = {};
        let systemPromptBytes = 0;
        for (const r of t.reads) {
          if (!byCategory[r.category]) byCategory[r.category] = { count: 0, bytes: 0, estTok: 0, files: [] };
          byCategory[r.category].count++;
          byCategory[r.category].bytes += r.bytes;
          byCategory[r.category].estTok += r.estTok;
          byCategory[r.category].files.push(path.basename(r.path));
          if (r.likelySystemPrompt) systemPromptBytes += r.bytes;
        }
        return {
          turnIdx:            t.turnIdx,
          requestId:          t.requestId,
          ts:                 t.ts,
          totalReads:         t.reads.length,
          totalBytes:         t.reads.reduce((s, r) => s + r.bytes, 0),
          totalEstTok:        t.reads.reduce((s, r) => s + r.estTok, 0),
          systemPromptBytes,
          systemPromptEstTok: Math.round(systemPromptBytes / 4),
          byCategory,
          reads:              t.reads,
        };
      });

      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({ turns: analyzed.length, data: analyzed }));
    } catch (err) {
      res.writeHead(500); res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  // ── GET /fs-reads[?turn=N&limit=200] — fs reads from npm package ──
  // Returns file-read events from fs-reads.jsonl, grouped by requestId.
  // Each group: { requestId, url, ts, reads: [{path,bytes,estTok,stack},...] }
  // Use ?turn=N to filter by a specific turn marker index (0-based).
  if (req.method === 'GET' && req.url?.startsWith('/fs-reads')) {
    try {
      const params  = new URLSearchParams(req.url.includes('?') ? req.url.slice(req.url.indexOf('?') + 1) : '');
      const limit   = Math.min(parseInt(params.get('limit') || '500', 10), 2000);
      const filterTurn = params.get('turn') !== null ? parseInt(params.get('turn'), 10) : null;

      // Read all entries from fs-reads.jsonl
      const allEntries = [];
      await streamJsonl(FS_READS_LOG, e => allEntries.push(e));

      // Group into turns by turn_start markers
      const turns = [];
      let cur = null;
      for (const e of allEntries) {
        if (e.type === 'turn_start') {
          if (cur) turns.push(cur);
          cur = { requestId: e.requestId, url: e.url, endpoint: e.endpoint, ts: e.ts, reads: [] };
        } else if (e.type === 'fs_read' && cur) {
          cur.reads.push({ path: e.path, bytes: e.bytes, estTok: e.estTok, stack: e.stack, ts: e.ts });
        }
      }
      if (cur) turns.push(cur);

      // Apply filters
      let result = filterTurn !== null ? [turns[filterTurn]].filter(Boolean) : turns;
      result = result.slice(-limit);

      // Add summary per turn
      result = result.map(t => ({
        ...t,
        totalBytes:  t.reads.reduce((s, r) => s + (r.bytes || 0), 0),
        totalEstTok: t.reads.reduce((s, r) => s + (r.estTok || 0), 0),
        readCount:   t.reads.length,
      }));

      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({ turns: result.length, data: result }));
    } catch (err) {
      res.writeHead(500); res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  // ── GET /strip-history ──
  if (req.method === 'GET' && req.url === '/strip-history') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify(session.stripHistory)); return;
  }

  // ── GET /blocks — full block analysis history for current session ──
  if (req.method === 'GET' && req.url === '/blocks') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify(session.blocksHistory)); return;
  }

  // ── GET /export — download all captured log data as JSON ──
  if (req.method === 'GET' && req.url === '/export') {
    try {
      const readJsonl = async (file) => {
        const lines = [];
        await streamJsonl(file, e => lines.push(e));
        return lines;
      };
      const [manifest, sessionLog, wagonLog, pkgCapture, blocksLog] = await Promise.all([
        readJsonl(MANIFEST_LOG),
        readJsonl(SESSION_LOG),
        readJsonl(WAGON_LOG),
        readJsonl(PKG_CAPTURE_LOG),
        readJsonl(BLOCKS_LOG).catch(() => []),
      ]);
      const bundle = {
        exportedAt:   new Date().toISOString(),
        config,
        session:      { ...session, stripHistory: session.stripHistory, blocksHistory: session.blocksHistory },
        manifest,
        sessionLog,
        wagonLog,
        blocksLog,
        pkgCapture,
      };
      const ts  = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      res.writeHead(200, {
        'Content-Type':        'application/json',
        'Content-Disposition': `attachment; filename="xray-export-${ts}.json"`,
        'Access-Control-Allow-Origin': '*',
      });
      res.end(JSON.stringify(bundle, null, 2));
    } catch (err) {
      res.writeHead(500); res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  // ── API interception or passthrough ──
  const chunks = [];
  req.on('data', chunk => chunks.push(chunk));
  req.on('end', () => {
    const body = Buffer.concat(chunks).toString('utf8');
    if (req.method === 'POST' && req.url && req.url.includes('/messages')) {
      observeAndPassthrough(req, res, body);
    } else {
      forward(req, res, body);
    }
  });
  req.on('error', err => {
    console.error('[XRAY] req error:', err.message);
    res.writeHead(400); res.end();
  });
});

server.listen(PORT, '127.0.0.1', () => {
  const url = `http://localhost:${PORT}`;
  console.log(`\n╔═ XRAY PROXY ════════════════════════════════════`);
  console.log(`║  Mode       :  OBSERVE ONLY (nothing modified)`);
  console.log(`║  Listening  :  ${url}`);
  console.log(`║  Dashboard  :  ${url}/`);
  console.log(`║  Target     :  https://${TARGET_HOST}`);
  console.log(`║  Manifest   :  ${MANIFEST_LOG}`);
  console.log(`║  Session    :  ${SESSION_LOG}`);
  console.log(`║  Wagon      :  ${WAGON_LOG}`);
  console.log(`║  FS Reads   :  ${FS_READS_LOG}`);
  console.log(`╠═ REST API ══════════════════════════════════════`);
  console.log(`║  GET /sessions              list sessions`);
  console.log(`║  GET /sessions/:id/turns    turns for session`);
  console.log(`║  GET /wagon?turn=N          full wagon inventory`);
  console.log(`║  GET /package-capture       npm package events`);
  console.log(`║  GET /fs-reads[?turn=N]     npm fs reads (raw)`);
  console.log(`║  GET /fs-reads/analyze      fs reads grouped+categorised by turn`);
  console.log(`╠═ To use ════════════════════════════════════════`);
  console.log(`║  export ANTHROPIC_BASE_URL=${url}`);
  console.log(`╚${'═'.repeat(48)}\n`);

  // Open dashboard in browser
  const open = process.platform === 'win32'
    ? ['cmd', ['/c', 'start', url]]
    : process.platform === 'darwin'
      ? ['open', [url]]
      : ['xdg-open', [url]];
  try { cp.spawn(open[0], open[1], { detached: true, stdio: 'ignore' }).unref(); } catch (_) {}
});
