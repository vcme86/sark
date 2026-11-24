import { cloudflare } from '@cloudflare/vite-plugin'
import { sark } from '@olivaw/sark/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [
    react(),
    sark({ target: 'cloudflare' }),
    cloudflare({ viteEnvironment: { name: 'ssr' } }),
  ],
})
