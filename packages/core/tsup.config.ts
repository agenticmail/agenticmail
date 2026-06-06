import { defineConfig } from 'tsup';

/**
 * tsup/esbuild configuration for @agenticmail/core.
 *
 * Two non-default settings matter here:
 *
 *   1. `target: 'node22'`. We import `node:sqlite` (Node 22+ stdlib),
 *      and esbuild's older default target strips the `node:` prefix on
 *      built-in imports, producing `import { ... } from "sqlite"` —
 *      which then fails at runtime because there is no package named
 *      "sqlite" on disk. Setting target to node22 keeps the prefix
 *      intact AND enables modern syntax (top-level await, etc.) we'd
 *      otherwise have to polyfill.
 *
 *   2. `external: ['node:*']`. Belt-and-suspenders — explicitly mark
 *      every `node:`-prefixed import as an external dependency so
 *      esbuild never tries to bundle or rename it. Pairs with the
 *      target setting to fully insulate built-in module imports.
 *
 * Everything else (entry, format, dts, clean) mirrors what the previous
 * inline `tsup` CLI invocation in package.json was doing.
 */
export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm', 'cjs'],
  dts: true,
  clean: true,
  target: 'node22',
  // `node-edge-tts` is an OPTIONAL peer dependency, loaded only on
  // demand by the media toolset (tts_generate). Marking it external
  // keeps esbuild from trying to bundle it when it isn't installed —
  // the media module feature-detects it at runtime and degrades
  // gracefully with an install hint when it is absent.
  // `ws` is a CommonJS package that internally uses `require('events')`
  // / `require('stream')`. tsup's ESM bundler wraps require() in a
  // helper that throws on Node built-ins, so the moment we inline `ws`
  // every import of @agenticmail/core dies at startup with
  // "Dynamic require of \"events\" is not supported" (regression
  // shipped in 0.9.41 / cli 0.9.99 — the moment voice-providers/preview.ts
  // started using ws in core). Keep `ws` external so it loads natively
  // at runtime — declared in package.json `dependencies` so npm install
  // resolves it cleanly.
  external: ['node:*', 'node-edge-tts', 'ws'],
  // Built-in skills are JSON files loaded at runtime by
  // `packages/core/src/skills/registry.ts` (which resolves them
  // relative to its own dist location). esbuild won't move data
  // files on its own — `onSuccess` mirrors the source tree's
  // `built-in/` directory into `dist/skills/built-in/` after every
  // build so the registry finds them in both source-runs and
  // installed npm packages.
  onSuccess: 'node scripts/copy-skills.mjs',
});
