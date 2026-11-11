import { sark } from '@olivaw/sark/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [react({ compiler: true }), sark({ target: 'node' })],
})
