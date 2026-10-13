import { readFileSync, mkdirSync, copyFileSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { defineConfig, type Plugin } from 'vite'
import { VitePWA } from 'vite-plugin-pwa'

const MANIFEST_ID = '/wakariyasuku/'

function assertManifestId(): Plugin {
  return {
    name: 'assert-manifest-id',
    apply: 'build',
    enforce: 'post',
    closeBundle() {
      const manifest = JSON.parse(readFileSync(resolve('dist/manifest.webmanifest'), 'utf8')) as { id?: string }
      if (manifest.id !== MANIFEST_ID) throw new Error(`manifest id must be ${MANIFEST_ID} (never './'), got ${String(manifest.id)}`)
    },
  }
}

// Same-origin Tesseract worker + LSTM cores (copied at build time, not committed) so the SW can cache them.
function copyTesseract(): Plugin {
  return {
    name: 'copy-tesseract',
    buildStart() {
      const out = resolve('public/tesseract')
      mkdirSync(out, { recursive: true })
      copyFileSync(resolve('node_modules/tesseract.js/dist/worker.min.js'), resolve(out, 'worker.min.js'))
      let core = ''
      for (const d of ['node_modules/tesseract.js/node_modules/tesseract.js-core', 'node_modules/tesseract.js-core']) {
        try { readdirSync(resolve(d)); core = resolve(d); break } catch { /* next */ }
      }
      if (!core) throw new Error('tesseract.js-core not found')
      for (const f of readdirSync(core)) if (/-lstm\.wasm\.js$/.test(f)) copyFileSync(resolve(core, f), resolve(out, f))
    },
  }
}

export default defineConfig({
  base: './',
  worker: { format: 'es' },
  optimizeDeps: { exclude: ['@huggingface/transformers'] },
  build: { chunkSizeWarningLimit: 2000 },
  plugins: [
    copyTesseract(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['icons/icon-32.png', 'icons/icon-180.png'],
      manifest: {
        id: MANIFEST_ID,
        name: 'わかりやすく',
        short_name: 'わかりやすく',
        description: '難しい文章を、やさしく言いかえる。Rewrite hard text in plain words, on your device.',
        lang: 'ja',
        dir: 'ltr',
        start_url: './',
        scope: './',
        display: 'standalone',
        orientation: 'portrait',
        background_color: '#17323a',
        theme_color: '#17323a',
        share_target: { action: './', method: 'GET', params: { title: 'title', text: 'text', url: 'url' } },
        icons: [
          { src: 'icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
          { src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
          { src: 'icons/icon-maskable-192.png', sizes: '192x192', type: 'image/png', purpose: 'maskable' },
          { src: 'icons/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,svg,png,webmanifest,mjs}'],
        globIgnores: ['tesseract/**'],
        maximumFileSizeToCacheInBytes: 30 * 1024 * 1024,
        navigateFallback: 'index.html',
        // Share target opens ./?text=... — let the app shell handle it.
        cleanupOutdatedCaches: true,
        runtimeCaching: [
          {
            // OCR worker/cores (same origin), OCR language data + onnxruntime wasm (jsDelivr).
            // The AI model itself is cached by transformers.js in its own Cache Storage
            // ("transformers-cache"), shared with まとめ屋 on the same github.io origin.
            urlPattern: ({ url }) => url.hostname === 'cdn.jsdelivr.net' || url.pathname.includes('/tesseract/'),
            handler: 'CacheFirst',
            options: { cacheName: 'wakariyasuku-data', expiration: { maxEntries: 40 }, cacheableResponse: { statuses: [0, 200] } },
          },
        ],
      },
    }),
    assertManifestId(),
  ],
})
