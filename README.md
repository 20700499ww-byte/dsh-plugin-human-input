# dsh-plugin-human-input

让 Agent **像人一样**操控这台 Windows 电脑：一步一步挪鼠标、按下抬起、拖拽、逐字敲键盘，还能**截图看见结果**。

**不是**「截图 → 让模型猜坐标 → 一次性瞬移点击」那一套。每一步都是可编排、可中断、可验证的输入原语。

> 第三方插件，`built on DeepSeek Harness`，非官方项目。

---

## 为什么需要它

常见的 computer-use 方案是：截屏 → 视觉模型定位 → 单点跳过去点击。这有三个毛病：

1. **慢**：每一步都要一次截屏 + 一次视觉推理
2. **僵**：坐标猜偏一点就点空，没有任何纠错余量
3. **不像人**：光标瞬移，很多需要连续输入的程序（绘图、拖选、游戏、远程桌面）不认

这个插件换成**纯输入原语 + 按需截图**：动作由模型自己编排成串，需要确认结果时再截一张图看。

---

## 核心能力

### 1. `human_pointer` — 鼠标原语

| action | 说明 |
|---|---|
| `move` | 移动到绝对坐标，缓动曲线 + 弧度 + 微抖 |
| `move_by` | 相对移动（**"一步一步挪"就用它，连续多次，每次几十像素**） |
| `click` | 单击 / 双击 / 右键 / 中键 |
| `click_at` | **移动 + 点击一步完成**（比 move 后 click 少一次往返） |
| `press` / `release` | 按下不放 / 抬起（可组合出任意按住时长） |
| `drag` | 从 A 按住拖到 B，全程缓动 |
| `scroll` | 滚轮，带随机间隔 |
| `pos` / `screen` | 读光标位置 / 读屏幕尺寸 |

### 2. `human_keyboard` — 键盘原语

```
human_keyboard { action: "type", text: "你好，世界", delayMs: 40 }   // 逐字输入，支持中文
human_keyboard { action: "key", combo: "ctrl+shift+esc" }           // 组合键
```

### 3. `human_window` — 窗口感知（不截图）

```
human_window { action: "list" }    // 所有可见窗口：标题 + rect + hwnd
human_window { action: "active" }  // 当前前台窗口
human_window { action: "focus", hwnd: 393530 }
```

### 4. `human_script` — 连续手势（低延迟）

一次调用跑一串微动作，省掉工具往返：

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

支持的 op：`move` / `move_by` / `click` / `click_at` / `press` / `release` / `drag` / `scroll` / `key` / `type` / `wait` / `wait_window` / `focus`

### 5. `human_screenshot` — 让它「看见」

**返回图像本身，不是路径。** 有了它才有「操作 → 确认 → 纠错」的闭环。

```
human_screenshot { }                                          // 全屏
human_screenshot { x: 600, y: 300, width: 200, height: 150 }   // 局部
human_screenshot { x: 600, y: 300, width: 200, height: 150, zoom: 4 }  // 放大 + 网格
```

`zoom` 放大时图像带 **每 100 屏幕像素一条红色网格线**，能直接读出精确坐标——
在小图标、小标签页、菜单项上点准，靠的就是这个。

---

## 安装

```bash
dsh plugin --profile <你的profile> add github:20700499ww-byte/dsh-plugin-human-input
```

或从插件市场索引安装（Discover 里搜 **Human Input / 人手操控**）。

装完 `dsh --profile <你的profile> --dump-config` 能看到 `# == dsh-plugin-human-input` 层。

---

## 技术实现

```
index.js                        插件本体，注册 5 个工具
scripts/human-input-driver.ps1  常驻驱动（PowerShell + Win32）
```

| 设计 | 原因 |
|---|---|
| **常驻进程**（stdin 一行 JSON / stdout 一行 JSON） | 每次启动 PowerShell + `Add-Type` 要 ~700ms，逐次调用会让「一步一步挪」卡到没法用 |
| **Win32 注入**（`SetCursorPos` / `mouse_event` / `SendInput`） | 走系统真实输入通道，前台程序收到的是"真"鼠标键盘事件 |
| **easeInOutCubic 轨迹** | 起步和收尾慢、中段快，接近真人手腕运动；比纯 easeOut 更自然 |
| **贝塞尔弧度 + 递减抖动 + 终点过冲回正** | 消除"机械直线"的僵硬感 |
| **DPI 感知**（per-monitor-v2） | 高缩放屏幕上坐标不偏移 |
| **UTF-8 stdin** | PowerShell 5.1 默认按 GBK 解码 stdin，中文指令会被解成乱码 |
| **ESC 全局急停** | 任何时刻按 ESC 立刻中止当前动作 |

### 配置项（`cordis.patch.yml`）

| 配置 | 默认 | 含义 |
|---|---|---|
| `speed` | `1` | 速度倍率，`2` 更快，`0.5` 更慢更像人 |
| `startupTimeoutMs` | `30000` | 驱动启动超时 |

---

## 实测数据

| 项目 | 结果 |
|---|---|
| 移动到位精度 | **0.0 px 误差**（400,300 / 1200,700 / 960,540 三次） |
| 相对移动精度 | **0.0 px 误差**（+60,+35） |
| 轨迹平滑度 | 最大单步 12.5 px，平均 4.1 px，**无瞬移** |
| 速度曲线 | 前 1.9 / 中 8.5 / 后 1.9 px/帧 → **先慢-中快-后慢** |
| 放大截图 | zoom=4 时 200×150 → 800×600，**尺寸精确** |
| 功能测试 | **37 项全部通过**（5 个工具 × 全动作 + 参数校验 + 异常处理） |
| 中文输入 | ✅ 支持（已修复 GBK 解码问题） |
| 真实场景 | 打开 Edge → 搜索 → 进抖音 → 开观看历史 → 随机播放一个视频，全程只用本插件完成 |

---

## 安全设计

| 机制 | 行为 |
|---|---|
| **ESC 急停** | 任何时刻按 ESC，当前动作立刻中止并返回 `aborted: true` |
| **单线程串行** | 所有输入指令排队执行，并发调用不会互相踩 |
| **不联网** | 全部本地 Win32 调用，零网络请求 |
| **截图不落地** | 截图写入临时目录后立即删除，只保留附件引用 |
| **卸载即清理** | 停用插件会关掉常驻驱动进程，不留孤儿 |

---

## 已知限制

- **仅 Windows**（`os: ["win32"]`），驱动依赖 `user32.dll` / `gdi32.dll`
- **需要交互式桌面会话**：锁屏、无人登录、Session 0 服务里输入无法送达
- **会被提权窗口阻断**：任务管理器、UAC 提示等以管理员权限运行的窗口在前台时，
  系统会丢弃非提权进程的输入注入（`SetCursorPos` 返回 `False`，错误码 203）
- **不绕过 UIPI**：目标程序以管理员权限运行时，本插件（非提权）的注入会被系统丢弃
- **高 DPI**：已启用 per-monitor-v2 感知；极端多屏缩放场景建议先用 `screen` 与 `pos` 校准

---

## 更多

- [赞赏与支持](SPONSOR.md) —— 如果它帮到了你

---

<div align="center">
<sub>用着顺手的话，点个 ⭐ 收藏 —— 那是我继续更新的动力。</sub>
</div>

## License

MIT
