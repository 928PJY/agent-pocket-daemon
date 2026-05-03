#!/usr/bin/env node
// Convert node --experimental-test-coverage spec-reporter output (read from
// stdin) into a compact markdown table for $GITHUB_STEP_SUMMARY / PR comment.
// Usage: node scripts/coverage-to-markdown.mjs < coverage.txt > coverage.md

import { readFileSync } from 'node:fs';

const raw = readFileSync(0, 'utf-8');
const lines = raw.split('\n');

// Lines look like: "ℹ  auth.ts                 |  98.74 |    91.30 |  100.00 | 74 87"
// We want file + 3 percentages; skip separators, headers, and the "all files" row
// (we report "all files" as a single Totals line under the table).
const rowRe = /^ℹ\s+([^|]+?)\s+\|\s+([\d.]+)\s+\|\s+([\d.]+)\s+\|\s+([\d.]+)\s+\|/;
const rows = [];
let totals = null;

for (const line of lines) {
  const m = line.match(rowRe);
  if (!m) continue;
  const file = m[1].trim();
  if (file.endsWith('%') || file === 'file') continue;
  const entry = { file, line: m[2], branch: m[3], func: m[4] };
  if (file === 'all files') totals = entry;
  else rows.push(entry);
}

if (!totals) {
  console.error('coverage-to-markdown: could not find "all files" row');
  process.exit(1);
}

const head = '| File | Line % | Branch % | Func % |';
const sep = '|---|---:|---:|---:|';
const body = rows.map((r) => `| \`${r.file}\` | ${r.line} | ${r.branch} | ${r.func} |`).join('\n');
const total = `| **Total** | **${totals.line}** | **${totals.branch}** | **${totals.func}** |`;

const out = [
  '## Test coverage',
  '',
  head,
  sep,
  body,
  total,
  '',
].join('\n');

process.stdout.write(out);
