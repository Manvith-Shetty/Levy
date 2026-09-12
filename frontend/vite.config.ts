import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// The gateway has no CORS headers of its own — rather than touch its code,
// the dev server proxies /api/* straight to it, so the browser only ever
// talks to same-origin URLs. Point GATEWAY_URL at a different instance
// (e.g. the provisioning gateway) to dashboard that one instead.
const gatewayUrl = process.env.GATEWAY_URL ?? 'http://localhost:4021'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    proxy: {
      '/api': {
        target: gatewayUrl,
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api/, ''),
      },
    },
  },
})
