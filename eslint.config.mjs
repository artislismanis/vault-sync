import js from '@eslint/js';
import tseslint from 'typescript-eslint';

// Node/Electron modules that must never be imported from mobile-safe code
// (plugin/ and shared/). Enforces CLAUDE.md hard rule 2 mechanically.
// Bare builtin names go in `paths` (exact match) — as gitignore-style
// `patterns` they would also match local dirs like ./crypto/.
const MOBILE_BAN_MESSAGE =
  'Node/Electron APIs are forbidden in plugin/ and shared/ (must run on Obsidian mobile). Use Obsidian Vault/Adapter APIs and libsodium/WebCrypto.';

const NODE_BUILTINS_BAN = {
  paths: [
    'fs',
    'path',
    'os',
    'crypto',
    'child_process',
    'util',
    'stream',
    'buffer',
    'events',
    'http',
    'https',
    'net',
    'tls',
    'zlib',
    'worker_threads',
  ].map((name) => ({ name, message: MOBILE_BAN_MESSAGE })),
  patterns: [
    {
      group: ['node:*', 'electron'],
      message: MOBILE_BAN_MESSAGE,
    },
  ],
};

export default tseslint.config(
  {
    ignores: ['**/node_modules/**', '**/dist/**', 'plugin/main.js', '**/data/**'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['plugin/src/**/*.ts', 'shared/src/**/*.ts'],
    rules: {
      'no-restricted-imports': ['error', NODE_BUILTINS_BAN],
    },
  },
);
