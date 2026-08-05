import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const brandDir = path.resolve(__dirname, '../../shared/brand')

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@brand': brandDir,
    },
  },
  server: {
    port: 5174,
    fs: { allow: [brandDir, path.resolve(__dirname, '../..')] },
    proxy: {
      '/api': 'http://127.0.0.1:13104',
      '/_ws': { target: 'ws://127.0.0.1:13104', ws: true },
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
})
