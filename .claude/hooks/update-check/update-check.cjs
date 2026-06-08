'use strict';
// SessionStart — check whether a newer @maplestoryworlds/ai-cli is on
// npm and emit a `systemMessage` JSON so Claude Code surfaces the
// notice in the user's chat window. Always exits 0 — never blocks
// session start, even on network failure.
//
// Cursor / Codex / GitHub Copilot ignore the systemMessage JSON
// (their hooks have no equivalent decision contract for SessionStart),
// but running the check there is harmless. The notice is best-effort.

const { spawnSync } = require('child_process');

function firstLine(s) {
  return String(s || '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => l.length > 0) || '';
}

function exec(cmd, args) {
  const r = spawnSync(cmd, args, {
    encoding: 'utf8',
    timeout: 5000,
    windowsHide: true,
    shell: process.platform === 'win32',
  });
  if (r.error || r.status !== 0) return '';
  return firstLine(r.stdout);
}

function run() {
  const current = exec('mswai', ['--version']);
  if (!current) process.exit(0);

  const latest = exec('npm', ['view', '@maplestoryworlds/ai-cli', 'version']);
  if (!latest) process.exit(0);

  if (current !== latest) {
    const message =
      `[mswai] Update available: ${current} → ${latest}\n` +
      `[mswai] To upgrade: npm i -g @maplestoryworlds/ai-cli@latest && mswai update`;
    process.stdout.write(JSON.stringify({ systemMessage: message }) + '\n');
  }
  process.exit(0);
}

module.exports = { run };

if (require.main === module) run();
