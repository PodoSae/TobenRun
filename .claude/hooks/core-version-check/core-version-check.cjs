'use strict';
// UserPromptSubmit — refuse to let the agent proceed with MSW dev work
// when the workspace's CoreVersion does not match the version mswai (and
// thus the bundled skills/templates) was authored against. Emits a
// `<core-version-mismatch>` block on stdout so AI coding agents see it
// as additional context for the current prompt.
//
// Mirrors plugins/msw-maker-base-skill/scripts/core-version-check.sh
// (Bash) but is .cjs so Windows runs it the same way as macOS / Linux.
//
// Source of CoreVersion: `Environment/config` JSON — the same marker
// mswai's enforceWorkspace() gate uses. Keeps the truth in one place.
//
// EXPECTED_CORE_VERSION must track brand.yaml's workspace.expectedCoreVersion.
// `mswai update` rewrites the hook scripts from the package template, so
// users pick up bumps automatically.

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const EXPECTED_CORE_VERSION = '26.5.0.0';
const CONFIG_FILE = 'Environment/config';

function lockPath() {
  // Per-workspace lock so we don't re-inject the warning on every prompt.
  // Path-derived hash keeps Windows + Unix paths to the same length.
  const id = crypto.createHash('sha1').update(process.cwd()).digest('hex').slice(0, 16);
  return path.join(os.tmpdir(), `mswai-corecheck-${id}`);
}

function run() {
  const lock = lockPath();
  if (fs.existsSync(lock)) process.exit(0);

  // Not an MSW workspace — silently pass.
  if (!fs.existsSync(CONFIG_FILE)) process.exit(0);

  let coreVersion = '';
  try {
    const obj = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    if (obj && typeof obj.CoreVersion === 'string') {
      coreVersion = obj.CoreVersion.trim();
    }
  } catch (_) {
    process.exit(0);
  }
  if (!coreVersion) process.exit(0);

  // Mark notified — once per session is enough for a guidance message.
  try { fs.writeFileSync(lock, ''); } catch (_) { /* tmpdir not writable; warn anyway */ }

  if (coreVersion === EXPECTED_CORE_VERSION) {
    process.exit(0);
  }

  const lines = [
    '<core-version-mismatch>',
    `MSW Core Version 불일치. 워크스페이스: ${coreVersion} / mswai 기대: ${EXPECTED_CORE_VERSION}`,
    '사용자에게 아래 내용을 안내하고, MSW 개발 작업(코드 작성, 파일 수정 등)을 절대 진행하지 마라.',
    '- 워크스페이스가 더 높으면 → @maplestoryworlds/ai-cli 와 플러그인을 최신 버전으로 업데이트',
    '- 워크스페이스가 더 낮으면 → MSW 클라이언트를 최신 버전으로 업데이트',
    '</core-version-mismatch>',
    '',
  ].join('\n');
  process.stdout.write(lines);
  process.exit(0);
}

module.exports = { run, EXPECTED_CORE_VERSION };

if (require.main === module) run();
