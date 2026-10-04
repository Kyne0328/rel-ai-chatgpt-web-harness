import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vite';

const root = path.dirname(fileURLToPath(import.meta.url));
const outputRoot = path.join(root, 'public');
const dashboardEntry = path.join(root, 'src', 'ui', 'react', 'main.js');
const dashboardCssEntry = path.join(root, 'src', 'ui', 'styles', 'app.css');
const dashboardSource = path.join(root, 'public', 'dashboard.js');
const uiRoot = path.join(root, 'src', 'ui');
const backend = process.env.REL_AI_FRONTEND_BACKEND || 'http://127.0.0.1:3333';

export default defineConfig({
  base: './',
  publicDir: false,
  plugins: [
    dashboardDevAliases(),
    react(),
    tailwindcss(),
    cleanDashboardChunks()
  ],
  server: {
    host: '127.0.0.1',
    proxy: {
      '/__relai_auth': {
        target: backend,
        changeOrigin: true,
        rewrite: () => {
          const token = process.env.REL_AI_MCP_TOKEN || '';
          if (!token) throw new Error('REL_AI_MCP_TOKEN is required for the Vite dashboard dev server.');
          return `/dashboard?token=${encodeURIComponent(token)}`;
        }
      },
      '/api': { target: backend, changeOrigin: true },
      '/events': { target: backend, changeOrigin: true },
      '/vendor/monaco': { target: backend, changeOrigin: true }
    }
  },
  build: {
    outDir: outputRoot,
    emptyOutDir: false,
    target: 'chrome120',
    minify: true,
    sourcemap: false,
    cssCodeSplit: true,
    chunkSizeWarningLimit: 300,
    rollupOptions: {
      input: {
        // NOTE: dashboardReact entry is required for dev alias resolution
        // (public/dashboard.js -> src/ui/react/main.js) and check-generated
        // verification. Production HTML loads only dashboard-app.js; the
        // react entry shares chunks via the manifest, not a second script tag.
        dashboardApp: dashboardSource,
        dashboardReact: dashboardEntry,
        dashboardCss: dashboardCssEntry
      },
      preserveEntrySignatures: 'strict',
      output: {
        entryFileNames: chunk => chunk.name === 'dashboardApp' ? 'dashboard-app.js' : 'dashboard-react.js',
        chunkFileNames: 'dashboard-chunks/[name]-[hash].js',
        assetFileNames: assetInfo => {
          if (assetInfo.name === 'dashboardCss.css') return 'dashboard.css';
          if (assetInfo.name?.endsWith('.css')) return 'dashboard-chunks/[name]-[hash][extname]';
          return 'dashboard-assets/[name]-[hash][extname]';
        }
      }
    }
  }
});

function dashboardDevAliases() {
  const normalizedDashboard = normalize(dashboardSource);
  return {
    name: 'relai-dashboard-dev-aliases',
    enforce: 'pre',
    resolveId(source, importer) {
      if (!importer || normalize(importer.split('?')[0]) !== normalizedDashboard) return null;
      // Vite resolves normal imports with forward slashes. Returning Windows
      // paths here creates a second module instance for shared state such as
      // the router, separating navigation from React's route subscription.
      if (source === './dashboard-react.js') return normalize(dashboardEntry);
      if (source.startsWith('./ui/')) return normalize(path.join(uiRoot, source.slice('./ui/'.length)));
      return null;
    }
  };
}

function cleanDashboardChunks() {
  let resolvedOutDir = outputRoot;
  return {
    name: 'relai-dashboard-chunk-cleanup',
    configResolved(config) {
      resolvedOutDir = path.resolve(config.root, config.build.outDir);
    },
    writeBundle(_options, bundle) {
      const chunkRoot = path.join(resolvedOutDir, 'dashboard-chunks');
      if (!fs.existsSync(chunkRoot)) return;
      const expected = new Set(Object.keys(bundle)
        .filter(name => name.startsWith('dashboard-chunks/'))
        .map(name => path.resolve(resolvedOutDir, name)));
      for (const file of listFiles(chunkRoot)) {
        if (!expected.has(path.resolve(file))) fs.rmSync(file, { force: true });
      }
      removeEmptyDirectories(chunkRoot);
    }
  };
}

function listFiles(directory) {
  if (!fs.existsSync(directory)) return [];
  const files = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...listFiles(target));
    else if (entry.isFile()) files.push(target);
  }
  return files;
}

function removeEmptyDirectories(directory) {
  if (!fs.existsSync(directory)) return;
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory()) removeEmptyDirectories(path.join(directory, entry.name));
  }
  if (fs.existsSync(directory) && fs.readdirSync(directory).length === 0) fs.rmdirSync(directory);
}

function normalize(value) {
  return path.resolve(value).replaceAll('\\', '/');
}
