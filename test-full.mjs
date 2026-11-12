// 完整功能测试：用真实驱动 + mock attachments，跑遍所有工具与动作
import { pathToFileURL } from 'node:url'

const ROOT = 'C:/Users/20700/Documents/deepseek-harness/default-workspace/dsh-plugin-human-input'
const mod = await import(pathToFileURL(`${ROOT}/index.js`).href + '?v=' + Date.now())

const tools = new Map()
const effects = []
const saved = []

const mockAttachments = {
  async saveImage(input) {
    saved.push(input)
    // 从 PNG 头读宽高
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
console.log('注册工具:', [...tools.keys()].join(', '))
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
    console.log(`✅ ${name} (${ms}ms)`)
    console.log(`   ${text.replace(/\n/g, ' ').slice(0, 200)}`)
    pass++
    return { value, content, ms }
  } catch (e) {
    const ms = Date.now() - t0
    if (opts.expectError) {
      console.log(`✅ ${name} → 预期报错 (${ms}ms): ${e.message.slice(0, 90)}`)
      pass++
      return null
    }
    console.log(`❌ ${name} (${ms}ms) → ${e.message.slice(0, 200)}`)
    fail++
    return null
  }
}

// ---------- 基础读取 ----------
console.log('=== 1. 基础读取 ===')
const p0 = await run('pos', { action: 'pos' })
const s0 = await run('screen', { action: 'screen' })
const startX = Number(String(p0.value.result).split(',')[0])
const startY = Number(String(p0.value.result).split(',')[1])

// ---------- 移动精度 ----------
console.log('\n=== 2. 移动精度 ===')
const targets = [
  [400, 300],
  [1200, 700],
  [960, 540],
]
for (const [x, y] of targets) {
  const r = await run(`move → (${x},${y})`, { action: 'move', x, y, durationMs: 500 })
  const got = String(r.value.result).split(',').map(Number)
  const err = Math.hypot(got[0] - x, got[1] - y)
  console.log(`   误差: ${err.toFixed(1)} px  ${err <= 1 ? '✅' : '❌'}`)
  if (err > 1) fail++
  else pass++
}

// 相对移动精度
const before = String((await run('pos', { action: 'pos' })).value.result).split(',').map(Number)
await run('move_by (+60,+35)', { action: 'move_by', dx: 60, dy: 35, durationMs: 300 })
const after = String((await run('pos', { action: 'pos' })).value.result).split(',').map(Number)
const relErr = Math.hypot(after[0] - before[0] - 60, after[1] - before[1] - 35)
console.log(`   相对误差: ${relErr.toFixed(1)} px  ${relErr <= 1 ? '✅' : '❌'}`)
relErr <= 1 ? pass++ : fail++

// ---------- 平滑度（采样轨迹） ----------
console.log('\n=== 3. 轨迹平滑度 ===')
{
  const samples = []
  const def = tools.get('human_pointer')
  const promise = def.execute({ action: 'move', x: 300, y: 200, durationMs: 800 }, { signal: AbortSignal.timeout(30000), arguments: {} })
  const sampler = setInterval(async () => {
    try {
      const v = await def.execute({ action: 'pos' }, { signal: AbortSignal.timeout(5000), arguments: {} })
      samples.push(String(v.result).split(',').map(Number))
    } catch {}
  }, 25)
  await promise
  clearInterval(sampler)
  const jumps = []
  for (let i = 1; i < samples.length; i++) {
    jumps.push(Math.hypot(samples[i][0] - samples[i - 1][0], samples[i][1] - samples[i - 1][1]))
  }
  const maxJump = jumps.length ? Math.max(...jumps) : 0
  const avgJump = jumps.length ? jumps.reduce((a, b) => a + b, 0) / jumps.length : 0
  console.log(`   采样 ${samples.length} 点, 最大单步 ${maxJump.toFixed(1)}px, 平均 ${avgJump.toFixed(1)}px`)
  console.log(`   ${maxJump < 120 ? '✅ 无瞬移' : '❌ 出现瞬移'}`)
  maxJump < 120 ? pass++ : fail++
}

// ---------- 点击 ----------
console.log('\n=== 4. 点击类 ===')
await run('click', { action: 'click', button: 'left', count: 1 })
await run('click_at', { action: 'click_at', x: 700, y: 450, durationMs: 350 })
await run('press', { action: 'press', button: 'left' })
await run('release', { action: 'release', button: 'left' })
await run('scroll +3', { action: 'scroll', clicks: 3 })
await run('scroll -3', { action: 'scroll', clicks: -3 })

// ---------- 键盘 ----------
console.log('\n=== 5. 键盘 ===')
await run('key shift', { action: 'key', combo: 'shift' }, { tool: 'human_keyboard' })
await run('key ctrl+a（安全的组合键，仅验证解析）', { action: 'key', combo: 'ctrl+a' }, { tool: 'human_keyboard' })
await run('非法键', { action: 'key', combo: 'not-a-real-key' }, { tool: 'human_keyboard', expectError: true })

// ---------- 窗口 ----------
console.log('\n=== 6. 窗口 ===')
const wins = await run('list', { action: 'list' }, { tool: 'human_window' })
const parsed = JSON.parse(wins.value.result)
console.log(`   窗口数: ${parsed.length}`)
await run('active', { action: 'active' }, { tool: 'human_window' })
if (parsed[0]) await run('focus', { action: 'focus', hwnd: parsed[0].hwnd }, { tool: 'human_window' })

// ---------- human_script ----------
console.log('\n=== 7. 连续手势 ===')
const scriptRes = await run(
  'script: 6 步（移动→等待→移动→点击→按键→等待）',
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
console.log(`   执行步数: ${scriptRes.value.result.steps}`)

await run('script: wait_window 存在', {
  steps: [{ op: 'wait_window', title: 'DeepSeek', timeout: 3000 }],
}, { tool: 'human_script' })

await run('script: wait_window 不存在', {
  steps: [{ op: 'wait_window', title: 'ZZZ不存在ZZZ', timeout: 800 }],
}, { tool: 'human_script', expectError: true })

// ---------- 截图 ----------
console.log('\n=== 8. 截图 ===')
const shot1 = await run('全屏截图', {}, { tool: 'human_screenshot' })
console.log(`   尺寸: ${shot1.value.width}x${shot1.value.height}, zoom=${shot1.value.zoom}`)

const shot2 = await run('区域截图 200x150', { x: 600, y: 300, width: 200, height: 150 }, { tool: 'human_screenshot' })
console.log(`   尺寸: ${shot2.value.width}x${shot2.value.height}`)

const shot3 = await run('放大截图 zoom=4', { x: 600, y: 300, width: 200, height: 150, zoom: 4 }, { tool: 'human_screenshot' })
console.log(`   输出图像: ${shot3.value.image.width}x${shot3.value.image.height} (期望 800x600)`)
const zoomOK = shot3.value.image.width === 800 && shot3.value.image.height === 600
console.log(`   ${zoomOK ? '✅ 放大正确' : '❌ 放大尺寸错误'}`)
zoomOK ? pass++ : fail++

// ---------- 参数校验 ----------
console.log('\n=== 9. 参数校验 ===')
await run('move 缺坐标', { action: 'move' }, { expectError: true })
await run('drag 缺 from/to', { action: 'drag' }, { expectError: true })
await run('未知 action', { action: 'nonsense' }, { expectError: true })
await run('script 空数组', { steps: [] }, { tool: 'human_script', expectError: true })

// ---------- 还原 ----------
console.log('\n=== 10. 还原光标 ===')
await run('还原', { action: 'move', x: startX, y: startY, durationMs: 400 })

// ---------- 清理 ----------
for (const eff of effects) {
  const d = eff()
  if (typeof d === 'function') await d()
}
await new Promise((r) => setTimeout(r, 800))

console.log('\n' + '='.repeat(50))
console.log(`通过 ${pass} 项，失败 ${fail} 项`)
process.exit(fail > 0 ? 1 : 0)
