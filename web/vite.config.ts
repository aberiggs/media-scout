import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    host: '0.0.0.0',
    proxy: {
      '/api': 'http://127.0.0.1:7877',
      '/health': 'http://127.0.0.1:7877',
      '/cycle': 'http://127.0.0.1:7877',
    },
  },
  build: { outDir: 'dist', emptyOutDir: true },
})
