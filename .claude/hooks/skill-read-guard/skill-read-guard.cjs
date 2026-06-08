#!/usr/bin/env node
'use strict';

// MSW Skill Read Guard Hook (PreToolUse, matcher: "Bash")
// Blocks attempts to partially read `plugins/msw-maker-base-skill/skills/**/*.md`
// via Bash by exiting 2 and emitting a "use the Read tool" directive on stderr.
//
// Blocking conditions (all must hold):
//   1. The command contains one of the following tokens (with word boundaries):
//      cat | head | tail | less | more | type | Get-Content | gc
//      | grep | rg | findstr | Select-String | sls | awk | sed
//   2. The command contains a path matching:
//      plugins[/\\]msw-maker-base-skill[/\\]skills[/\\]<...>.md
//
// Whitelist (NOT blocked):
//   - Meta-inspection tools such as wc, stat, ls, dir, file, find, Get-ChildItem
//     do not match the token list → they pass through automatically.
//
// To bypass an unintended block, set the env var
//   MSW_SKILL_READ_GUARD_DISABLE=1
// and the hook will exit immediately (intended for debugging / migration).
//
// Auto-registered via the plugin's `hooks/hooks.json` — no manual setup required.

const fs = require('fs');

if (process.env.MSW_SKILL_READ_GUARD_DISABLE === '1') {
  process.exit(0);
}

function readInput() {
  try {
    const raw = fs.readFileSync(0, 'utf8').trim();
    return raw ? JSON.parse(raw) : {};
  } catch (_) {
    return {};
  }
}

const input = readInput();
const command =
  (input && input.tool_input && input.tool_input.command) || '';

if (!command) {
  process.exit(0);
}

// Word-boundary based token matching. Includes PowerShell aliases such as
// `gc` (Get-Content), `sls` (Select-String), and `type` (Get-Content alias).
// Case-insensitive.
const BLOCKED_TOKEN_RE =
  /(^|[\s|;&(`])(cat|head|tail|less|more|type|Get-Content|gc|grep|rg|findstr|Select-String|sls|awk|sed)([\s|;&)`]|$)/i;

// Path to a skill `.md` file (matches both POSIX `/` and Windows `\\`
// separators). Quotes, backticks, and whitespace are treated as path terminators.
const SKILL_PATH_RE =
  /plugins[\/\\]+msw-maker-base-skill[\/\\]+skills[\/\\]+[^\s'"`|;&()<>]*\.md\b/i;

if (!BLOCKED_TOKEN_RE.test(command)) {
  process.exit(0);
}

const pathMatch = command.match(SKILL_PATH_RE);
if (!pathMatch) {
  process.exit(0);
}

const matchedPath = pathMatch[0].replace(/\\/g, '/');

process.stderr.write(
  `[msw-skill-read-guard] Refusing to read a skill file via Bash.\n` +
  `File:    ${matchedPath}\n` +
  `Command: ${command}\n` +
  `Reason:  Skill .md files under plugins/msw-maker-base-skill/skills/** must be read\n` +
  `         IN FULL via the Read tool (no offset/limit). cat/head/tail/Get-Content/grep\n` +
  `         show only a partial slice and silently skip the section that actually\n` +
  `         answers the request — this is the failure mode that broke past UI tasks\n` +
  `         (only a prefix of the old UI reference was read).\n` +
  `Action:  Reissue this as a single Read tool call, e.g.\n` +
  `           Read({ path: "${matchedPath}" })\n` +
  `         Do NOT pass 'offset' or 'limit'. Read the file whole.\n` +
  `Note:    For metadata only (line counts, file size), wc/stat/ls/Get-ChildItem are\n` +
  `         allowed and not blocked by this guard.\n`
);

// exit code 2 = block tool call and surface stderr to the assistant.
process.exit(2);
