import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import brand from '../brand.json'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(__dirname, '..')

export default defineConfig({
  // Relative asset URLs so one build works at `/` (local, Electron, docker
  // web image) and under a reverse-proxy prefix such as `/code/`
  // (KnowBot nginx → this agent on another port). Override with VITE_BASE
  // if you need an absolute public path, e.g. VITE_BASE=/code/
  base: process.env.VITE_BASE || './',
  plugins: [
    react(),
    {
      name: 'brand-html',
      transformIndexHtml(html) {
        return html.replace(
          /<title>.*?<\/title>/,
          `<title>${brand.name}</title>`,
        )
      },
    },
  ],
  server: {
    port: 5173,
    fs: {
      // Allow importing repo-root brand.json from src/lib/brand.js
      allow: [repoRoot],
    },
    proxy: {
      '/chat': 'http://localhost:4567',
      '/sessions': {
        target: 'http://localhost:4567',
        timeout: 0,
        proxyTimeout: 0,
      },
      '/runs': {
        target: 'http://localhost:4567',
        timeout: 0,
        proxyTimeout: 0,
      },
      '/workspace': 'http://localhost:4567',
      '/environments': 'http://localhost:4567',
      '/capabilities': 'http://localhost:4567',
      '/lsp': 'http://localhost:4567',
      '/health': 'http://localhost:4567',
      '/slash-commands': 'http://localhost:4567',
      '/plan': 'http://localhost:4567',
      '/session': 'http://localhost:4567',
      '/settings': 'http://localhost:4567',
      '/mcp': 'http://localhost:4567',
      '/ask_user_question': 'http://localhost:4567',
      '/can_use_tool': 'http://localhost:4567',
      '/skills': 'http://localhost:4567',
      '/agents': 'http://localhost:4567',
      '/plugins': 'http://localhost:4567',
      '/workspaces': 'http://localhost:4567',
      '/user-config': 'http://localhost:4567',
      '/extension-config': 'http://localhost:4567',
      '/marketplaces': 'http://localhost:4567',
      '/tool': 'http://localhost:4567',
      '/scheduled-tasks': 'http://localhost:4567',
      // SSO mode (dev): forward auth-service routes to localhost:8010.
      // Override the target with DEV_AUTH_BACKEND_URL if it runs elsewhere.
      '/sso': process.env.DEV_AUTH_BACKEND_URL || 'http://localhost:8010',
      '/api/auth': process.env.DEV_AUTH_BACKEND_URL || 'http://localhost:8010',
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
    // Push heavy markdown / syntax-highlight deps into their own vendor
    // chunk so transcript rows stay small. highlight.js (pulled in)
    // by rehype-highlight) is what bloated the bundle past 500 kB.
    rollupOptions: {
      output: {
        manualChunks: {
          'markdown-vendor': [
            'react-markdown',
            'remark-gfm',
            'rehype-highlight',
          ],
        },
      },
    },
  },
})
