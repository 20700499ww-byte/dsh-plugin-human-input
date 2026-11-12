/**
 * dsh-plugin-human-input
 *
 * 让 Agent 像人一样操控这台电脑：一步一步挪鼠标、按下抬起、逐字敲键盘，
 * 而不是「截图 → 猜坐标 → 一次性瞬移点击」。
 *
 * 设计取舍
 * --------
 * 1. 原语化：只提供 move / click / press / release / scroll / type / key
 *    这类底层动作，由模型自己串成一串。
 * 2. 真人轨迹：二次贝塞尔弧度 + easeOutCubic 缓动 + 递减抖动 + 终点微过冲回正；
 *    打字有随机间隔。这在驱动脚本里做，不是直线插值。
 * 3. 常驻驱动：鼠标键盘由一个常驻 PowerShell 进程执行（Win32 SendInput /
 *    mouse_event）。常驻避免每次操作付 ~700ms 的进程启动开销。
 * 4. 可中断：任何时刻按 ESC 立刻中止当前动作并返回 aborted。
 * 5. 零依赖：不 import 任何 @deepseek-ai/* 包，直接注册普通 ToolDefinition。
 *
 * 服务依赖：tools
 */

import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import { existsSync } from 'node:fs'

export const name = 'human-input'

export const inject = ['tools']

const DRIVER_RELATIVE = './scripts/human-input-driver.ps1'

/** 找到 powershell.exe（优先 Windows PowerShell 5.1，Add-Type 编译最稳） */
function resolvePowershell() {
  const candidates = [
    'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
    'C:\\Windows\\SysWOW64\\WindowsPowerShell\\v1.0\\powershell.exe',
  ]
  for (const p of candidates) if (existsSync(p)) return p
  return 'powershell.exe'
}

/**
 * 常驻驱动客户端：一行 JSON 进，一行 JSON 出。
 * 请求串行化，避免并发调用时指令交错。
 */
class Driver {
  constructor(logger, scriptPath, opts = {}) {
    this.logger = logger
    this.scriptPath = scriptPath
    this.startupTimeoutMs = opts.startupTimeoutMs ?? 30000
    this.child = null
    this.pending = []
    this.queue = Promise.resolve()
    this.starting = null
    this.disposed = false
    this.stderrTail = ''
  }

  async ensure() {
    if (this.disposed) throw new Error('human-input driver 已销毁')
    if (this.child) return this.child
    if (this.starting) return this.starting

    this.starting = (async () => {
      if (process.platform !== 'win32') throw new Error('human-input 只支持 Windows')
      if (!existsSync(this.scriptPath)) throw new Error(`找不到驱动脚本：${this.scriptPath}`)

      const ps = resolvePowershell()
      const child = spawn(
        ps,
        ['-NoProfile', '-NoLogo', '-ExecutionPolicy', 'Bypass', '-File', this.scriptPath],
        { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true },
      )
      this.child = child

      child.stderr.on('data', (d) => {
        this.stderrTail = (this.stderrTail + d.toString()).slice(-4000)
        if (this.logger?.warn) this.logger.warn(`[human-input] driver stderr: ${d.toString().trim()}`)
      })

      child.on('exit', (code) => {
        this.child = null
        const pending = this.pending
        this.pending = []
        for (const p of pending) {
          p.reject(
            new Error(
              `human-input driver 退出（code=${code}）${this.stderrTail ? '：' + this.stderrTail.slice(-500) : ''}`,
            ),
          )
        }
      })
      child.on('error', (err) => {
        this.child = null
        const pending = this.pending
        this.pending = []
        for (const p of pending) p.reject(err)
      })

      const rl = createInterface({ input: child.stdout })
      rl.on('line', (line) => {
        const text = line.trim()
        if (!text) return
        let msg
        try {
          msg = JSON.parse(text)
        } catch {
          return
        }
        if (msg.ready === true && this.pending.length === 0) {
          if (this.onReady) this.onReady(msg)
          return
        }
        const waiter = this.pending.shift()
        if (waiter) waiter.resolve(msg)
      })

      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          reject(
            new Error(
              `human-input driver 启动超时（${this.startupTimeoutMs}ms）${this.stderrTail ? '：' + this.stderrTail.slice(-500) : ''}`,
            ),
          )
        }, this.startupTimeoutMs)
        this.onReady = (msg) => {
          clearTimeout(timer)
          this.onReady = null
          resolve(msg)
        }
        const onFail = (err) => {
          clearTimeout(timer)
          this.onReady = null
          reject(err)
        }
        child.once('error', onFail)
        child.once('exit', (code) => onFail(new Error(`human-input driver 启动失败（code=${code}）`)))
      })

      return child
    })()

    try {
      return await this.starting
    } finally {
      this.starting = null
    }
  }

  /** 发一条指令，等一条结果 */
  request(req, timeoutMs) {
    const run = async () => {
      await this.ensure()
      const child = this.child
      if (!child) throw new Error('human-input driver 未就绪')

      const budget = timeoutMs ?? estimateTimeout(req)
      return await new Promise((resolve, reject) => {
        const entry = { resolve, reject, timer: null }
        const timer = setTimeout(() => {
          const idx = this.pending.indexOf(entry)
          if (idx >= 0) this.pending.splice(idx, 1)
          reject(new Error(`human-input 指令超时（${budget}ms）：${JSON.stringify(req)}`))
        }, budget)
        entry.timer = timer
        this.pending.push(entry)
        try {
          child.stdin.write(JSON.stringify(req) + '\n')
        } catch (err) {
          clearTimeout(timer)
          const idx = this.pending.indexOf(entry)
          if (idx >= 0) this.pending.splice(idx, 1)
          reject(err)
        }
      })
    }
    const next = this.queue.then(run, run)
    this.queue = next.then(
      () => {},
      () => {},
    )
    return next
  }

  async dispose() {
    this.disposed = true
    const child = this.child
    this.child = null
    if (!child) return

    const exited = new Promise((r) => child.once('exit', r))
    try {
      child.stdin.write(JSON.stringify({ op: 'quit' }) + '\n')
    } catch {}

    const graceful = await Promise.race([
      exited.then(() => true),
      new Promise((r) => setTimeout(() => r(false), 800)),
    ])
    if (!graceful) {
      try {
        child.kill()
      } catch {}
    }
    if (process.platform === 'win32' && child.pid) {
      try {
        const { execFile } = await import('node:child_process')
        await new Promise((r) => {
          execFile('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }, () => r())
        })
      } catch {}
    }
  }
}

function estimateTimeout(req) {
  const ms = Number(req.ms ?? 0)
  const typing = typeof req.text === 'string' ? req.text.length * (Number(req.delay ?? 35) * 1.5 + 40) : 0
  const clicks = Math.abs(Number(req.clicks ?? 0)) * 120
  return Math.max(8000, ms + typing + clicks + 8000)
}

// ---------------------------------------------------------------------------
// Schema：这里用「原始 JSON Schema」而不是 defineTool 的 author 简写，
// 因为本插件刻意不依赖 @deepseek-ai/dsh-tools（避免 profile 里解析不到 peer）。
// ---------------------------------------------------------------------------

/** 统一的输出 schema：宽松对象，保留驱动返回的一切字段 */
const OUT_SCHEMA = {
  type: 'object',
  additionalProperties: true,
  properties: {},
}

function textRender(value) {
  if (value == null) return [{ type: 'text', text: '(no result)' }]
  if (typeof value === 'string') return [{ type: 'text', text: value }]
  return [{ type: 'text', text: JSON.stringify(value, null, 2) }]
}

/** 统一包装：把驱动返回的 {ok,result,error} 变成工具结果 */
function wrap(raw) {
  if (raw && raw.ok === false) {
    const err = new Error(raw.error ?? 'human-input failed')
    err.humanInput = raw
    throw err
  }
  return {
    ok: true,
    result: raw?.result ?? raw ?? null,
    ...(raw?.aborted ? { aborted: true } : {}),
  }
}

/** 读取 PNG 的宽高（IHDR 固定在第 16..24 字节），失败返回 null */
function pngSize(buf) {
  if (!buf || buf.length < 24) return null
  if (buf[0] !== 0x89 || buf[1] !== 0x50 || buf[2] !== 0x4e || buf[3] !== 0x47) return null
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) }
}

export function apply(ctx, config = {}) {
  const scriptPath = fileURLToPath(new URL(DRIVER_RELATIVE, import.meta.url))
  const speed = Number(config.speed ?? 1)
  const driver = new Driver(ctx.logger, scriptPath, {
    startupTimeoutMs: Number(config.startupTimeoutMs ?? 30000),
  })

  const factor = speed > 0 ? speed : 1
  const scale = (ms, fallback) => Math.round((Number(ms ?? fallback) || fallback) / factor)
  const call = async (req, budget) => wrap(await driver.request(req, budget))

  // ------------------------------------------------------------------
  // 1) 指针
  // ------------------------------------------------------------------
  ctx.tools.register({
    name: 'human_pointer',
    description:
      '人类式鼠标操作。所有移动走缓动曲线（先快后慢、带弧度与微抖），不是瞬移。' +
      'action=move 到绝对坐标；move_by 相对移动；click 单击/双击；press/release 按住松开；' +
      'drag 拖拽；scroll 滚轮；pos 读当前位置；screen 读屏幕尺寸。' +
      '需要"一步一步"操控时，连续多次 move_by（每次几十像素），而不是一次跳到位。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['action'],
      properties: {
        action: {
          type: 'string',
          enum: ['move', 'move_by', 'click', 'click_at', 'press', 'release', 'drag', 'scroll', 'pos', 'screen'],
          description: '要执行的指针动作',
        },
        x: { type: 'number', description: 'move 的目标 X（屏幕像素）' },
        y: { type: 'number', description: 'move 的目标 Y（屏幕像素）' },
        dx: { type: 'number', description: 'move_by 的水平增量，正数向右' },
        dy: { type: 'number', description: 'move_by 的垂直增量，正数向下' },
        button: {
          type: 'string',
          enum: ['left', 'right', 'middle'],
          description: 'click/press/release 的按键，默认 left',
        },
        count: { type: 'integer', description: 'click 次数，1=单击，2=双击，默认 1' },
        from: {
          type: 'object',
          additionalProperties: false,
          required: ['x', 'y'],
          properties: { x: { type: 'number' }, y: { type: 'number' } },
          description: 'drag 的起点坐标',
        },
        to: {
          type: 'object',
          additionalProperties: false,
          required: ['x', 'y'],
          properties: { x: { type: 'number' }, y: { type: 'number' } },
          description: 'drag 的终点坐标',
        },
        durationMs: { type: 'number', description: '移动总时长（毫秒）。慢一点更像人：300~900' },
        clicks: { type: 'integer', description: 'scroll 的格数，正数向下，负数向上' },
      },
    },
    output: { schema: OUT_SCHEMA, render: (_a, v) => textRender(v.result) },
    isConcurrencySafe: () => false,
    async execute(args) {
      switch (args.action) {
        case 'move':
          if (args.x == null || args.y == null) throw new Error('move 需要 x 和 y')
          return call({ op: 'move', x: args.x, y: args.y, ms: scale(args.durationMs, 380) })
        case 'move_by':
          if (args.dx == null && args.dy == null) throw new Error('move_by 需要 dx 和/或 dy')
          return call({ op: 'rmove', dx: args.dx ?? 0, dy: args.dy ?? 0, ms: scale(args.durationMs, 300) })
        case 'click':
          return call({ op: 'click', button: args.button ?? 'left', count: args.count ?? 1 })
        case 'click_at':
          if (args.x == null || args.y == null) throw new Error('click_at 需要 x 和 y')
          return call({
            op: 'click_at',
            x: args.x,
            y: args.y,
            button: args.button ?? 'left',
            count: args.count ?? 1,
            ms: scale(args.durationMs, 320),
          })
        case 'press':
          return call({ op: 'down', button: args.button ?? 'left' })
        case 'release':
          return call({ op: 'up', button: args.button ?? 'left' })
        case 'drag':
          if (!args.from || !args.to) throw new Error('drag 需要 from 和 to')
          return call({
            op: 'drag',
            from: [args.from.x, args.from.y],
            to: [args.to.x, args.to.y],
            ms: scale(args.durationMs, 600),
          })
        case 'scroll':
          return call({ op: 'scroll', clicks: args.clicks ?? 3 })
        case 'pos':
          return call({ op: 'pos' })
        case 'screen':
          return call({ op: 'screen' })
        default:
          throw new Error(`未知 action：${args.action}`)
      }
    },
  })

  // ------------------------------------------------------------------
  // 2) 键盘
  // ------------------------------------------------------------------
  ctx.tools.register({
    name: 'human_keyboard',
    description:
      '人类式键盘操作。action=type 逐字输入（支持中文，字符间随机间隔）；' +
      'action=key 按组合键，如 ctrl+c、alt+tab、ctrl+shift+esc、enter、f5、win+r。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['action'],
      properties: {
        action: { type: 'string', enum: ['type', 'key'], description: 'type=输入文本；key=按组合键' },
        text: { type: 'string', description: 'type 时要输入的文本（\\n 换行，\\t 制表）' },
        combo: { type: 'string', description: 'key 时的组合键，如 ctrl+c、alt+tab、enter、f5、win+r' },
        delayMs: { type: 'integer', description: 'type 时每字间隔毫秒，默认 35；越小越快' },
      },
    },
    output: { schema: OUT_SCHEMA, render: (_a, v) => textRender(v.result) },
    isConcurrencySafe: () => false,
    async execute(args) {
      if (args.action === 'type') {
        if (typeof args.text !== 'string') throw new Error('type 需要 text')
        const delay = Math.max(0, Math.round(Number(args.delayMs ?? 35) / factor))
        return call(
          { op: 'type', text: args.text, delay },
          Math.max(10000, args.text.length * (delay * 2 + 60) + 8000),
        )
      }
      if (args.action === 'key') {
        if (!args.combo) throw new Error('key 需要 combo')
        return call({ op: 'key', combo: args.combo })
      }
      throw new Error(`未知 action：${args.action}`)
    },
  })

  // ------------------------------------------------------------------
  // 3) 窗口
  // ------------------------------------------------------------------
  ctx.tools.register({
    name: 'human_window',
    description:
      '窗口感知与切换（不截图，只取标题与矩形位置）。action=list 列出所有可见窗口（含 hwnd 与 rect）；' +
      'action=active 取当前前台窗口；action=focus 把指定 hwnd 提到前台。' +
      '要点击某窗口内的位置时，先用 list 拿到 rect，再用 human_pointer 移到 rect 内的坐标。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['action'],
      properties: {
        action: { type: 'string', enum: ['list', 'active', 'focus'], description: '要执行的动作' },
        hwnd: { type: 'number', description: 'focus 的目标窗口句柄' },
      },
    },
    output: { schema: OUT_SCHEMA, render: (_a, v) => textRender(v.result) },
    isConcurrencySafe: () => true,
    async execute(args) {
      switch (args.action) {
        case 'list':
          return call({ op: 'windows' }, 20000)
        case 'active':
          return call({ op: 'active' })
        case 'focus':
          if (args.hwnd == null) throw new Error('focus 需要 hwnd')
          return call({ op: 'focus', hwnd: args.hwnd })
        default:
          throw new Error(`未知 action：${args.action}`)
      }
    },
  })

  // ------------------------------------------------------------------
  // 4) 连续手势脚本
  // ------------------------------------------------------------------
  ctx.tools.register({
    name: 'human_script',
    description:
      '在一次调用里按顺序执行一串微动作，避免每次工具往返的延迟。适合"慢慢挪过去→停一下→按下→拖→松开"这种连续手势。' +
      'steps 里每项是 {op, ...}，op 支持 move/move_by/click/press/release/drag/scroll/key/type/wait；' +
      '字段与 human_pointer / human_keyboard 相同（move 用 x,y；move_by 用 dx,dy；drag 用 from,to；等）。' +
      '任何时刻按 ESC 中止，返回 aborted。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['steps'],
      properties: {
        steps: {
          type: 'array',
          description: '按顺序执行的动作数组，最多 200 个',
          items: {
            type: 'object',
            additionalProperties: true,
            required: ['op'],
            properties: {
              op: {
                type: 'string',
                description: 'move/move_by/click/press/release/drag/scroll/key/type/wait',
              },
              x: { type: 'number' },
              y: { type: 'number' },
              dx: { type: 'number' },
              dy: { type: 'number' },
              button: { type: 'string' },
              count: { type: 'integer' },
              from: { type: 'object', additionalProperties: true },
              to: { type: 'object', additionalProperties: true },
              clicks: { type: 'integer' },
              combo: { type: 'string' },
              text: { type: 'string' },
              delay: { type: 'integer' },
              ms: { type: 'integer' },
              hwnd: { type: 'number' },
              title: { type: 'string' },
              timeout: { type: 'integer' },
            },
          },
        },
      },
    },
    output: { schema: OUT_SCHEMA, render: (_a, v) => textRender(v.result) },
    isConcurrencySafe: () => false,
    async execute(args) {
      if (!Array.isArray(args.steps) || args.steps.length === 0) throw new Error('steps 需要非空数组')
      if (args.steps.length > 200) throw new Error('steps 一次最多 200 个')

      const done = []
      for (const step of args.steps) {
        const op = String(step.op ?? '')
        let req
        switch (op) {
          case 'move':
            req = { op: 'move', x: step.x, y: step.y, ms: scale(step.ms, 380) }
            break
          case 'move_by':
            req = { op: 'rmove', dx: step.dx ?? 0, dy: step.dy ?? 0, ms: scale(step.ms, 300) }
            break
          case 'click':
            req = { op: 'click', button: step.button ?? 'left', count: step.count ?? 1 }
            break
          case 'click_at':
            req = { op: 'click_at', x: step.x, y: step.y, button: step.button ?? 'left', count: step.count ?? 1, ms: scale(step.ms, 320) }
            break
          case 'wait_window':
            req = { op: 'wait_window', title: step.title, timeout: step.timeout ?? 15000 }
            break
          case 'press':
            req = { op: 'down', button: step.button ?? 'left' }
            break
          case 'release':
            req = { op: 'up', button: step.button ?? 'left' }
            break
          case 'drag':
            req = {
              op: 'drag',
              from: [step.from?.x, step.from?.y],
              to: [step.to?.x, step.to?.y],
              ms: scale(step.ms, 600),
            }
            break
          case 'scroll':
            req = { op: 'scroll', clicks: step.clicks ?? 3 }
            break
          case 'key':
            req = { op: 'key', combo: step.combo }
            break
          case 'type':
            req = {
              op: 'type',
              text: step.text ?? '',
              delay: Math.max(0, Math.round(Number(step.delay ?? 35) / factor)),
            }
            break
          case 'wait':
            req = { op: 'wait', ms: step.ms ?? 200 }
            break
          case 'focus':
            req = { op: 'focus', hwnd: step.hwnd }
            break
          default:
            throw new Error(`第 ${done.length + 1} 步 op 未知：${op}`)
        }
        const res = await driver.request(req, estimateTimeout(req) + 5000)
        if (res && res.ok === false) {
          throw new Error(`第 ${done.length + 1} 步（${op}）失败：${res.error ?? '未知错误'}`)
        }
        done.push({ step: done.length + 1, op, ok: true })
        if (res && res.aborted) {
          return { ok: false, aborted: true, result: { completed: done, abortedAt: done.length } }
        }
      }
      return { ok: true, result: { steps: done.length, executed: done } }
    },
  })

  // ------------------------------------------------------------------
  // 5) 截图：让模型「看见」屏幕（可选；依赖 attachments 服务）
  // ------------------------------------------------------------------
  const attachments = ctx.get ? ctx.get('attachments') : ctx.attachments
  if (attachments && typeof attachments.saveImage === 'function') {
    ctx.tools.register({
      name: 'human_screenshot',
      description:
        '截图并把图像直接返回给你看（不是只给路径）。用于操作后确认结果：点完按钮、页面加载完，截一张看看对不对。' +
        '默认截全屏；也可以给 x/y/width/height 只截一块区域。' +
        '要精确点击小目标（图标、标签、菜单项）时，先截一小块并把 zoom 设为 3~6 —— 放大图带 100px 网格，' +
        '能直接读出屏幕坐标，比在全屏图上估坐标准得多。返回值同时带坐标换算说明。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          x: { type: 'integer', description: '截取区域左上角 X（默认 0）' },
          y: { type: 'integer', description: '截取区域左上角 Y（默认 0）' },
          width: { type: 'integer', description: '截取宽度（默认全屏宽）' },
          height: { type: 'integer', description: '截取高度（默认全屏高）' },
          zoom: {
            type: 'integer',
            description: '放大倍数，1=原尺寸（默认），3~6 适合精确定位小目标；放大图带红色 100px 网格',
          },
          label: { type: 'string', description: '给这张图起个名字，便于识别，例如 "after-click"' },
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            path: { type: 'string' },
            width: { type: 'integer' },
            height: { type: 'integer' },
            originX: { type: 'integer' },
            originY: { type: 'integer' },
            zoom: { type: 'integer' },
            image: {
              type: 'object',
              additionalProperties: false,
              properties: {
                attachmentId: { type: 'string' },
                mediaType: { type: 'string' },
                bytes: { type: 'integer' },
                width: { type: 'integer' },
                height: { type: 'integer' },
                name: { type: 'string' },
              },
            },
          },
        },
        render: (_args, value) => {
          const zoom = value.zoom ?? 1
          const hint =
            zoom > 1
              ? `The image is magnified ${zoom}x with a red grid every 100 screen pixels. ` +
                `Divide any measured image coordinate by ${zoom}, then add (${value.originX},${value.originY}) to get the screen pixel.`
              : `Coordinates in this image map 1:1 to screen pixels: add (${value.originX},${value.originY}).`
          return [
            { type: 'text', text: `Screen region ${value.width}x${value.height} at (${value.originX},${value.originY}). ${hint}` },
            { type: 'image', attachment: value.image },
          ]
        },
      },
      isConcurrencySafe: () => true,
      async execute(args, exec) {
        const { mkdtempSync, readFileSync, rmSync } = await import('node:fs')
        const { tmpdir } = await import('node:os')
        const { join } = await import('node:path')

        const dir = mkdtempSync(join(tmpdir(), 'dsh-shot-'))
        const file = join(dir, 'shot.png')
        try {
          const dims = await driver.request({ op: 'screen' }, 15000)
          const sw = Number(dims?.result?.width ?? 0)
          const sh = Number(dims?.result?.height ?? 0)
          const x = Number(args.x ?? 0)
          const y = Number(args.y ?? 0)
          const w = Number(args.width ?? sw ?? 0)
          const h = Number(args.height ?? sh ?? 0)
          const zoom = Math.max(1, Math.min(8, Number(args.zoom ?? 1) || 1))
          if (!w || !h) throw new Error('无法确定截图尺寸（screen 返回异常）')

          const res = await driver.request({ op: 'capture', path: file, x, y, w, h, zoom }, 45000)
          if (res?.ok === false) throw new Error(res.error ?? 'capture failed')

          const buf = readFileSync(file)
          const size = pngSize(buf) ?? { width: w * zoom, height: h * zoom }
          const ref = await attachments.saveImage({
            data: new Uint8Array(buf),
            mediaType: 'image/png',
            name: args.label ? `${args.label}.png` : 'screenshot.png',
          })

          return {
            path: file,
            width: w,
            height: h,
            originX: x,
            originY: y,
            zoom,
            image: ref,
          }
        } finally {
          try {
            rmSync(dir, { recursive: true, force: true })
          } catch {}
        }
      },
    })
  }

  // 生命周期：插件卸载时关掉常驻驱动，避免留下孤儿进程
  if (typeof ctx.effect === 'function') {
    ctx.effect(() => {
      return () => {
        driver.dispose()
      }
    })
  }
}
