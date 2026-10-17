import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, describe, test } from 'node:test';

const require = createRequire(import.meta.url);
const { humanTypedText, stripWrappers } = require('../human-typed.cjs');

const dir = mkdtempSync(path.join(tmpdir(), 'human-typed-'));
after(() => rmSync(dir, { recursive: true, force: true }));

let n = 0;
const transcript = (...lines) => {
  n += 1;
  const file = path.join(dir, `t-${n}.jsonl`);
  writeFileSync(file, `${lines.map((l) => (typeof l === 'string' ? l : JSON.stringify(l))).join('\n')}\n`);
  return file;
};
const user = (content, extra = {}) => ({ type: 'user', message: { role: 'user', content }, ...extra });

describe('humanTypedText', () => {
  test('counts string and text-block user content', () => {
    const file = transcript(user('plain words'), user([{ type: 'text', text: 'block words' }]));
    assert.equal(humanTypedText(file), 'plain words\nblock words');
  });

  test('skips assistant lines, tool_result blocks and meta lines', () => {
    const file = transcript(
      { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'assistant' }] } },
      user([{ type: 'tool_result', tool_use_id: 't', content: 'tool' }]),
      user('meta', { isMeta: true }),
      user('agent-made', { origin: { kind: 'task-notification' } }),
      user('typed', { origin: { kind: 'human' } }),
    );
    assert.equal(humanTypedText(file), 'typed');
  });

  test('drops wrapper blocks but keeps the text around them', () => {
    const file = transcript(user('a <system-reminder>secret</system-reminder> b <pasted_content id="1">paste</pasted_content> c'));
    const text = humanTypedText(file);
    assert.doesNotMatch(text, /secret|paste/);
    assert.match(text, /a\s+b\s+c/);
  });

  test('reads Codex UserMessage items', () => {
    const file = transcript({
      type: 'event_msg',
      payload: { type: 'item_completed', item: { type: 'UserMessage', content: [{ type: 'text', text: 'codex words' }] } },
    });
    assert.equal(humanTypedText(file), 'codex words');
  });

  test('skips broken lines and blank lines', () => {
    const file = transcript('{not json', '', user('ok'));
    assert.equal(humanTypedText(file), 'ok');
  });

  test('throws when the file is missing', () => {
    assert.throws(() => humanTypedText(path.join(dir, 'nope.jsonl')));
  });

  test('stripWrappers is case-insensitive and handles multi-line blocks', () => {
    assert.doesNotMatch(stripWrappers('x <System-Reminder>\nhidden\n</System-Reminder> y'), /hidden/);
  });
});
