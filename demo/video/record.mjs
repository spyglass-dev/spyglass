/**
 * Record the demo walkthrough as one continuous take, plus the brand mark.
 *
 *   DEMO_URL=http://127.0.0.1:5198 node demo/video/record.mjs [outDir]
 *
 * Needs the demo running with a distri key (the analyst builds a report) and
 * Playwright resolvable from the cwd. Writes outDir/take.webm, outDir/marks.json
 * (seconds into the take where each step starts) and outDir/mark.png. compose.py
 * cuts the take into captioned clips from video.json, which refers to the marks.
 */
import { chromium } from 'playwright'
import { mkdirSync, readdirSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'

const APP = process.env.DEMO_URL || 'http://127.0.0.1:5198'
const OUT = process.argv[2] ?? `${homedir()}/spyglass-shots/video/raw`
const SIZE = { width: 1280, height: 800 }
const QUESTION = 'Which channels convert best, and how does mobile compare to desktop?'
mkdirSync(OUT, { recursive: true })

const browser = await chromium.launch()

// The brand mark, cut from the demo header at 4x for the title and end cards.
{
  const page = await (await browser.newContext({ viewport: SIZE, deviceScaleFactor: 4 })).newPage()
  await page.goto(APP)
  await page.locator('header > div').first().screenshot({ path: `${OUT}/mark.png`, omitBackground: true })
  await page.context().close()
}

// Warm the page off-camera so the take does not open on a cold WASM boot.
{
  const page = await (await browser.newContext({ viewport: SIZE })).newPage()
  await page.goto(APP)
  await page.getByText('In your browser').waitFor({ timeout: 60_000 })
  await page.context().close()
}

const context = await browser.newContext({ viewport: SIZE, recordVideo: { dir: OUT, size: SIZE } })
const t0 = Date.now()
const page = await context.newPage()
const marks = {}
const mark = (name) => { marks[name] = (Date.now() - t0) / 1000 }
const pause = (ms) => page.waitForTimeout(ms)
/** Small wheel steps read as a glide; one jump reads as a cut. */
const glide = async (dy) => {
  await page.mouse.move(700, 500)
  for (let i = 0; i < 30; i++) { await page.mouse.wheel(0, dy / 30); await pause(28) }
}

await page.goto(APP)
await page.getByText('In your browser').waitFor({ timeout: 60_000 })
await page.locator('main .vega-embed').first().waitFor({ timeout: 60_000 })
await pause(800)
mark('overview')
await pause(3500)
await glide(700)
await pause(2500)
await glide(-700)
await pause(800)

mark('filter')
await page.getByRole('button', { name: 'Email', exact: true }).first().click()
await pause(4500)
await page.getByRole('button', { name: 'Clear' }).first().click()
await pause(1500)

mark('ask')
await page.getByRole('button', { name: 'New report' }).click()
await pause(1500)
const input = page.getByPlaceholder('e.g. How did the holiday season compare to last year?')
await input.click()
await input.pressSequentially(QUESTION, { delay: 40 })
await pause(700)
await page.getByRole('button', { name: 'Ask', exact: true }).click()
mark('working')

// Widgets stream in; settle when the analyst stops and the chart count holds.
let last = -1
let stable = 0
let first = false
const start = Date.now()
while (Date.now() - start < 240_000) {
  await pause(1000)
  const n = await page.locator('main .vega-embed').count()
  if (n > 0 && !first) { first = true; mark('building') }
  const working = await page.getByText(/Working on it|Thinking/).first().isVisible().catch(() => false)
  stable = !working && n > 0 && n === last ? stable + 1 : 0
  last = n
  if (stable >= 4) break
}
mark('answer')
await pause(4500)
await glide(650)
await pause(3000)
await glide(-650)
await pause(800)

mark('data')
await page.getByRole('button', { name: 'Data', exact: true }).click()
await pause(3500)
await glide(500)
await pause(2500)
mark('end')

await context.close()
await browser.close()
const webm = readdirSync(OUT).filter((f) => f.endsWith('.webm') && f !== 'take.webm')
renameSync(`${OUT}/${webm[0]}`, `${OUT}/take.webm`)
writeFileSync(`${OUT}/marks.json`, JSON.stringify(marks, null, 2))
console.log(JSON.stringify(marks))
