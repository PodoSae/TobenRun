'use strict';

// MSW Log Root Resolver
// Single source of truth for "where do logs live", shared by all hook log
// scripts (`skill-log.cjs`, `mcp-log.cjs`, `lsp-log.cjs`).
//
// The `input.cwd` value Claude Code passes to hooks is the working directory
// at the moment the hook runs, and it can vary every time due to things like
// sessions started from a sub-directory. Creating `.mswai/logs/*.log` directly
// off of it scatters logs around like:
//   - `./.mswai/logs/lsp.log`                    (correct)
//   - `./otherdir/.mswai/logs/lsp.log`           (wrong)
//   - `./otherdir/otherdir/.mswai/logs/lsp.log`  (wrong)
// This helper resolves "always the same project root" and returns it.
//
// Resolution priority:
//   1. `CLAUDE_PROJECT_DIR` env var (auto-injected by Claude Code when running hooks)
//   2. Walk up from `input.cwd` and return the first ancestor containing any marker:
//        `.claude/` | `.git/` | `RootDesk/`
//   3. If none is found, fall back to `input.cwd` (matches previous behavior).
//
// Marker discovery can be overridden via the `MSW_LOG_ROOT_MARKERS` env var
// (comma-separated list).

const fs = require('fs');
const path = require('path');

const DEFAULT_MARKERS = ['.claude', '.git', 'RootDesk'];

function isDirectory(p) {
  try {
    return fs.statSync(p).isDirectory();
  } catch (_) {
    return false;
  }
}

function pathExists(p) {
  try {
    fs.accessSync(p);
    return true;
  } catch (_) {
    return false;
  }
}

function getMarkers() {
  const raw = process.env.MSW_LOG_ROOT_MARKERS;
  if (typeof raw !== 'string' || raw.trim() === '') return DEFAULT_MARKERS;
  const list = raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return list.length > 0 ? list : DEFAULT_MARKERS;
}

function findRootByMarkers(startPath, markers) {
  if (!startPath) return null;

  let current = path.resolve(startPath);
  if (!isDirectory(current)) {
    const parent = path.dirname(current);
    if (parent !== current) current = parent;
  }

  // Guard against infinite loops: filesystem depth is typically < 50.
  for (let i = 0; i < 100; i++) {
    for (const marker of markers) {
      if (pathExists(path.join(current, marker))) {
        return current;
      }
    }
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
  return null;
}

/**
 * Resolves the project root directory under which logs should be stored.
 * Log files are created under `<returned root>/.mswai/logs/`.
 *
 * @param {string|undefined} inputCwd  The `input.cwd` value passed to the hook
 *                                     (falls back to `process.cwd()` when missing).
 * @returns {string}                   Always an absolute directory path.
 */
function resolveLogRoot(inputCwd) {
  const claudeProjectDir = process.env.CLAUDE_PROJECT_DIR;
  if (claudeProjectDir && isDirectory(claudeProjectDir)) {
    return path.resolve(claudeProjectDir);
  }

  const cwd = inputCwd || process.cwd();
  const byMarkers = findRootByMarkers(cwd, getMarkers());
  if (byMarkers) return byMarkers;

  return path.resolve(cwd);
}

/**
 * Returns the full log file path (`<root>/.mswai/logs/<filename>`).
 * The `.mswai/logs/` directory is created up front so callers don't have to mkdir.
 *
 * @param {string|undefined} inputCwd  The `input.cwd` value passed to the hook.
 * @param {string} filename            e.g. 'skill.log', 'mcp.log', 'lsp.log'.
 * @returns {string}                   The absolute path to the log file.
 */
function resolveLogFile(inputCwd, filename) {
  const root = resolveLogRoot(inputCwd);
  const dir = path.join(root, '.mswai', 'logs');
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, filename);
}

module.exports = { resolveLogRoot, resolveLogFile };
