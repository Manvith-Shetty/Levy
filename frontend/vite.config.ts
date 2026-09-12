import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig, loadEnv } from 'vite'

export default defineConfig(({ mode }) => {
  // Loads .env, .env.local, .env.[mode] etc from the project root — same
  // files Vite reads for import.meta.env in client code, so one variable
  // (see .env.example) covers both the dev proxy below and the optional
  // direct-call mode in src/lib/gateway/api.ts.
  const env = loadEnv(mode, process.cwd(), '')
  const gatewayUrl = env.VITE_GATEWAY_URL || 'http://localhost:4021'

  return {
    plugins: [react(), tailwindcss()],
    server: {
      proxy: {
        // The gateway has no CORS headers of its own — rather than touch its
        // code, the dev server proxies /api/* straight to it, so the browser
        // only ever talks to same-origin URLs. Point VITE_GATEWAY_URL at a
        // different instance (e.g. the provisioning gateway) to dashboard
        // that one instead.
        '/api': {
          target: gatewayUrl,
          changeOrigin: true,
          rewrite: (path) => path.replace(/^\/api/, ''),
        },
      },
    },
  }
})
