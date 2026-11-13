import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { defineConfig, type Plugin } from 'vite';

const root = import.meta.dirname;
const brand = resolve(root, '../brand');

/** Emits the brand files that the server serves from the site root (SPEC 5.7). */
function brandRootFiles(): Plugin {
  return {
    name: 'xslop-brand-root-files',
    apply: 'build',
    generateBundle() {
      for (const fileName of ['favicon.svg', 'og.png']) {
        this.emitFile({ type: 'asset', fileName, source: readFileSync(resolve(brand, fileName)) });
      }
    },
  };
}

/** Replaces <!--include:name--> with partials/name.html, so the footer, the head and the mark exist once. */
function partials(): Plugin {
  return {
    name: 'xslop-partials',
    transformIndexHtml: {
      order: 'pre',
      handler: (html) => html.replace(/<!--include:([a-z-]+)-->/g, (_, name: string) => readFileSync(resolve(root, 'partials', `${name}.html`), 'utf8').trimEnd()),
    },
  };
}

export default defineConfig({
  root,
  base: '/',
  appType: 'mpa',
  publicDir: 'public',
  plugins: [brandRootFiles(), partials()],
  server: { fs: { allow: [root, brand] } },
  worker: { format: 'es' },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    target: 'es2022',
    // Inline data URLs would break font-src 'self'; keep every asset as a file.
    assetsInlineLimit: 0,
    modulePreload: { polyfill: false },
    rolldownOptions: {
      input: {
        main: resolve(root, 'index.html'),
        admin: resolve(root, 'admin/index.html'),
        sloppers: resolve(root, 'sloppers/index.html'),
        howItWorks: resolve(root, 'how-it-works/index.html'),
        rules: resolve(root, 'rules/index.html'),
        download: resolve(root, 'download/index.html'),
        check: resolve(root, 'check/index.html'),
        privacy: resolve(root, 'privacy/index.html'),
        questions: resolve(root, 'questions/index.html'),
        notFound: resolve(root, '404.html'),
      },
    },
  },
});
