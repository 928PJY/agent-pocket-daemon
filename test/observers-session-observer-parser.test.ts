import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseLocalCommandUserText } from '../src/observers/session-observer.js';

test('parseLocalCommandUserText: command-name → invoke event with stripped slash', () => {
  const out = parseLocalCommandUserText('<command-name>/cost</command-name>');
  assert.deepEqual(out, { type: 'local_command_invoke', name: 'cost', args: '' });
});

test('parseLocalCommandUserText: command-name + command-args extracts args', () => {
  const out = parseLocalCommandUserText(
    '<command-name>/model</command-name><command-args>opus</command-args>',
  );
  assert.deepEqual(out, { type: 'local_command_invoke', name: 'model', args: 'opus' });
});

test('parseLocalCommandUserText: command-name without leading slash also stripped to bare name', () => {
  const out = parseLocalCommandUserText('<command-name>cost</command-name>');
  assert.deepEqual(out, { type: 'local_command_invoke', name: 'cost', args: '' });
});

test('parseLocalCommandUserText: local-command-stdout → output event (stdout, no is_stderr)', () => {
  const out = parseLocalCommandUserText('<local-command-stdout>cost: $0.42</local-command-stdout>');
  assert.deepEqual(out, { type: 'local_command_output', stdout: 'cost: $0.42' });
});

test('parseLocalCommandUserText: local-command-stderr → output event with is_stderr=true', () => {
  const out = parseLocalCommandUserText('<local-command-stderr>boom</local-command-stderr>');
  assert.deepEqual(out, { type: 'local_command_output', stdout: 'boom', is_stderr: true });
});

test('parseLocalCommandUserText: stdout content preserves multi-line whitespace verbatim', () => {
  const body = 'line1\n  line2\n\nline4';
  const out = parseLocalCommandUserText(`<local-command-stdout>${body}</local-command-stdout>`);
  assert.deepEqual(out, { type: 'local_command_output', stdout: body });
});

test('parseLocalCommandUserText: caveat → drop sentinel', () => {
  const out = parseLocalCommandUserText('<local-command-caveat>internal note</local-command-caveat>');
  assert.equal(out, 'drop');
});

test('parseLocalCommandUserText: caveat self-closing variant also drops', () => {
  const out = parseLocalCommandUserText('<local-command-caveat />');
  assert.equal(out, 'drop');
});

test('parseLocalCommandUserText: leading whitespace tolerated before opening tag', () => {
  const out = parseLocalCommandUserText('   \n<command-name>/cost</command-name>');
  assert.deepEqual(out, { type: 'local_command_invoke', name: 'cost', args: '' });
});

test('parseLocalCommandUserText: plain user text returns null', () => {
  assert.equal(parseLocalCommandUserText('hello world'), null);
});

test('parseLocalCommandUserText: unrelated XML-ish text returns null', () => {
  assert.equal(parseLocalCommandUserText('<system-reminder>foo</system-reminder>'), null);
  assert.equal(parseLocalCommandUserText('<task-notification>bar</task-notification>'), null);
});

test('parseLocalCommandUserText: empty string returns null', () => {
  assert.equal(parseLocalCommandUserText(''), null);
});
