#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { appendLspLog } = require('./lsp-log.cjs');
const { resolveLspCommand, spawnLspDetached } = require('./resolve-cmd.cjs');

function readInput() {
  try {
    const raw = fs.readFileSync(0, 'utf8').trim();
    return raw ? JSON.parse(raw) : {};
  } catch (_) {
    return {};
  }
}

function findProjectRoot(startPath) {
  let current = path.resolve(startPath || process.cwd());
  try {
    if (!fs.statSync(current).isDirectory()) current = path.dirname(current);
  } catch (_) {}

  while (true) {
    if (path.basename(current) === 'RootDesk') return path.dirname(current);
    try {
      if (fs.statSync(path.join(current, 'RootDesk')).isDirectory()) return current;
    } catch (_) {}

    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

const input = readInput();
const projectRoot = process.env.MLUA_LSP_PROJECT_ROOT || findProjectRoot(input.cwd);

if (!projectRoot) process.exit(0);

const resolved = resolveLspCommand({ projectRoot });
const subArgs = ['start', projectRoot];
const args = resolved.baseArgs.concat(subArgs);

const startedAt = Date.now();
const dispatched = spawnLspDetached(resolved, subArgs);
const durationMs = Date.now() - startedAt;
const result = dispatched.error ? { error: dispatched.error } : { status: 0, stdout: '', stderr: '' };

appendLspLog({
  cwd: input.cwd || process.cwd(),
  event: 'SessionStart',
  action: 'start',
  sessionId: input.session_id,
  cmd: resolved.cmd,
  args,
  projectRoot,
  result,
  durationMs,
  summary: {
    cmd_source: resolved.source,
    use_shell: resolved.useShell,
    background: true,
    pid: dispatched.pid,
  },
});

if (dispatched.error) {
  const message = dispatched.error.message || String(dispatched.error);
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'SessionStart',
      additionalContext: `mLua LSP daemon background start failed: ${String(message).trim()}`,
    },
  }));
}
