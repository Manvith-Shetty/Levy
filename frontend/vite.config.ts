import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig, loadEnv } from 'vite'

export default defineConfig(({ mode }) => {
  // Loads .env, .env.local, .env.[mode] from the project root. GATEWAY_PROXY_TARGET
  // has no VITE_ prefix on purpose: it's where this dev server forwards /api,
  // and must never reach the browser bundle (see .env.example).
  const env = loadEnv(mode, process.cwd(), '')
  const gatewayUrl = env.GATEWAY_PROXY_TARGET || 'http://localhost:4021'

  return {
    plugins: [react(), tailwindcss()],
    server: {
      proxy: {
        // The gateway has no CORS headers of its own — rather than touch its
        // code, the dev server proxies /api/* straight to it, so the browser
        // only ever talks to same-origin URLs. Point GATEWAY_PROXY_TARGET at
        // a different instance (e.g. the provisioning gateway) to dashboard
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
