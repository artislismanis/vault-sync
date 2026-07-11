import esbuild from 'esbuild';
import process from 'node:process';
import builtins from 'builtin-modules';

// Obsidian plugins ship as a single main.js — everything is bundled in,
// including shared/ (TS source) and libsodium (wasm embedded as base64 in its
// JS, so no loader tricks needed). Node builtins are marked external only so
// esbuild doesn't error: importing them at runtime would crash on mobile,
// which is why eslint bans them in plugin/ and shared/ source.
const prod = process.argv.includes('production');

// Point OUTFILE at a test vault's .obsidian/plugins/vault-sync/main.js for a
// live dev loop (pairs well with the Hot-Reload community plugin).
const outfile = process.env.OUTFILE ?? 'main.js';

const context = await esbuild.context({
  entryPoints: ['src/main.ts'],
  outfile,
  bundle: true,
  format: 'cjs',
  platform: 'browser',
  target: 'es2020',
  external: ['obsidian', 'electron', '@codemirror/*', '@lezer/*', ...builtins],
  sourcemap: prod ? false : 'inline',
  treeShaking: true,
  logLevel: 'info',
});

if (prod) {
  await context.rebuild();
  process.exit(0);
} else {
  await context.watch();
}
