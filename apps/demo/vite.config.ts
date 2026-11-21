import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  // GitHub Pages serves this repo at https://<user>.github.io/understudy/
  base: '/understudy/',
  plugins: [react()],
})
