#!/usr/bin/env node
'use strict';

// MSW MCP Log Hook
// Every time Claude Code invokes any MCP tool (`PostToolUse` with a tool_name shaped
// like `mcp__<server>__<tool>`), this hook appends a single human-readable line to
// `.mswai/logs/mcp.log` under the working directory — one line per invocation.
//
// Uses the same `key=value` single-line format as `lsp.log` / `skill.log`. The
// `arguments` payload (`input`) and the response body (`response`) are escaped via
// `JSON.stringify`, so embedded newlines never break the one-line layout.
//
// Auto-registered via the plugin's `hooks/hooks.json` — no manual setup required.
// `PostToolUse` events for non-MCP tools exit immediately, so the overhead is negligible.

const fs = require('fs');
const { resolveLogFile } = require('../_lib/log-root.cjs');

function readInput() {
  try {
    const raw = fs.readFileSync(0, 'utf8').trim();
    return raw ? JSON.parse(raw) : {};
  } catch (_) {
    return {};
  }
}

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

function extractResponseText(toolResponse) {
  if (typeof toolResponse === 'string') return toolResponse;
  if (toolResponse && typeof toolResponse === 'object') {
    if (typeof toolResponse.content === 'string') return toolResponse.content;
    if (typeof toolResponse.text === 'string') return toolResponse.text;
    if (Array.isArray(toolResponse.content)) {
      return toolResponse.content
        .map((c) => {
          if (!c || typeof c !== 'object') return '';
          if (typeof c.text === 'string') return c.text;
          if (typeof c.content === 'string') return c.content;
          return '';
        })
        .join('');
    }
  }
  return '';
}

function isErrorResponse(toolResponse) {
  if (!toolResponse || typeof toolResponse !== 'object') return false;
  return toolResponse.isError === true || toolResponse.is_error === true;
}

function parseMcpToolName(toolName) {
  // Claude Code's standard MCP tool name format is `mcp__<server>__<tool>`.
  // The server name itself may contain underscores, so split on the LAST `__`.
  if (typeof toolName !== 'string' || !toolName.startsWith('mcp__')) return null;
  const rest = toolName.slice('mcp__'.length);
  const idx = rest.lastIndexOf('__');
  if (idx <= 0) return null;
  const server = rest.slice(0, idx);
  const tool = rest.slice(idx + 2);
  if (!server || !tool) return null;
  return { server, tool };
}

function safeJsonStringify(value) {
  try {
    return JSON.stringify(value);
  } catch (_) {
    try {
      return JSON.stringify(String(value));
    } catch (__) {
      return '"<unserializable>"';
    }
  }
}

function truncateText(text, maxBytes) {
  if (typeof text !== 'string') return '';
  if (!Number.isFinite(maxBytes) || maxBytes <= 0) return text;
  const buf = Buffer.from(text, 'utf8');
  if (buf.length <= maxBytes) return text;
  return buf.slice(0, maxBytes).toString('utf8') + `…[truncated ${buf.length - maxBytes} bytes]`;
}

function truncateJsonString(jsonStr, maxBytes) {
  if (typeof jsonStr !== 'string') return jsonStr;
  if (!Number.isFinite(maxBytes) || maxBytes <= 0) return jsonStr;
  if (Buffer.byteLength(jsonStr, 'utf8') <= maxBytes) return jsonStr;
  // Slicing the raw JSON would produce invalid syntax, so wrap the truncated
  // bytes in a placeholder string instead.
  const truncated = Buffer.from(jsonStr, 'utf8').slice(0, maxBytes).toString('utf8');
  return JSON.stringify(`<truncated-json>${truncated}…[truncated ${Buffer.byteLength(jsonStr, 'utf8') - maxBytes} bytes]`);
}

function formatLine(parts) {
  return parts
    .filter((p) => p !== null && p !== undefined && p !== '')
    .join(' | ');
}

function buildLine(input) {
  if (input.hook_event_name !== 'PostToolUse') return null;

  const toolName = input.tool_name;
  const parsed = parseMcpToolName(toolName);
  if (!parsed) return null;

  const sessionId = String(input.session_id || '').slice(0, 8);
  const ts = formatLocalISO(new Date());
  const durationMs = input.duration_ms;

  const toolInput = input.tool_input;
  const toolResponse = input.tool_response;

  const inputJson = safeJsonStringify(toolInput === undefined ? {} : toolInput);
  const inputBytes = Buffer.byteLength(inputJson, 'utf8');

  const responseText = extractResponseText(toolResponse);
  const responseSize = measureText(responseText);
  const isError = isErrorResponse(toolResponse);

  const maxBytesEnv = parseInt(process.env.MCP_LOG_MAX_OUTPUT_BYTES || '', 10);
  const maxBytes = Number.isFinite(maxBytesEnv) && maxBytesEnv > 0 ? maxBytesEnv : 0;

  const truncatedInput = truncateJsonString(inputJson, maxBytes);
  const truncatedResponse = truncateText(responseText, maxBytes);

  return formatLine([
    ts,
    sessionId ? `session=${sessionId}` : '',
    `event=PostToolUse`,
    `tool=${toolName}`,
    `server=${parsed.server}`,
    `mcp_tool=${parsed.tool}`,
    durationMs !== undefined && durationMs !== null ? `duration_ms=${durationMs}` : '',
    isError ? 'is_error=true' : '',
    `input_bytes=${inputBytes}`,
    `response_lines=${responseSize.lines}`,
    `response_bytes=${responseSize.bytes}`,
    `input=${truncatedInput}`,
    `response=${JSON.stringify(truncatedResponse)}`,
  ]);
}

function main() {
  const input = readInput();
  const cwd = input.cwd || process.cwd();

  let line;
  try {
    line = buildLine(input);
  } catch (_) {
    return;
  }
  if (!line) return;

  try {
    const logFile = resolveLogFile(cwd, 'mcp.log');
    fs.appendFileSync(logFile, line + '\n', 'utf8');
  } catch (_) {
    // Silently ignore logging failures so they never disrupt the model's flow.
  }
}

main();
process.exit(0);
