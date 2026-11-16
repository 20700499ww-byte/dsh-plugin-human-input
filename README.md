# dsh-plugin-human-input

让 Agent 像人一样操控这台 Windows 电脑：鼠标一步一步挪过去，按下抬起，拖拽，键盘一个字一个字敲，完了还能截图看一眼结果。

Human Input gives an agent a human-like grip on a Windows desktop: move the cursor in small eased steps, press and release, drag, type one character at a time, then take a screenshot to see what actually happened.

**不是**「截图 → 让模型猜坐标 → 一次性瞬移点击」那一套。这里每一步都是可编排、可中断、可验证的输入原语。

This is **not** the usual screenshot → guess the coordinates → teleport the pointer → click loop. Each step here is an input primitive you can chain, interrupt and check.

> 第三方插件，built on DeepSeek Harness，非官方项目。
>
> A third-party plugin built on DeepSeek Harness. Not an official project.

## 为什么不用截屏定位

常见做法是截一张图，让视觉模型找位置，然后单点跳过去点。

问题是每走一步都得截屏加一次推理，慢。坐标差几个像素就点空，也没有纠错余量。光标还是瞬移的，绘图、拖选、游戏、远程桌面这类靠连续输入吃饭的程序根本不认这种"点击"。

这个插件反过来：只给输入原语，动作由模型自己串成串，需要确认结果时再截一张图。

## 五个工具

### 1. `human_pointer` — 鼠标

| action | 说明 |
|---|---|
| `move` | 移动到绝对坐标，缓动曲线 + 弧度 + 微抖 |
| `move_by` | 相对移动。想「一步一步挪」就用它，连发几次，每次几十像素 |
| `click` | 单击 / 双击 / 右键 / 中键 |
| `click_at` | 移动加点击一步做完，比 move 再 click 少一次往返 |
| `press` / `release` | 按下不放 / 抬起，能组合出任意按住时长 |
| `drag` | 从 A 按住拖到 B，全程缓动 |
| `scroll` | 滚轮，带随机间隔 |
| `pos` / `screen` | 读光标位置 / 读屏幕尺寸 |

### 2. `human_keyboard` — 键盘

```
human_keyboard { action: "type", text: "你好，世界", delayMs: 40 }   // 逐字输入，支持中文
human_keyboard { action: "key", combo: "ctrl+shift+esc" }           // 组合键
```

### 3. `human_window` — 窗口（不截图）

```
human_window { action: "list" }    // 所有可见窗口：标题 + rect + hwnd
human_window { action: "active" }  // 当前前台窗口
human_window { action: "focus", hwnd: 393530 }
```

### 4. `human_script` — 连续手势

一次调用跑完一串微动作，省掉工具往返：

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

### 5. `human_screenshot` — 让它看见

返回的是图像本身，不是路径。有了它才有「操作 → 确认 → 纠错」这一圈。

```
human_screenshot { }                                          // 全屏
human_screenshot { x: 600, y: 300, width: 200, height: 150 }   // 局部
human_screenshot { x: 600, y: 300, width: 200, height: 150, zoom: 4 }  // 放大 + 网格
```

`zoom` 放大之后，图上每 100 屏幕像素画一条红色网格线。小图标、小标签页、菜单项要一次点准，靠的就是这个。

## 安装

```bash
dsh plugin --profile <你的profile> add github:20700499ww-byte/dsh-plugin-human-input
```

也可以从插件市场索引装，Discover 里搜 **Human Input**。

装完跑 `dsh --profile <你的profile> --dump-config`，能看到 `# == dsh-plugin-human-input` 这一层。

## 里面怎么做的

```
index.js                        插件本体，注册 5 个工具
scripts/human-input-driver.ps1  常驻驱动（PowerShell + Win32）
```

| 设计 | 原因 |
|---|---|
| 常驻进程，stdin 一行 JSON、stdout 一行 JSON | 每次启动 PowerShell 加 `Add-Type` 要 ~700ms，逐次调用会让「一步一步挪」卡到没法用 |
| Win32 注入（`SetCursorPos` / `mouse_event` / `SendInput`） | 走系统真实输入通道，前台程序收到的是真鼠标键盘事件 |
| easeInOutCubic 轨迹 | 起步和收尾慢、中段快，接近真人手腕；比纯 easeOut 自然 |
| 贝塞尔弧度 + 递减抖动 + 终点过冲回正 | 消掉机械直线的僵硬感 |
| DPI 感知（per-monitor-v2） | 高缩放屏上坐标不偏 |
| UTF-8 stdin | PowerShell 5.1 默认按 GBK 解码 stdin，中文指令会变乱码 |
| ESC 全局急停 | 任何时刻按 ESC 立刻中止当前动作 |

### 配置项（`cordis.patch.yml`）

| 配置 | 默认 | 含义 |
|---|---|---|
| `speed` | `1` | 速度倍率。`2` 更快，`0.5` 更慢更像人 |
| `startupTimeoutMs` | `30000` | 驱动启动超时 |

## 实测

| 项目 | 结果 |
|---|---|
| 移动到位精度 | 0.0 px 误差（400,300 / 1200,700 / 960,540 三次） |
| 相对移动精度 | 0.0 px 误差（+60,+35） |
| 轨迹平滑度 | 最大单步 12.5 px，平均 4.1 px，无瞬移 |
| 速度曲线 | 前 1.9 / 中 8.5 / 后 1.9 px/帧，先慢、中快、后慢 |
| 放大截图 | zoom=4 时 200×150 → 800×600，尺寸精确 |
| 功能测试 | 37 项全过（5 个工具 × 全动作 + 参数校验 + 异常处理） |
| 中文输入 | 支持（GBK 解码问题已修） |
| 真实场景 | 打开 Edge → 搜索 → 进抖音 → 开观看历史 → 随机播一个视频，全程只用本插件 |

## 安全相关的设计

| 机制 | 行为 |
|---|---|
| ESC 急停 | 任何时刻按 ESC，当前动作立刻中止并返回 `aborted: true` |
| 单线程串行 | 所有输入指令排队走，并发调用不会互相踩 |
| 不联网 | 全部本地 Win32 调用，零网络请求 |
| 截图不落地 | 截图写进临时目录后立刻删掉，只留附件引用 |
| 卸载即清理 | 停用插件会关掉常驻驱动进程，不留孤儿 |

## 已知限制

- 只有 Windows（`os: ["win32"]`），驱动依赖 `user32.dll` / `gdi32.dll`
- 需要交互式桌面会话。锁屏、没人登录、Session 0 服务里，输入送不进去
- 会被提权窗口挡住。任务管理器、UAC 提示这类以管理员权限运行的窗口在前台时，系统会丢掉非提权进程的输入注入（`SetCursorPos` 返回 `False`，错误码 203）
- 不绕过 UIPI。目标程序以管理员权限运行时，本插件（非提权）的注入会被系统丢掉
- 高 DPI：已经开了 per-monitor-v2 感知。极端多屏缩放场景，建议先用 `screen` 和 `pos` 校准

## 更多

- [赞赏与支持](SPONSOR.md)，如果它帮到了你

---

<div align="center">
<sub>用着顺手的话，点个 ⭐ 收藏。那是我继续更新的动力。</sub>
</div>

## License

MIT
