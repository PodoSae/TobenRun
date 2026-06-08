#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { appendLspLog } = require('./lsp-log.cjs');
const { resolveLspCommand, spawnLspSync } = require('./resolve-cmd.cjs');

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
const subArgs = ['stop', projectRoot];
const args = resolved.baseArgs.concat(subArgs);

const startedAt = Date.now();
const result = spawnLspSync(resolved, subArgs, {
  timeout: 15000,
});
const durationMs = Date.now() - startedAt;

appendLspLog({
  cwd: input.cwd || process.cwd(),
  event: 'SessionEnd',
  action: 'stop',
  sessionId: input.session_id,
  cmd: resolved.cmd,
  args,
  projectRoot,
  result,
  durationMs,
  summary: {
    cmd_source: resolved.source,
    use_shell: resolved.useShell,
  },
});
