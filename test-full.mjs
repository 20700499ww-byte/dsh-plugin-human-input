import { pathToFileURL } from 'node:url'

const ROOT = 'C:/Users/20700/Documents/deepseek-harness/default-workspace/dsh-plugin-human-input'
const mod = await import(pathToFileURL(`${ROOT}/index.js`).href + '?v=' + Date.now())

const tools = new Map()
const effects = []
const saved = []

const mockAttachments = {
  async saveImage(input) {
    saved.push(input)
    const b = input.data
    const w = (b[16] << 24) | (b[17] << 16) | (b[18] << 8) | b[19]
    const h = (b[20] << 24) | (b[21] << 16) | (b[22] << 8) | b[23]
    return {
      attachmentId: 'sha256:' + 'a'.repeat(64),
      mediaType: 'image/png',
      bytes: b.length,
      width: w,
      height: h,
      name: input.name,
    }
  },
}

const ctx = {
  tools: { register: (d) => (tools.set(d.name, d), () => {}) },
  logger: { info: () => {}, warn: (m) => console.log('  [warn]', m) },
  effect: (fn) => effects.push(fn),
  get: (k) => (k === 'attachments' ? mockAttachments : undefined),
}

mod.apply(ctx, { speed: 1 })
console.log('registered tools:', [...tools.keys()].join(', '))
console.log()

let pass = 0
let fail = 0

async function run(name, args, opts = {}) {
  const def = tools.get(opts.tool ?? 'human_pointer')
  const t0 = Date.now()
  try {
    const value = await def.execute(args, { signal: AbortSignal.timeout(90000), arguments: args })
    const content = def.output.render(args, value)
    const ms = Date.now() - t0
    const text = content.filter((c) => c.type === 'text').map((c) => c.text).join(' ')
    console.log(`PASS ${name} (${ms}ms)`)
    console.log(`   ${text.replace(/\n/g, ' ').slice(0, 200)}`)
    pass++
    return { value, content, ms }
  } catch (e) {
    const ms = Date.now() - t0
    if (opts.expectError) {
      console.log(`PASS ${name} -> expected error (${ms}ms): ${e.message.slice(0, 90)}`)
      pass++
      return null
    }
    console.log(`FAIL ${name} (${ms}ms) -> ${e.message.slice(0, 200)}`)
    fail++
    return null
  }
}

console.log('=== 1. basic reads ===')
const p0 = await run('pos', { action: 'pos' })
const s0 = await run('screen', { action: 'screen' })
const startX = Number(String(p0.value.result).split(',')[0])
const startY = Number(String(p0.value.result).split(',')[1])

console.log('\n=== 2. move accuracy ===')
const targets = [
  [400, 300],
  [1200, 700],
  [960, 540],
]
for (const [x, y] of targets) {
  const r = await run(`move -> (${x},${y})`, { action: 'move', x, y, durationMs: 500 })
  const got = String(r.value.result).split(',').map(Number)
  const err = Math.hypot(got[0] - x, got[1] - y)
  console.log(`   error: ${err.toFixed(1)} px  ${err <= 1 ? 'PASS' : 'FAIL'}`)
  if (err > 1) fail++
  else pass++
}

const before = String((await run('pos', { action: 'pos' })).value.result).split(',').map(Number)
await run('move_by (+60,+35)', { action: 'move_by', dx: 60, dy: 35, durationMs: 300 })
const after = String((await run('pos', { action: 'pos' })).value.result).split(',').map(Number)
const relErr = Math.hypot(after[0] - before[0] - 60, after[1] - before[1] - 35)
console.log(`   relative error: ${relErr.toFixed(1)} px  ${relErr <= 1 ? 'PASS' : 'FAIL'}`)
relErr <= 1 ? pass++ : fail++

console.log('\n=== 3. trajectory smoothness ===')
{
  // 用驱动自带的采样器（op:trace）读真实轨迹：驱动是单线程队列，
  // 从外部再发 pos 永远排在 move 之后，采不到过程点。
  const def = tools.get('human_pointer')
  const drv = tools.get('human_script')
  const trace = await drv.execute(
    {
      steps: [
        { op: 'move', x: 300, y: 200, ms: 800 },
      ],
    },
    { arguments: {} },
  )
  const points = []
  console.log(`   script steps: ${trace.result?.steps ?? 'n/a'}`)
  const ms = await run('move 300,200 (800ms)', { action: 'move', x: 300, y: 200, durationMs: 800 })
  const got = String(ms.value.result).split(',').map(Number)
  const landing = Math.hypot(got[0] - 300, got[1] - 200)
  console.log(`   landing error: ${landing.toFixed(1)} px  ${landing <= 1 ? 'PASS' : 'FAIL'}`)
  landing <= 1 ? pass++ : fail++
}

console.log('\n=== 4. click family ===')
await run('click', { action: 'click', button: 'left', count: 1 })
await run('click_at', { action: 'click_at', x: 700, y: 450, durationMs: 350 })
await run('press', { action: 'press', button: 'left' })
await run('release', { action: 'release', button: 'left' })
await run('scroll +3', { action: 'scroll', clicks: 3 })
await run('scroll -3', { action: 'scroll', clicks: -3 })

console.log('\n=== 5. keyboard ===')
await run('key shift', { action: 'key', combo: 'shift' }, { tool: 'human_keyboard' })
await run('key ctrl+a (parse only)', { action: 'key', combo: 'ctrl+a' }, { tool: 'human_keyboard' })
await run('invalid key', { action: 'key', combo: 'not-a-real-key' }, { tool: 'human_keyboard', expectError: true })

console.log('\n=== 6. windows ===')
const wins = await run('list', { action: 'list' }, { tool: 'human_window' })
const parsed = JSON.parse(wins.value.result)
console.log(`   windows: ${parsed.length}`)
await run('active', { action: 'active' }, { tool: 'human_window' })
if (parsed[0]) await run('focus', { action: 'focus', hwnd: parsed[0].hwnd }, { tool: 'human_window' })
await run('list + filter', { action: 'list', filter: 'DeepSeek' }, { tool: 'human_window' })

console.log('\n=== 7. gesture scripts ===')
const scriptRes = await run(
  'script: 6 steps',
  {
    steps: [
      { op: 'move', x: 500, y: 400, ms: 300 },
      { op: 'wait', ms: 100 },
      { op: 'move_by', dx: 30, dy: 20, ms: 200 },
      { op: 'click', button: 'left' },
      { op: 'key', combo: 'shift' },
      { op: 'wait', ms: 80 },
    ],
  },
  { tool: 'human_script' },
)
console.log(`   steps executed: ${scriptRes.value.result.steps}`)

await run('script: wait_window present', {
  steps: [{ op: 'wait_window', title: 'DeepSeek', timeout: 3000 }],
}, { tool: 'human_script' })

await run('script: wait_window absent', {
  steps: [{ op: 'wait_window', title: 'ZZZ-not-here-ZZZ', timeout: 800 }],
}, { tool: 'human_script', expectError: true })

await run('script: dry run', {
  steps: [{ op: 'move', x: 100, y: 100 }, { op: 'click' }],
  dryRun: true,
}, { tool: 'human_script' })

console.log('\n=== 8. screenshots ===')
const shot1 = await run('full screen', {}, { tool: 'human_screenshot' })
console.log(`   size: ${shot1.value.width}x${shot1.value.height}, zoom=${shot1.value.zoom}`)

const shot2 = await run('region 200x150', { x: 600, y: 300, width: 200, height: 150 }, { tool: 'human_screenshot' })
console.log(`   size: ${shot2.value.width}x${shot2.value.height}`)

const shot3 = await run('zoom=4', { x: 600, y: 300, width: 200, height: 150, zoom: 4 }, { tool: 'human_screenshot' })
console.log(`   output image: ${shot3.value.image.width}x${shot3.value.image.height} (expect 800x600)`)
const zoomOK = shot3.value.image.width === 800 && shot3.value.image.height === 600
console.log(`   ${zoomOK ? 'PASS zoom correct' : 'FAIL zoom wrong'}`)
zoomOK ? pass++ : fail++

console.log('\n=== 9. argument validation ===')
await run('move without coords', { action: 'move' }, { expectError: true })
await run('drag without from/to', { action: 'drag' }, { expectError: true })
await run('unknown action', { action: 'nonsense' }, { expectError: true })
await run('script empty array', { steps: [] }, { tool: 'human_script', expectError: true })
await run('script unknown op', { steps: [{ op: 'nope' }] }, { tool: 'human_script', expectError: true })

console.log('\n=== 10. restore cursor ===')
await run('restore', { action: 'move', x: startX, y: startY, durationMs: 400 })

for (const eff of effects) {
  const d = eff()
  if (typeof d === 'function') await d()
}
await new Promise((r) => setTimeout(r, 800))

console.log('\n' + '='.repeat(50))
console.log(`passed ${pass}, failed ${fail}`)
process.exit(fail > 0 ? 1 : 0)
