import { createRequire } from 'node:module';
import type { Plugin } from 'vitest/config';
import { defineConfig } from 'vitest/config';

/**
 * `node:sqlite` is a very new builtin (Node 22.5+) that Vite's resolver does
 * not yet know about. Left alone, Vite strips the `node:` prefix and tries to
 * resolve an npm package named `sqlite`, failing with
 * "Failed to load url sqlite". This plugin intercepts the import, marks it
 * external, and lets Node's own `require` load the real builtin at runtime.
 */
function nodeSqliteExternal(): Plugin {
  const require = createRequire(import.meta.url);
  return {
    name: 'node-sqlite-external',
    enforce: 'pre',
    resolveId(id) {
      if (id === 'node:sqlite' || id === 'sqlite') {
        return { id: 'node:sqlite', external: true };
      }
      return null;
    },
    load(id) {
      if (id === 'node:sqlite') {
        const mod = require('node:sqlite');
        const exports = Object.keys(mod)
          .map((key) => `export const ${key} = mod[${JSON.stringify(key)}];`)
          .join('\n');
        return `const mod = require('node:sqlite');\n${exports}\nexport default mod;`;
      }
      return null;
    },
  };
}

export default defineConfig({
  plugins: [nodeSqliteExternal()],
  test: {
    include: ['src/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**'],
    testTimeout: 30000,
    // Cap concurrent worker processes. Workflow tests can spawn child
    // processes (brokers/PTYs); an uncapped fork pool can overwhelm the host.
    pool: 'forks',
    poolOptions: { forks: { maxForks: 4, minForks: 1 } },
  },
});
