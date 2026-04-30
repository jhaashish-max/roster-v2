import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  base: '/roster-v2/',
  plugins: [react()],
  server: {
    proxy: {
      '/api/n8n': {
        target: 'https://n8n-conc.razorpay.com',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api\/n8n/, ''),
        secure: true
      }
    }
  }
})
