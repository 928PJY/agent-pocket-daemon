import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const packageJson = require('../package.json') as { version?: unknown };

if (typeof packageJson.version !== 'string') {
  throw new Error('package.json version must be a string');
}

export const VERSION = packageJson.version;
