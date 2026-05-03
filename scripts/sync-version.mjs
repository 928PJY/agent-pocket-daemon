#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const { version } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const target = join(root, 'src', 'version.ts');
const next = `export const VERSION = '${version}';\n`;
const current = (() => { try { return readFileSync(target, 'utf8'); } catch { return ''; } })();
if (current !== next) writeFileSync(target, next);
