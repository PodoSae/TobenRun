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

function jsonOut(obj) {
  process.stdout.write(JSON.stringify(obj));
}

function formatDiagnostic(d) {
  const line = d.line || d.range?.start?.line + 1 || '?';
  const col = d.character || d.range?.start?.character + 1 || '?';
  const severity = d.severity || d.level || 'info';
  const message = d.message || String(d);
  return `${line}:${col} ${severity} ${message}`;
}

function pickServerMs(payload) {
  if (!payload || typeof payload !== 'object') return undefined;
  const candidates = [
    payload.serverDurationMs,
    payload.server_ms,
    payload.elapsedMs,
    payload.elapsed_ms,
    payload.durationMs,
    payload.duration_ms,
  ];
  for (const v of candidates) {
    if (typeof v === 'number' && Number.isFinite(v)) return v;
  }
  return undefined;
}

const input = readInput();
const filePath = input.tool_input?.file_path || input.tool_input?.path || input.file_path;

if (!filePath || !filePath.endsWith('.mlua')) process.exit(0);
if (!fs.existsSync(filePath)) process.exit(0);

const projectRoot = process.env.MLUA_LSP_PROJECT_ROOT || findProjectRoot(filePath) || findProjectRoot(input.cwd);
if (!projectRoot) process.exit(0);

const resolved = resolveLspCommand({ projectRoot });
const subArgs = ['diagnose', projectRoot, filePath];
const args = resolved.baseArgs.concat(subArgs);
const timeout = Number.parseInt(process.env.MLUA_LSP_HOOK_DIAGNOSE_TIMEOUT_MS || '120000', 10);

const spawnStart = Date.now();
const result = spawnLspSync(resolved, subArgs, {
  timeout: Number.isFinite(timeout) ? timeout : 120000,
});
const spawnEnd = Date.now();
const durationMs = spawnEnd - spawnStart;

const parseStart = Date.now();
let payload = null;
try {
  payload = JSON.parse(result.stdout);
} catch (_) {
  payload = null;
}
const parseMs = Date.now() - parseStart;

const serverMs = pickServerMs(payload);
const overheadMs = serverMs !== undefined ? Math.max(durationMs - serverMs, 0) : undefined;

const logSummary = (payload && typeof payload === 'object') ? {
  diagnostic_count: payload.diagnosticCount ?? (Array.isArray(payload.diagnostics) ? payload.diagnostics.length : undefined),
  errors: payload.errors,
  warnings: payload.warnings,
  phase: payload.phase,
  workspace_loaded: payload.workspaceLoaded,
  stale_cross_file_results: payload.staleCrossFileResults,
  persistent: payload.persistent,
  cmd_source: resolved.source,
  use_shell: resolved.useShell,
  parse_ms: parseMs,
  server_ms: serverMs,
  overhead_ms: overheadMs,
} : {
  cmd_source: resolved.source,
  use_shell: resolved.useShell,
  parse_ms: parseMs,
};

appendLspLog({
  cwd: input.cwd || process.cwd(),
  event: 'PostToolUse',
  action: 'diagnose',
  sessionId: input.session_id,
  cmd: resolved.cmd,
  args,
  projectRoot,
  targetFile: filePath,
  result,
  durationMs,
  summary: logSummary,
});

if (result.error || result.status !== 0) {
  const message = result.error?.message || result.stderr || `exit ${result.status}`;
  jsonOut({
    hookSpecificOutput: {
      hookEventName: 'PostToolUse',
      additionalContext: `mLua diagnose hook failed for ${path.basename(filePath)}: ${String(message).trim()}`,
    },
  });
  process.exit(0);
}

if (!payload) {
  jsonOut({
    hookSpecificOutput: {
      hookEventName: 'PostToolUse',
      additionalContext: `mLua diagnose returned non-JSON output for ${path.basename(filePath)}.`,
    },
  });
  process.exit(0);
}

const diagnostics = Array.isArray(payload.diagnostics) ? payload.diagnostics : [];
const diagnosticCount = payload.diagnosticCount ?? diagnostics.length;
const errors = payload.errors || 0;
const warnings = payload.warnings || 0;

if (diagnosticCount === 0) {
  if (process.env.MLUA_LSP_HOOK_REPORT_CLEAN === '1') {
    jsonOut({
      hookSpecificOutput: {
        hookEventName: 'PostToolUse',
        additionalContext: `mLua diagnose clean: ${path.basename(filePath)}`,
      },
    });
  }
  process.exit(0);
}

const lines = diagnostics.slice(0, 12).map(formatDiagnostic);
const omitted = diagnostics.length > lines.length ? `\n... ${diagnostics.length - lines.length} more` : '';
const summary = [
  `mLua diagnose found ${diagnosticCount} issue(s) in ${path.basename(filePath)}.`,
  `errors=${errors}, warnings=${warnings}`,
  ...lines,
].join('\n') + omitted;

const strict = process.env.MLUA_LSP_HOOK_STRICT === '1';
if (errors > 0 || strict) {
  jsonOut({
    decision: 'block',
    reason: summary,
    hookSpecificOutput: {
      hookEventName: 'PostToolUse',
      additionalContext: summary,
    },
  });
} else {
  jsonOut({
    hookSpecificOutput: {
      hookEventName: 'PostToolUse',
      additionalContext: summary,
    },
  });
}
