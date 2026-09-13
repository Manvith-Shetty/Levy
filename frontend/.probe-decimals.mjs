import puppeteer from 'puppeteer'
const b = await puppeteer.launch(); const p = await b.newPage()
await p.setViewport({ width: 1440, height: 900 })
const wait = (ms) => new Promise((r) => setTimeout(r, ms))
const clickText = async (t) => (await p.waitForSelector(`::-p-text(${t})`)).click()
const typeInto = async (sel, text, clear = true) => { const el = await p.$(sel); if (clear) await el.click({ count: 3 }); await el.type(text); return p.$eval(sel, (e) => e.value) }
const backspace = async (sel, n) => { await p.focus(sel); for (let i = 0; i < n; i++) await p.keyboard.press('Backspace'); return p.$eval(sel, (e) => e.value) }

await p.goto('http://localhost:3000/', { waitUntil: 'networkidle0' }); await wait(5000)
await clickText('Create Agent'); await wait(300)
await typeInto('#live-label', 'gpu'); await clickText('Continue'); await wait(300)
const out = {}
out['0.001'] = await typeInto('#live-budget', '0.001')
out['backspace x2 from 0.001'] = await backspace('#live-budget', 2)
out['1.2.3'] = await typeInto('#live-budget', '1.2.3')
out['0.1234567 (7 places)'] = await typeInto('#live-budget', '0.1234567')
out['.5'] = await typeInto('#live-budget', '.5')
await typeInto('#live-budget', '0.05'); await clickText('Continue'); await wait(300)
out['max per call 0.0025'] = await typeInto('#live-per-call', '0.0025')
out['rate 0.00001'] = await typeInto('#live-rate', '0.00001')
out['live step-3 Continue enabled'] = await p.$$eval('button', (bs) => !bs.find((x) => x.textContent === 'Continue').disabled)

// demo wizard
await p.keyboard.press('Escape'); await wait(300)
await clickText('Demo Mode'); await wait(800)
await clickText('Create Agent'); await wait(300)
await typeInto('#agent-name', 'Probe'); await clickText('Continue'); await wait(300)
out['demo budget 12.75'] = await typeInto('#agent-budget', '12.75')
console.log(JSON.stringify(out, null, 2))
await b.close()
