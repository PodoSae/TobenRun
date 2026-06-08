'use strict';

// MSW LSP Log Helper
// Every time `mlua-lsp` runs (SessionStart's `start`, PostToolUse's `diagnose`,
// SessionEnd's `stop`), this helper appends a single line per invocation to
// `.mswai/logs/lsp.log` under the working directory.
// Uses the same `key=value` single-line format as `skill.log`. The command line
// and outputs (stdout/stderr) are escaped via `JSON.stringify`, so embedded
// newlines/tabs never break the one-line layout.

const fs = require('fs');
const { resolveLogFile } = require('../_lib/log-root.cjs');

function formatLocalISO(date) {
  const pad = (n, w = 2) => String(n).padStart(w, '0');
  const y = date.getFullYear();
  const M = pad(date.getMonth() + 1);
  const d = pad(date.getDate());
  const h = pad(date.getHours());
  const m = pad(date.getMinutes());
  const s = pad(date.getSeconds());
  const ms = pad(date.getMilliseconds(), 3);
  const offsetMin = -date.getTimezoneOffset();
  const sign = offsetMin >= 0 ? '+' : '-';
  const absOffset = Math.abs(offsetMin);
  const offH = pad(Math.floor(absOffset / 60));
  const offM = pad(absOffset % 60);
  return `${y}-${M}-${d}T${h}:${m}:${s}.${ms}${sign}${offH}:${offM}`;
}

function measureText(text) {
  if (typeof text !== 'string' || text.length === 0) return { lines: 0, bytes: 0 };
  return {
    lines: text.split('\n').length,
    bytes: Buffer.byteLength(text, 'utf8'),
  };
}

function quoteArg(s) {
  const str = String(s);
  if (str.length === 0) return '""';
  return /[\s"'\\]/.test(str) ? JSON.stringify(str) : str;
}

function buildCommandLine(cmd, args) {
  const parts = [quoteArg(cmd)].concat((args || []).map(quoteArg));
  return parts.join(' ');
}

function truncate(text, maxBytes) {
  if (typeof text !== 'string') return '';
  if (!Number.isFinite(maxBytes) || maxBytes <= 0) return text;
  const buf = Buffer.from(text, 'utf8');
  if (buf.length <= maxBytes) return text;
  return buf.slice(0, maxBytes).toString('utf8') + `…[truncated ${buf.length - maxBytes} bytes]`;
}

function formatLine(parts) {
  return parts
    .filter((p) => p !== null && p !== undefined && p !== '')
    .join(' | ');
}

function formatSummaryEntry(key, value) {
  if (value === null || value === undefined || value === '') return '';
  if (typeof value === 'number' || typeof value === 'boolean') {
    return `${key}=${value}`;
  }
  if (typeof value === 'string') {
    // JSON-escape if the value contains whitespace/separators/control chars; otherwise emit as-is.
    return /[\s|"\\]/.test(value) ? `${key}=${JSON.stringify(value)}` : `${key}=${value}`;
  }
  return `${key}=${JSON.stringify(value)}`;
}

function buildSummaryParts(summary) {
  if (!summary || typeof summary !== 'object') return [];
  return Object.entries(summary)
    .map(([k, v]) => formatSummaryEntry(k, v))
    .filter(Boolean);
}

/**
 * Appends a single LSP invocation entry to `lsp.log`.
 *
 * @param {object}   opts
 * @param {string}   opts.cwd          Working directory to log into (typically `input.cwd` or `process.cwd()`).
 * @param {string}   opts.event        Hook event name (e.g. 'SessionStart' | 'PostToolUse' | 'SessionEnd').
 * @param {string}   opts.action       LSP subcommand (e.g. 'start' | 'diagnose' | 'stop').
 * @param {string}   [opts.sessionId]  Claude session id (only the first 8 chars are recorded).
 * @param {string}   opts.cmd          Command that was executed (e.g. 'npx', 'mlua-lsp').
 * @param {string[]} opts.args         Argument array passed to the command.
 * @param {string}   [opts.projectRoot] Target project root.
 * @param {string}   [opts.targetFile] File targeted by `diagnose` (recorded when present).
 * @param {object}   opts.result       Return value of `spawnSync` (status/stdout/stderr/error/signal).
 * @param {number}   [opts.durationMs] Wall-clock time the command took (ms).
 * @param {object}   [opts.summary]    Flat key=value summary metrics added alongside the full
 *                                     stdout/stderr to make grepping easier
 *                                     (e.g. `{ diagnostic_count: 5, errors: 5, warnings: 0 }`).
 *                                     Entries whose value is `undefined`/`null`/`''` are dropped.
 */
function appendLspLog(opts) {
  if (!opts || !opts.cwd) return;

  const ts = formatLocalISO(new Date());
  const sessionId = String(opts.sessionId || '').slice(0, 8);
  const result = opts.result || {};
  const stdout = typeof result.stdout === 'string' ? result.stdout : '';
  const stderr = typeof result.stderr === 'string' ? result.stderr : '';
  const status = result.status;
  const signal = result.signal;
  const errorMsg = result.error ? String(result.error.message || result.error) : '';

  const stdoutSize = measureText(stdout);
  const stderrSize = measureText(stderr);

  const maxBytesEnv = parseInt(process.env.MLUA_LSP_LOG_MAX_OUTPUT_BYTES || '', 10);
  const maxBytes = Number.isFinite(maxBytesEnv) && maxBytesEnv > 0 ? maxBytesEnv : 0;

  const cmdline = buildCommandLine(opts.cmd, opts.args);
  const summaryParts = buildSummaryParts(opts.summary);

  const line = formatLine([
    ts,
    sessionId ? `session=${sessionId}` : '',
    `event=${opts.event}`,
    `action=${opts.action}`,
    opts.projectRoot ? `project_root=${JSON.stringify(opts.projectRoot)}` : '',
    opts.targetFile ? `file=${JSON.stringify(opts.targetFile)}` : '',
    `cmd=${JSON.stringify(cmdline)}`,
    status !== undefined && status !== null ? `exit=${status}` : '',
    signal ? `signal=${signal}` : '',
    opts.durationMs !== undefined && opts.durationMs !== null ? `duration_ms=${opts.durationMs}` : '',
    ...summaryParts,
    `stdout_lines=${stdoutSize.lines}`,
    `stdout_bytes=${stdoutSize.bytes}`,
    `stderr_lines=${stderrSize.lines}`,
    `stderr_bytes=${stderrSize.bytes}`,
    errorMsg ? `error=${JSON.stringify(errorMsg)}` : '',
    `stdout=${JSON.stringify(truncate(stdout, maxBytes))}`,
    `stderr=${JSON.stringify(truncate(stderr, maxBytes))}`,
  ]);

  try {
    const logFile = resolveLogFile(opts.cwd, 'lsp.log');
    fs.appendFileSync(logFile, line + '\n', 'utf8');
  } catch (_) {
    // Silently ignore logging failures so they never disrupt the model's flow.
  }
}

module.exports = { appendLspLog };
