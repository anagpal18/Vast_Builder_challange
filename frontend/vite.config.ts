import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// base './' → asset URLs are relative, so one build works at / and behind a path prefix (k8s Ingress /app).
export default defineConfig({
  base: './',
  plugins: [react(), tailwindcss()],
})
