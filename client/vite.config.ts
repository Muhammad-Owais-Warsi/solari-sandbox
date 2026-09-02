import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/issue': 'http://localhost:3000',
      '/sandbox': 'http://localhost:3000',
      '/agent/': 'http://localhost:3000',
      '/ollama': 'http://localhost:3000',
      '/test': 'http://localhost:3000',
      '/ws': {
        target: 'ws://localhost:3000',
        ws: true,
      },
    },
  },
})
