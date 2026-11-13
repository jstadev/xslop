import { readFileSync } from 'node:fs';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  define: {
    __XSLOP_VERSION__: JSON.stringify('1.0.0'),
    __MIN_MUTE_SEC__: '90',
    __SHADOW__: JSON.stringify('closed'),
    __MARK_SVG__: JSON.stringify(readFileSync(new URL('../brand/mark-mono.svg', import.meta.url), 'utf8')),
  },
  test: {
    include: ['test/unit/**/*.test.ts'],
    setupFiles: ['test/helpers/setup.ts'],
    environment: 'node',
    testTimeout: 20_000,
  },
});
