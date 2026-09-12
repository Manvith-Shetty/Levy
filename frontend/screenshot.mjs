// Usage:
//   node screenshot.mjs <url> [label] [--full] [--width=1440] [--height=900]
//                        [--click="css or text=Label"]... [--type="#sel=value"]...
//                        [--key=Meta+k]... [--wait=ms]
//
// Saves to "./temporary screenshots/screenshot-N[-label].png", auto-incremented
// and never overwritten. Interaction flags run in the order given, so modal and
// drawer states can be captured without touching the app.
import { mkdir, readdir } from 'node:fs/promises'
import path from 'node:path'
import puppeteer from 'puppeteer'

const args = process.argv.slice(2)
const positional = args.filter((a) => !a.startsWith('--'))
const flags = args.filter((a) => a.startsWith('--'))

const url = positional[0] ?? 'http://localhost:3000'
const label = positional[1]
const flag = (name) => flags.find((f) => f.startsWith(`--${name}=`))?.split('=').slice(1).join('=')
const full = flags.includes('--full')
const width = Number(flag('width') ?? 1440)
const height = Number(flag('height') ?? 900)
const settle = Number(flag('wait') ?? 500)

const dir = path.resolve('temporary screenshots')
await mkdir(dir, { recursive: true })
const taken = (await readdir(dir))
  .map((f) => /^screenshot-(\d+)/.exec(f)?.[1])
  .filter(Boolean)
  .map(Number)
const n = taken.length ? Math.max(...taken) + 1 : 1
const file = path.join(dir, `screenshot-${n}${label ? `-${label}` : ''}.png`)

const browser = await puppeteer.launch()
const page = await browser.newPage()
await page.setViewport({ width, height, deviceScaleFactor: 2 })
await page.goto(url, { waitUntil: 'networkidle0' })
await new Promise((r) => setTimeout(r, settle))

const pause = () => new Promise((r) => setTimeout(r, 450))
const find = async (target) => {
  if (target.startsWith('text=')) {
    const text = target.slice(5)
    return page.waitForSelector(`::-p-text(${text})`, { timeout: 4000 })
  }
  return page.waitForSelector(target, { timeout: 4000 })
}

for (const f of flags) {
  const [name, ...rest] = f.slice(2).split('=')
  const value = rest.join('=')
  if (name === 'click') {
    await (await find(value)).click()
    await pause()
  } else if (name === 'type') {
    const [selector, ...text] = value.split('=')
    const el = await find(selector)
    await el.click({ count: 3 })
    await el.type(text.join('='))
    await pause()
  } else if (name === 'key') {
    const keys = value.split('+')
    for (const k of keys) await page.keyboard.down(k)
    for (const k of keys.reverse()) await page.keyboard.up(k)
    await pause()
  }
}

await page.screenshot({ path: file, fullPage: full })
await browser.close()
console.log(file)
