import assert from 'node:assert/strict';
import { test } from 'node:test';
import { formatTimestamp } from '../src/logger.js';

test('formatTimestamp renders UTC+8 timestamps with millisecond precision', () => {
  assert.equal(
    formatTimestamp(new Date('2026-05-04T01:02:03.456Z')),
    '2026-05-04T09:02:03.456+08:00',
  );
});

test('formatTimestamp rolls dates across UTC+8 day boundaries', () => {
  assert.equal(
    formatTimestamp(new Date('2026-12-31T20:30:00.000Z')),
    '2027-01-01T04:30:00.000+08:00',
  );
});
