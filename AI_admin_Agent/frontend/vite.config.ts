import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@brand': path.resolve(__dirname, '../../shared/brand'),
      // shared/brand JSX lives outside frontend root; pin React for Vite 8/Rolldown
      react: path.resolve(__dirname, 'node_modules/react'),
      'react/jsx-runtime': path.resolve(__dirname, 'node_modules/react/jsx-runtime'),
      'react/jsx-dev-runtime': path.resolve(__dirname, 'node_modules/react/jsx-dev-runtime'),
      'react-dom': path.resolve(__dirname, 'node_modules/react-dom'),
    },
    dedupe: ['react', 'react-dom'],
  },
  server: {
    fs: {
      allow: [path.resolve(__dirname, '../..'), path.resolve(__dirname)],
    },
    // 开发态同源登录 / API / WS → Admin 后端（与 compose 默认口一致）
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:13105',
        changeOrigin: true,
        ws: true,
      },
    },
  },
})
