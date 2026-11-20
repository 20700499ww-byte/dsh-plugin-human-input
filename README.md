<div align="center">

<img src="icon.svg" alt="Human Input" width="96" height="96" />

# Human Input

**An agent that moves the mouse the way a hand does — not a pointer that teleports.**

A DeepSeek Harness plugin that gives an agent raw Windows input primitives: eased cursor paths,
press and release, drag, per-character typing, and screenshots it can actually look at.

[![License: MIT](https://img.shields.io/badge/License-MIT-38a3a5.svg)](LICENSE)
[![Platform](https://img.shields.io/badge/platform-Windows%2010%2F11-1f6feb.svg)](#requirements)
[![DSH](https://img.shields.io/badge/DeepSeek%20Harness-%E2%89%A50.2.0--rc.5-6f42c1.svg)](#requirements)
[![Tests](https://img.shields.io/badge/tests-41%20passing-2ea043.svg)](test-full.mjs)
[![Version](https://img.shields.io/badge/version-0.4.0-orange.svg)](CHANGELOG.md)

[Install](#install) · [Tools](#the-five-tools) · [How it works](#how-it-works) · [Limits](#known-limitations) · [中文说明](#中文说明)

</div>

---

## What this is

Most "computer use" stacks work like this: take a screenshot, ask a vision model where the button is,
teleport the pointer there, click, take another screenshot to see if it worked. Every step costs a
screenshot and an inference pass, and a few pixels of error means the click lands on nothing.

This plugin goes the other way. It exposes **input primitives** — the same moves a person makes — and
lets the model compose them:

- The cursor **travels** to the target along a curved, eased path with a little jitter, then settles.
  Drawing apps, text selection, drag-and-drop, games and remote desktops accept it, because it is a
  real pointer path rather than a jump.
- The keyboard types **one character at a time**, CJK included, with randomised gaps.
- A **screenshot returns the image itself**, with an optional zoom and a 100 px grid, so the model can
  read coordinates off it and correct its aim.

The result is a loop that actually closes: **act → look → correct**.

> Third-party plugin, built on DeepSeek Harness. Not an official project.

---

## Install

```bash
dsh plugin --profile <your-profile> add github:20700499ww-byte/dsh-plugin-human-input
```

Or install it from the plugin-market index — search **Human Input** in Discover.

Verify it landed:

```bash
dsh --profile <your-profile> --dump-config
# look for a "# == dsh-plugin-human-input" layer
```

### Requirements

| | |
|---|---|
| OS | Windows 10 / 11 (`os: ["win32"]`) |
| Runtime | Node.js ≥ 20 |
| Harness | DeepSeek Harness `>=0.2.0-rc.5 <0.3.0` |
| Session | An interactive desktop — a logged-in user with an unlocked screen |

No native build step, no `node_modules`, no network access at runtime. The driver is a single
PowerShell script using `user32.dll` / `gdi32.dll` through `Add-Type`.

---

## The five tools

### 1. `human_pointer` — the mouse

All movement is eased: slow at the start, fast through the middle, slow on arrival, with a Bezier bow
and decaying jitter. Nothing teleports.

| action | what it does |
|---|---|
| `move` | Move to absolute screen coordinates |
| `move_by` | Move by a relative offset — the one to call repeatedly for "nudge it over step by step" |
| `click` | Single, double, right or middle click |
| `click_at` | Move **and** click in one call — one round trip fewer than move-then-click |
| `press` / `release` | Hold a button down / let it go; combine for any hold duration |
| `drag` | Press at A, travel to B, release — eased the whole way |
| `scroll` | Wheel, with randomised intervals |
| `pos` / `screen` | Read the cursor position / the screen size |

```js
human_pointer { action: "move", x: 640, y: 360, durationMs: 600 }
human_pointer { action: "click_at", x: 640, y: 360 }
human_pointer { action: "drag", from: { x: 200, y: 200 }, to: { x: 900, y: 600 } }
```

### 2. `human_keyboard` — the keyboard

```js
human_keyboard { action: "type", text: "hello, 世界", delayMs: 40 }  // per-character, CJK included
human_keyboard { action: "key", combo: "ctrl+shift+esc" }            // key combinations
```

Combos accept the usual names: `ctrl`, `shift`, `alt`, `win`, `enter`, `tab`, `esc`, `f1`–`f12`,
arrows, `pageup`/`pagedown`, letters, digits and punctuation.

### 3. `human_window` — window awareness, no screenshot

```js
human_window { action: "list" }                        // every visible window: title, rect, hwnd, pid
human_window { action: "list", filter: "chrome" }      // only titles containing "chrome"
human_window { action: "list", pid: 9252 }             // only one process's windows
human_window { action: "active" }                      // current foreground window
human_window { action: "focus", hwnd: 393530 }         // bring one to the front
```

To click inside a window, `list` it first, take the `rect`, then aim `human_pointer` at a coordinate
inside that rect.

### 4. `human_script` — a whole gesture in one call

Batching micro-actions into one call removes the round-trip latency between steps — and the latency is
what makes an agent's behaviour look robotic.

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

Supported ops: `move` · `move_by` · `click` · `click_at` · `press` · `release` · `drag` ·
`scroll` · `key` · `type` · `wait` · `wait_window` · `focus`

Add `"dryRun": true` to validate every step and get back the compiled driver requests without emitting
a single input event. Useful before a destructive gesture.

### 5. `human_screenshot` — letting the model see

Returns the image itself, not a path. This is what closes the loop.

```js
human_screenshot { }                                                          // full screen
human_screenshot { x: 600, y: 300, width: 200, height: 150 }                  // one region
human_screenshot { x: 600, y: 300, width: 200, height: 150, zoom: 4 }         // magnified + grid
```

With `zoom`, a red grid line is drawn every 100 **screen** pixels. Measure in the magnified image,
divide by the zoom factor, add the region origin — that is your screen coordinate, accurate enough to
hit a small icon, tab or menu item on the first try.

---

## How it works

```
index.js                         the plugin: registers five tools, speaks one-line JSON to the driver
scripts/human-input-driver.ps1   resident driver: PowerShell + Win32, one JSON line in / out
```

| design decision | why |
|---|---|
| **Resident driver process** — one JSON line in on stdin, one JSON line out on stdout | Spawning PowerShell and running `Add-Type` costs ~700 ms. Paying that per call makes "nudge it step by step" unusable. |
| **Win32 injection** — `SetCursorPos` / `mouse_event` / `SendInput` | Goes through the real system input path, so foreground applications receive genuine mouse and keyboard events, indistinguishable from hardware at the message level. |
| **easeInOutCubic trajectory** | Slow at both ends, fast in the middle — close to how a wrist actually moves. More natural than pure `easeOut`, which starts fast and looks flicked. |
| **Bezier arc + decaying jitter + overshoot correction** | Removes the stiffness of a mechanical straight line, without wandering off target. |
| **Per-monitor-v2 DPI awareness** | Coordinates stay correct on mixed-scaling multi-monitor setups. |
| **UTF-8 on both stdin and stdout** | PowerShell 5.1 decodes stdin as GBK by default, which turned Chinese input into mojibake. |
| **Single-threaded request queue** | Concurrent tool calls execute in order; two gestures can never interleave and corrupt each other. |
| **Global ESC abort** | Press ESC at any moment; the current action stops and returns `aborted: true`. |

### Configuration

`cordis.patch.yml`:

| key | default | meaning |
|---|---|---|
| `speed` | `1` | Speed multiplier. `2` is twice as fast, `0.5` is slower and more deliberate. |
| `startupTimeoutMs` | `30000` | How long to wait for the driver to boot. |

---

## Measured results

Numbers below come from `test-full.mjs` and `test-trajectory.mjs` on a 1920×1080 Windows 11 desktop.

| item | result |
|---|---|
| Absolute move accuracy | 0.0 px error across `(400,300)`, `(1200,700)`, `(960,540)` |
| Relative move accuracy | 0.0 px error on `(+60,+35)` |
| Trajectory, short hop | 25 samples, max step 11.0 px, avg 4.2 px |
| Trajectory, long sweep | 123 samples, max step 11.7 px, avg 4.1 px |
| Velocity curve | 1.9 / 8.5 / 1.9 px per sample at start / middle / end — slow, fast, slow |
| Zoomed screenshot | `zoom=4` turns a 200×150 region into exactly 800×600 |
| Functional suite | 41 / 41 passing — every tool, every action, parameter validation, error paths || CJK input | Supported (stdin/stdout both forced to UTF-8) |
| End-to-end | Opened Edge, searched, navigated to Douyin, opened watch history and played a video — through this plugin alone |

---

## Safety design

| mechanism | behaviour |
|---|---|
| ESC abort | Press ESC at any time; the action stops and reports `aborted: true` |
| Serial queue | Input commands run strictly in order; concurrent calls cannot interleave |
| No network | Every call is a local Win32 call; the plugin opens no sockets |
| Screenshots don't persist | Written to a temp directory and deleted immediately; only the attachment reference survives |
| Clean uninstall | Disabling the plugin shuts the resident driver down — no orphan processes |
| Dry run | `human_script` can compile and validate a gesture without touching the mouse or keyboard |

---

## Known limitations

- **Windows only.** The driver depends on `user32.dll` and `gdi32.dll`; there is no macOS or Linux path.
- **Needs an interactive desktop.** Locked screens, a logged-out session, or Session 0 services cannot receive injected input.
- **Blocked by elevated windows.** When Task Manager, a UAC prompt or another admin-elevated window is in the foreground, Windows drops injection from a non-elevated process (`SetCursorPos` returns `False`, error 203). This is UIPI working as designed — run the host elevated if you need to drive elevated windows.
- **Extreme multi-monitor scaling.** Per-monitor-v2 awareness is on; if coordinates still look off, calibrate with `screen` and `pos` first.
- **Not a screen reader.** `human_screenshot` captures pixels. It does not read the accessibility tree; pair it with a DOM or UIA tool when you need semantics rather than pixels.

---

## FAQ

**Why not just use `pyautogui` / `robotjs`?**
Those set the cursor position directly. That is a teleport: drawing apps draw a straight line, drag-and-drop
never fires the intermediate events, and any app watching pointer velocity sees something impossible.
The point here is the *path*, not just the destination.

**Why PowerShell instead of a native Node addon?**
Zero build step. A `.ps1` using `Add-Type` ships as a plain file and works on any Windows 10/11 box with
no compiler, no `node-gyp`, no prebuilt binaries per Node version. The ~700 ms startup is paid once by
the resident process, not per call.

**Does it work over RDP?**
Yes, as long as the RDP session is the active console session. Disconnected sessions stop receiving input.

**Can two agents drive at once?**
Each plugin instance owns one driver and one serial queue. Two profiles mean two drivers; they will
fight over the one physical cursor. One driver per desktop.

---

## 中文说明

让 Agent 像人一样操控 Windows：鼠标一步一步挪过去、按下抬起、拖拽、逐字打字，完了还能截图看一眼结果。

**不是**「截图 → 让模型猜坐标 → 一次性瞬移点击」那一套。这里每一步都是可编排、可中断、可验证的输入原语。

安装：

```bash
dsh plugin --profile <你的profile> add github:20700499ww-byte/dsh-plugin-human-input
```

也可以在插件市场索引里装，Discover 搜 **Human Input**。

五个工具：`human_pointer`（鼠标）、`human_keyboard`（键盘）、`human_window`（窗口）、
`human_script`（连续手势，支持 `dryRun` 预演）、`human_screenshot`（截图，可放大并叠加 100px 网格）。

---

## More

- [Changelog](CHANGELOG.md) — what changed in each version
- [Sponsor & support](SPONSOR.md) — if this saved you some time
- [Issues](https://github.com/20700499ww-byte/dsh-plugin-human-input/issues) — bugs and feature requests

<div align="center">

<sub>If it's useful, hit the ⭐ — that's what keeps me shipping updates.</sub>

</div>

## License

MIT
