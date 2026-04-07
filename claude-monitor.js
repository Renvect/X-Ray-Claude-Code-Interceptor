#!/usr/bin/env node
/**
 * XRAY Claude Monitor — Wrapper Launcher
 *
 * Launches the real claude binary with the XRAY preload injected,
 * routes API calls through the XRAY proxy, and captures process metadata.
 *
 * Usage:
 *   node claude-monitor.js [all normal claude args]
 *
 * Recommended: add an alias to your shell profile:
 *   alias claude="node /path/to/proxy/claude-monitor.js"
 *   # Windows (PowerShell profile):
 *   function claude { node "D:\claude context manager\proxy\claude-monitor.js" @args }
 */

import { spawn }           from 'node:child_process';
import { fileURLToPath }   from 'node:url';
import path                from 'node:path';
import fs                  from 'node:fs';

const __dirname  = path.dirname(fileURLToPath(import.meta.url));
const preloadPath = path.join(__dirname, 'preload.js');

// ── Find cli.js directly — bypass all wrapper scripts (.ps1/.cmd/.exe) ──────
// Spawning `node --import preload.js cli.js` is the only reliable way to
// inject NODE_OPTIONS regardless of how claude is packaged on this machine.
const CLI_CANDIDATES = [
  process.env.CLAUDE_CLI_JS,  // explicit override
  'C:\\nvm4w\\nodejs\\node_modules\\@anthropic-ai\\claude-code\\cli.js',
  path.join(process.env.APPDATA || '', 'npm', 'node_modules', '@anthropic-ai', 'claude-code', 'cli.js'),
  path.join(process.env.LOCALAPPDATA || '', 'npm', 'node_modules', '@anthropic-ai', 'claude-code', 'cli.js'),
].filter(Boolean);

function findCliJs() {
  for (const c of CLI_CANDIDATES) {
    try { fs.accessSync(c); return c; } catch (_) {}
  }
  return null;
}

const cliJs   = findCliJs();
const nodeExe = process.execPath;  // same node that's running this script

// ── Proxy URL ────────────────────────────────────────────────────────────────
const proxyUrl = process.env.ANTHROPIC_BASE_URL || 'http://127.0.0.1:3579';

// ── Compose spawn args ───────────────────────────────────────────────────────
// Strategy A (preferred): node --import preload.js cli.js [user args]
//   Guaranteed preload injection — works regardless of claude wrapper type.
// Strategy B (fallback): invoke the ps1/cmd/exe wrapper via shell with NODE_OPTIONS set.
//   Less reliable but works if cli.js can't be found.

let spawnCmd, spawnArgs, spawnShell;

if (cliJs) {
  // Strategy A — direct node invocation
  spawnCmd   = nodeExe;
  spawnArgs  = ['--import', new URL(`file:///${preloadPath.replace(/\\/g, '/')}`).href, cliJs, ...process.argv.slice(2)];
  spawnShell = false;
  process.stderr.write(`\n[XRAY monitor] mode:    direct node → cli.js\n`);
} else {
  // Strategy B — shell wrapper fallback (preload may not load on .exe)
  const existingOpts = process.env.NODE_OPTIONS || '';
  const preloadUrl   = new URL(`file:///${preloadPath.replace(/\\/g, '/')}`).href;
  process.env.NODE_OPTIONS = existingOpts.includes(preloadPath)
    ? existingOpts
    : `--import "${preloadUrl}" ${existingOpts}`.trim();
  spawnCmd   = 'claude';
  spawnArgs  = process.argv.slice(2);
  spawnShell = true;
  process.stderr.write(`\n[XRAY monitor] mode:    shell fallback (cli.js not found — preload may not inject)\n`);
}

process.stderr.write(
  `[XRAY monitor] node:    ${nodeExe}\n` +
  `[XRAY monitor] cli.js:  ${cliJs || '(not found)'}\n` +
  `[XRAY monitor] preload: ${preloadPath}\n` +
  `[XRAY monitor] proxy:   ${proxyUrl}\n` +
  `[XRAY monitor] log dir: ${__dirname}\n\n`
);

// ── Spawn ────────────────────────────────────────────────────────────────────
const child = spawn(spawnCmd, spawnArgs, {
  stdio:   'inherit',
  shell:   spawnShell,
  env: {
    ...process.env,
    XRAY_LOG_DIR:       __dirname,
    ANTHROPIC_BASE_URL: proxyUrl,
  },
});

child.on('error', (err) => {
  process.stderr.write(`[XRAY monitor] failed to launch claude: ${err.message}\n`);
  process.stderr.write(`[XRAY monitor] tried path: ${claudeBin}\n`);
  process.stderr.write(`[XRAY monitor] set CLAUDE_BIN env var to override\n`);
  process.exit(1);
});

child.on('exit', (code, signal) => {
  process.exit(signal ? 1 : (code ?? 0));
});

// Forward signals to child
['SIGINT', 'SIGTERM', 'SIGHUP'].forEach(sig => {
  try {
    process.on(sig, () => child.kill(sig));
  } catch (_) {} // Windows doesn't support all signals
});
