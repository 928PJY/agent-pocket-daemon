import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  CANCEL_MESSAGE,
  INTERRUPT_MESSAGE,
  INTERRUPT_MESSAGE_FOR_TOOL_USE,
  TOOL_USE_INTERRUPTED_PLACEHOLDER,
  detectInterruptText,
  interruptMessageText,
} from '../src/utils/interrupt-messages.js';

test('detectInterruptText classifies known streaming and tool-use interrupts', () => {
  assert.equal(detectInterruptText(INTERRUPT_MESSAGE), 'streaming');
  assert.equal(detectInterruptText(INTERRUPT_MESSAGE_FOR_TOOL_USE), 'tool_use');
  assert.equal(detectInterruptText(TOOL_USE_INTERRUPTED_PLACEHOLDER), 'tool_use');
  assert.equal(detectInterruptText(CANCEL_MESSAGE), 'tool_use');
});

test('detectInterruptText trims transport whitespace', () => {
  assert.equal(detectInterruptText(`\n  ${INTERRUPT_MESSAGE}  \t`), 'streaming');
  assert.equal(detectInterruptText(` ${TOOL_USE_INTERRUPTED_PLACEHOLDER}\n`), 'tool_use');
});

test('detectInterruptText ignores normal assistant text', () => {
  assert.equal(detectInterruptText('I can help with that.'), null);
  assert.equal(detectInterruptText('[Request interrupted by system]'), null);
});

test('interruptMessageText returns user-facing status text', () => {
  assert.equal(interruptMessageText('streaming'), 'Interrupted by user.');
  assert.equal(interruptMessageText('tool_use'), 'Interrupted by user (tool use).');
});
