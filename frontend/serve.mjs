// Serves the dashboard at http://localhost:3000 for local work and screenshots.
//
// This project is a Vite + React app, so "serving the project root" means
// running Vite's dev server over it (TSX needs compiling; a static file server
// would hand the browser raw .tsx). /api is still proxied to the gateway —
// see vite.config.ts.
import { createServer } from 'vite'

const PORT = 3000
const URL = `http://localhost:${PORT}`

try {
  await fetch(URL, { signal: AbortSignal.timeout(800) })
  console.log(`Already running at ${URL} — not starting a second instance.`)
  process.exit(0)
} catch {
  // Nothing listening yet; start one.
}

const server = await createServer({
  server: { port: PORT, strictPort: true, host: 'localhost' },
})
await server.listen()
server.printUrls()
