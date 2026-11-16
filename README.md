# dsh-plugin-human-input

An agent that drives this Windows machine the way a person would: nudging the cursor across the screen, pressing and releasing, dragging, typing one character at a time — then taking a screenshot to see how it went.

**Not** the "screenshot → let the model guess coordinates → teleport the pointer → click" routine. Every step here is an input primitive you can arrange, interrupt, and verify.

> Third-party plugin, built on DeepSeek Harness. Not an official project.

## Why not screenshot-based positioning

The usual approach grabs a screenshot, has a vision model locate the target, then jumps the pointer over and clicks.

Two problems. Every step costs a screenshot plus an inference pass, which is slow. And a few pixels off means the click lands on nothing, with no room to correct. The cursor also teleports, which drawing apps, text selection, games and remote desktops simply won't accept.

This plugin goes the other way: input primitives only. The model strings them together and takes a screenshot when it needs to check the result.

## Five tools

### 1. `human_pointer` — mouse

| action | what it does |
|---|---|
| `move` | Move to absolute coordinates with an easing curve, an arc, and a little jitter |
| `move_by` | Relative move. This is the one for "nudge it over step by step": call it a few times, a few dozen pixels each |
| `click` | Single / double / right / middle click |
| `click_at` | Move and click in one call — one round trip fewer than move-then-click |
| `press` / `release` | Hold down / let go; combine them for any hold duration |
| `drag` | Press at A, drag to B, eased the whole way |
| `scroll` | Wheel, with randomized intervals |
| `pos` / `screen` | Read the cursor position / screen size |

### 2. `human_keyboard` — keyboard

```
human_keyboard { action: "type", text: "hello, world", delayMs: 40 }   // per-character typing, CJK included
human_keyboard { action: "key", combo: "ctrl+shift+esc" }               // key combos
```

### 3. `human_window` — windows (no screenshot)

```
human_window { action: "list" }    // every visible window: title + rect + hwnd
human_window { action: "active" }  // current foreground window
human_window { action: "focus", hwnd: 393530 }
```

### 4. `human_script` — gesture sequences

One call runs a whole string of micro-actions, saving tool round trips:

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

Supported ops: `move` / `move_by` / `click` / `click_at` / `press` / `release` / `drag` / `scroll` / `key` / `type` / `wait` / `wait_window` / `focus`

### 5. `human_screenshot` — letting it see

It returns the image itself, not a path. That's what closes the loop: act → check → correct.

```
human_screenshot { }                                          // full screen
human_screenshot { x: 600, y: 300, width: 200, height: 150 }   // a region
human_screenshot { x: 600, y: 300, width: 200, height: 150, zoom: 4 }  // magnified + grid
```

With `zoom`, the image gets a red grid line every 100 screen pixels. That's how you hit a small icon, tab or menu item on the first try.

## 安装

```bash
dsh plugin --profile <你的profile> add github:20700499ww-byte/dsh-plugin-human-input
```

也可以从插件市场索引装，Discover 里搜 **Human Input**。

装完跑 `dsh --profile <你的profile> --dump-config`，能看到 `# == dsh-plugin-human-input` 这一层。

## How it works

```
index.js                        the plugin itself, registers five tools
scripts/human-input-driver.ps1  resident driver (PowerShell + Win32)
```

| design | why |
|---|---|
| Resident process, one JSON line in on stdin, one JSON line out on stdout | Starting PowerShell plus `Add-Type` costs ~700ms per call; doing that every time makes "nudge it over step by step" unusable |
| Win32 injection (`SetCursorPos` / `mouse_event` / `SendInput`) | Goes through the real system input path, so foreground apps receive genuine mouse and keyboard events |
| easeInOutCubic trajectory | Slow at the start and end, fast in the middle — close to how a wrist moves; more natural than pure easeOut |
| Bezier arc + decaying jitter + end overshoot correction | Removes the stiffness of a mechanical straight line |
| DPI awareness (per-monitor-v2) | Coordinates stay correct on high-scaling displays |
| UTF-8 stdin | PowerShell 5.1 decodes stdin as GBK by default, which turns Chinese commands into mojibake |
| Global ESC abort | Press ESC at any time to stop the current action |

### Configuration (`cordis.patch.yml`)

| key | default | meaning |
|---|---|---|
| `speed` | `1` | Speed multiplier. `2` is faster, `0.5` slower and more human |
| `startupTimeoutMs` | `30000` | Driver startup timeout |

## Measured results

| item | result |
|---|---|
| Absolute move accuracy | 0.0 px error (400,300 / 1200,700 / 960,540, three runs) |
| Relative move accuracy | 0.0 px error (+60,+35) |
| Trajectory smoothness | Max single step 12.5 px, average 4.1 px, no teleporting |
| Velocity curve | 1.9 / 8.5 / 1.9 px per frame at start / middle / end — slow, fast, slow |
| Zoomed screenshot | zoom=4 turns 200×150 into 800×600, exact size |
| Functional tests | 37/37 passing (5 tools × all actions + parameter validation + error handling) |
| Chinese input | Supported (GBK decoding fixed) |
| Real scenario | Opened Edge, searched, went to Douyin, opened watch history, played a random video — all through this plugin alone |

## Safety design

| mechanism | behaviour |
|---|---|
| ESC abort | Press ESC at any time; the current action stops and returns `aborted: true` |
| Single-threaded queue | All input commands run in order; concurrent calls don't step on each other |
| No network | All local Win32 calls, zero network requests |
| Screenshots don't persist | Written to a temp directory and deleted immediately; only the attachment reference stays |
| Clean uninstall | Disabling the plugin shuts down the resident driver, no orphan processes |

## Known limitations

- Windows only (`os: ["win32"]`); the driver depends on `user32.dll` / `gdi32.dll`
- Needs an interactive desktop session. Locked screens, no logged-in user, or Session 0 services can't receive input
- Blocked by elevated windows. When Task Manager, UAC prompts or similar run as administrator in the foreground, Windows drops input injection from non-elevated processes (`SetCursorPos` returns `False`, error 203)
- Doesn't bypass UIPI. If the target app runs as administrator, this plugin's (non-elevated) injection is dropped
- High DPI: per-monitor-v2 awareness is on. For extreme multi-monitor scaling, calibrate with `screen` and `pos` first

## More

- [Sponsor & support](SPONSOR.md), if this helped you

---

<div align="center">
<sub>If it's useful, hit the ⭐ — that's what keeps me shipping updates.</sub>
</div>

## License

MIT
