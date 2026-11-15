import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    host: '0.0.0.0',
    proxy: {
      // Keep the browser-facing Host so the API's origin check sees the same
      // origin as the LAN client instead of the loopback proxy target.
      '/api': { target: 'http://127.0.0.1:7877', changeOrigin: false },
      '/health': 'http://127.0.0.1:7877',
    },
  },
  build: { outDir: 'dist', emptyOutDir: true },
})
