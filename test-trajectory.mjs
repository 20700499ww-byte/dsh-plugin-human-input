// 轨迹平滑度测量：Node 直接 spawn 驱动，同时用独立 PowerShell 采样器高频读光标
import { spawn } from 'node:child_process'
import { writeFileSync } from 'node:fs'

const PS = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'
const DRIVER = 'C:\\Users\\20700\\Documents\\deepseek-harness\\default-workspace\\dsh-plugin-human-input\\scripts\\human-input-driver.ps1'

const sampler = `
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public class P {
  [DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT p);
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X; public int Y; }
}
"@
$sw = [System.Diagnostics.Stopwatch]::StartNew()
while ($sw.ElapsedMilliseconds -lt 20000) {
  $p = New-Object P+POINT
  [P]::GetCursorPos([ref]$p) | Out-Null
  Write-Output ("{0},{1},{2}" -f $sw.ElapsedMilliseconds, $p.X, $p.Y)
  Start-Sleep -Milliseconds 10
}
`
const samplerFile = 'C:\\Users\\20700\\Documents\\deepseek-harness\\default-workspace\\dsh-plugin-human-input\\_sampler.ps1'
writeFileSync(samplerFile, '\ufeff' + sampler, 'utf8')

const samplerProc = spawn(PS, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', samplerFile], { stdio: ['ignore', 'pipe', 'pipe'] })
let out = ''
samplerProc.stdout.on('data', (d) => { out += d.toString() })

// 等采样器起来
await new Promise((r) => setTimeout(r, 700))

// 直接 spawn 驱动
const drv = spawn(PS, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', DRIVER], { stdio: ['pipe', 'pipe', 'pipe'] })
await new Promise((resolve, reject) => {
  let buf = ''
  const t = setTimeout(() => reject(new Error('driver start timeout')), 30000)
  drv.stdout.on('data', (d) => {
    buf += d.toString()
    if (buf.includes('"ready":true')) { clearTimeout(t); resolve() }
  })
})

// 发移动指令
drv.stdin.write(JSON.stringify({ op: 'move', x: 300, y: 850, ms: 1000 }) + '\n')
await new Promise((r) => setTimeout(r, 1500))
drv.stdin.write(JSON.stringify({ op: 'quit' }) + '\n')
drv.kill()

await new Promise((r) => setTimeout(r, 900))
samplerProc.kill()

const rows = out.trim().split(/\r?\n/).filter(Boolean).map((l) => l.split(',').map(Number)).filter((r) => r.length === 3)
console.log('采样点:', rows.length)

const moving = []
for (let i = 1; i < rows.length; i++) {
  const d = Math.hypot(rows[i][1] - rows[i - 1][1], rows[i][2] - rows[i - 1][2])
  if (d > 0) moving.push({ t: rows[i][0], x: rows[i][1], y: rows[i][2], d })
}
console.log('移动中采样点:', moving.length)
if (moving.length > 3) {
  const jumps = moving.map((m) => m.d)
  const maxJ = Math.max(...jumps)
  const avgJ = jumps.reduce((a, b) => a + b, 0) / jumps.length
  console.log(`最大单步: ${maxJ.toFixed(1)} px`)
  console.log(`平均单步: ${avgJ.toFixed(1)} px`)
  console.log(`起点: ${moving[0].x},${moving[0].y}  终点: ${moving[moving.length - 1].x},${moving[moving.length - 1].y}`)
  console.log(`总时长: ${moving[moving.length - 1].t - moving[0].t} ms`)
  const third = Math.floor(jumps.length / 3)
  const seg = (a) => (a.length ? (a.reduce((x, y) => x + y, 0) / a.length).toFixed(2) : 'n/a')
  console.log(`速度曲线 前/中/后: ${seg(jumps.slice(0, third))} / ${seg(jumps.slice(third, third * 2))} / ${seg(jumps.slice(third * 2))} px/帧`)
  console.log(maxJ < 100 ? '✅ 无瞬移' : '❌ 有瞬移')
} else {
  console.log('❌ 没采到移动过程')
}
