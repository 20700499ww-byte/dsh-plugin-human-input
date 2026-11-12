# dsh-plugin-human-input

让 Agent **像人一样**操控这台 Windows 电脑：一步一步挪鼠标、按下抬起、拖拽、逐字敲键盘。

**不是**「截图 → 让模型猜坐标 → 一次性瞬移点击」那一套。这里没有截图环节，模型直接发底层输入原语。

> 第三方插件，`built on DeepSeek Harness`，非官方项目。

---

## 它解决什么问题

常见的 computer-use 方案是：截屏 → 视觉模型定位 → 单点跳过去点击。这有三个毛病：

1. **慢**：每一步都要一次截屏 + 一次视觉推理
2. **僵**：坐标猜偏一点就点空，没有任何纠错余量
3. **不像人**：光标瞬移，很多需要连续输入的程序（绘图、拖选、游戏、远程桌面）不认

这个插件换成**纯输入原语**：

| 原语 | 说明 |
|---|---|
| `move` / `move_by` | 缓动曲线移动（先快后慢 + 弧度 + 微抖 + 终点过冲回正） |
| `press` / `release` | 按下不放 / 抬起（可以手动组合出任意按住时长） |
| `click` | 单击 / 双击 / 右键 / 中键 |
| `drag` | 从 A 按住拖到 B，全程缓动 |
| `scroll` | 滚轮，带随机间隔 |
| `type` | **逐字**输入，支持中文，每字随机间隔 |
| `key` | 组合键，如 `ctrl+shift+esc`、`alt+tab`、`win+r` |
| `windows` / `active` / `focus` | 窗口枚举、前台查询、置前台（不截图） |

模型拿到这些之后可以自己编排：「先向右挪 60 像素，停 200ms，再向上挪 40，然后按下，拖到 (800,450)，松开」。

---

## 安装

```bash
dsh plugin --profile <你的profile> add github:20700499ww-byte/dsh-plugin-human-input
```

或从插件市场索引装（Discover 里搜 Human Input）。

装完 `dsh --profile <你的profile> --dump-config` 能看到 `# == dsh-plugin-human-input` 层。

---

## 提供的工具

### `human_pointer`
鼠标动作。`action` 取 `move | move_by | click | press | release | drag | scroll | pos | screen`。

```
human_pointer { action: "move", x: 800, y: 450, durationMs: 500 }
human_pointer { action: "move_by", dx: 40, dy: -15 }
human_pointer { action: "click", button: "left", count: 2 }
human_pointer { action: "press" }        // 按住不放
human_pointer { action: "drag", from: {x:100,y:100}, to: {x:600,y:400} }
human_pointer { action: "scroll", clicks: 5 }
```

### `human_keyboard`
```
human_keyboard { action: "type", text: "你好，世界", delayMs: 40 }
human_keyboard { action: "key", combo: "ctrl+shift+esc" }
```

### `human_window`
```
human_window { action: "list" }
human_window { action: "active" }
human_window { action: "focus", hwnd: 393530 }
```

### `human_script`
一次调用跑一串动作，省掉工具往返延迟：

```json
{
  "steps": [
    { "op": "move", "x": 400, "y": 300, "ms": 450 },
    { "op": "wait", "ms": 200 },
    { "op": "press" },
    { "op": "move", "x": 700, "y": 500, "ms": 700 },
    { "op": "release" },
    { "op": "type", "text": "done" }
  ]
}
```

---

## 安全设计

| 机制 | 行为 |
|---|---|
| **ESC 急停** | 任何时刻按 ESC，当前动作立刻中止并返回 `aborted: true` |
| **单线程串行** | 所有输入指令排队执行，模型并发调用不会互相踩 |
| **不截屏** | 插件本身不采集任何屏幕内容 |
| **不联网** | 全部本地 Win32 调用，零网络请求 |
| **卸载即清理** | 停用插件会关掉常驻驱动进程，不留孤儿 |

---

## 技术实现

```
index.js                     插件本体，注册 4 个工具
scripts/human-input-driver.ps1  常驻驱动（PowerShell + Win32）
```

- 驱动是**常驻进程**：stdin 一行 JSON 指令，stdout 一行 JSON 结果。
  常驻的原因很实际——每次启动 PowerShell + `Add-Type` 要 ~700ms，
  逐次调用会让「一步一步挪」卡到没法用。
- 轨迹算法：二次贝塞尔（带随机弓形偏移）→ `easeOutCubic` 采样 →
  叠加随进度衰减的抖动（最大 1.1px）→ 终点小过冲后回正。
- 中文输入走 `SendInput` 的 `KEYEVENTF_UNICODE`，不依赖输入法。
- 配置项：

| 配置 | 默认 | 含义 |
|---|---|---|
| `speed` | `1` | 速度倍率，`2` 更快，`0.5` 更慢更像人 |
| `startupTimeoutMs` | `30000` | 驱动启动超时 |

---

## 已知限制

- **仅 Windows**（`os: ["win32"]`），驱动依赖 `user32.dll`
- **需要交互式桌面会话**：锁屏、无人登录、或运行在 Session 0 服务里时输入无法送达
- **高 DPI 缩放**：坐标为物理像素。若系统缩放非 100%，窗口 `rect` 与光标坐标可能相差缩放倍数，建议先 `screen` 与 `pos` 校准
- **不绕过 UIPI**：目标程序以管理员权限运行时，本插件（非提权）的注入会被系统丢弃

---

## License

MIT
