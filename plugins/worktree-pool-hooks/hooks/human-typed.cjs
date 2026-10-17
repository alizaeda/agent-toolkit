/**
 * Reads a session transcript (jsonl) and returns only the text a human typed.
 * Counted: user-role lines (Claude) and UserMessage items (Codex).
 * Not counted: assistant text, tool_result blocks, meta lines, and text inside
 * <system-reminder>, <pasted_content> and similar wrappers.
 */
const fs = require('fs');

const WRAPPER_TAGS = [
  'system-reminder',
  'pasted_content',
  'ide_selection',
  'ide_opened_file',
  'command-name',
  'command-message',
  'command-args',
  'local-command-stdout',
  'local-command-caveat',
  'user-prompt-submit-hook',
];
const WRAPPER_RE = new RegExp('<(' + WRAPPER_TAGS.join('|') + ')\\b[^>]*>[\\s\\S]*?</\\1>', 'gi');

/** `text` with wrapper blocks removed. */
function stripWrappers(text) {
  return text.replace(WRAPPER_RE, ' ');
}

/** Text parts of a message content (string or block array); tool_result and other blocks are skipped. */
function textParts(content) {
  if (typeof content === 'string') return [content];
  if (!Array.isArray(content)) return [];
  return content
    .filter((b) => b && typeof b === 'object' && b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text);
}

/** Human-typed text of one parsed transcript line, or ''. */
function typedTextOfLine(line) {
  if (!line || typeof line !== 'object' || line.isMeta === true) return '';
  // Claude Code: a user-role message line.
  if (line.type === 'user' && line.message && line.message.role === 'user') {
    if (line.origin && line.origin.kind && line.origin.kind !== 'human') return '';
    return textParts(line.message.content).map(stripWrappers).join('\n');
  }
  // Codex rollout: a completed UserMessage item.
  const item = line.type === 'event_msg' && line.payload && line.payload.item;
  if (item && item.type === 'UserMessage') return textParts(item.content).map(stripWrappers).join('\n');
  return '';
}

/** All human-typed text in the jsonl file at `file`, one string. Throws if unreadable. */
function humanTypedText(file) {
  const out = [];
  for (const raw of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    if (!raw.trim()) continue;
    let line;
    try {
      line = JSON.parse(raw);
    } catch {
      continue;
    }
    const text = typedTextOfLine(line);
    if (text) out.push(text);
  }
  return out.join('\n');
}

module.exports = { humanTypedText, typedTextOfLine, stripWrappers };
