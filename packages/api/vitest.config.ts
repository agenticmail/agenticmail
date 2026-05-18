import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  resolve: {
    alias: {
      '@agenticmail/core': fileURLToPath(new URL('../core/src/index.ts', import.meta.url)),
    },
  },
});
