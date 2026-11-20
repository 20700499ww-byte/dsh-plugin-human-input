// Trajectory smoothness measurement.
// Uses the driver's built-in trace recorder (op:"trace") instead of polling the
// cursor from a second process: the driver serialises requests, so a sampler
// sharing the same queue can never observe a move in flight.
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))
const DRIVER = join(HERE, 'scripts', 'human-input-driver.ps1')
const PS = process.env.ComSpec
  ? 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'
  : 'powershell.exe'

const drv = spawn(PS, ['-NoProfile', '-NoLogo', '-ExecutionPolicy', 'Bypass', '-File', DRIVER], {
  stdio: ['pipe', 'pipe', 'pipe'],
})

let buf = ''
const queue = []
drv.stdout.on('data', (d) => {
  buf += d.toString('utf8')
  let i
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim()
    buf = buf.slice(i + 1)
    if (!line) continue
    try {
      const msg = JSON.parse(line)
      const waiter = queue.shift()
      if (waiter) waiter(msg)
    } catch {}
  }
})
drv.stderr.on('data', (d) => process.stderr.write(d))

function send(req) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout: ${JSON.stringify(req)}`)), 40000)
    queue.push((msg) => {
      clearTimeout(timer)
      resolve(msg)
    })
    drv.stdin.write(JSON.stringify(req) + '\n')
  })
}

await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('driver start timeout')), 30000)
  const check = setInterval(() => {
    if (queue.length) return
    clearInterval(check)
  }, 100)
  drv.stdout.once('data', () => {
    clearTimeout(timer)
    clearInterval(check)
    setTimeout(resolve, 150)
  })
})

const results = []

for (const [label, x, y, ms] of [
  ['short hop', 500, 400, 400],
  ['long sweep', 300, 850, 1000],
]) {
  await send({ op: 'trace', enabled: true })
  await send({ op: 'move', x, y, ms })
  const traced = await send({ op: 'trace', enabled: false })
  const raw = String(traced.result ?? '').trim()

  const points = raw
    .split(';')
    .filter(Boolean)
    .map((seg) => {
      const [t, xy] = seg.split('|')
      const [px, py] = String(xy ?? '').split(',').map(Number)
      return { t: Number(t), x: px, y: py }
    })
    .filter((p) => Number.isFinite(p.x) && Number.isFinite(p.y))

  const steps = []
  for (let i = 1; i < points.length; i++) {
    steps.push(Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y))
  }
  const maxStep = steps.length ? Math.max(...steps) : 0
  const avgStep = steps.length ? steps.reduce((a, b) => a + b, 0) / steps.length : 0
  const third = Math.floor(steps.length / 3)
  const seg = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0)

  results.push({
    label,
    points: points.length,
    maxStep,
    avgStep,
    curve: [seg(steps.slice(0, third)), seg(steps.slice(third, third * 2)), seg(steps.slice(third * 2))],
    last: points.length ? points[points.length - 1] : null,
    target: { x, y },
  })
}

await send({ op: 'quit' }).catch(() => {})
drv.kill()

let failed = 0
for (const r of results) {
  const dx = r.last ? r.last.x - r.target.x : NaN
  const dy = r.last ? r.last.y - r.target.y : NaN
  const err = Math.hypot(dx, dy)
  const noTeleport = r.maxStep > 0 && r.maxStep < 120
  const landed = err <= 1
  if (!noTeleport || !landed || r.points < 5) failed++

  console.log(`${r.label}`)
  console.log(`  samples          ${r.points}`)
  console.log(`  max step         ${r.maxStep.toFixed(1)} px   ${noTeleport ? 'PASS' : 'FAIL'}`)
  console.log(`  avg step         ${r.avgStep.toFixed(1)} px`)
  console.log(
    `  speed curve      ${r.curve.map((v) => v.toFixed(1)).join(' / ')} px per sample (start / middle / end)`,
  )
  console.log(`  landing error    ${err.toFixed(1)} px   ${landed ? 'PASS' : 'FAIL'}`)
  console.log()
}

process.exit(failed > 0 ? 1 : 0)
