# Changelog

All notable changes to this project are recorded here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.4.0] — 2026-11-20

### Added

- `human_window` `list` accepts `filter` (case-insensitive title substring) and `pid`, so you can find one window among dozens without scrolling the whole dump.
- `human_window` `list` now reports each window's owning `pid`; the Win32 driver resolves it via `GetWindowThreadProcessId`.
- `human_script` `dryRun: true` validates every step and returns the compiled driver requests without emitting any input event.
- `npm test` and `npm run test:trajectory` scripts.
- Repository landing page on GitHub Pages, plus a CI smoke test workflow.

### Changed

- `human_script` accepts `click_at`, `wait_window` and `focus` in its documented op list (they were implemented but undocumented).
- Every `human_script` step is validated before the first one runs, so a typo at step 40 fails fast instead of halfway through a gesture.
- `test-trajectory.mjs` now reads the driver's internal trace recorder instead of polling the cursor from a second process. The old sampler shared the driver's single-threaded queue, so it could never observe a move in flight and always reported zero samples.
- `package.json` normalised: real `homepage`, `bugs`, `funding`, `author` object, `scripts`, and a wider keyword set for discovery.

### Fixed

- `wait_window` inside `human_script` could be killed by the request timeout before its own deadline. `estimateTimeout()` ignored `timeout`, so a `wait_window` set to 15 s was cut off by the 8 s default budget.

## [0.3.0] — 2026-11-12

### Added

- `human_pointer` `click_at`: move and click in one call, one round trip fewer than move-then-click.
- `human_screenshot` `zoom` with a red 100 px grid overlay, for reading exact coordinates off small targets.
- `human_script` `wait_window` and `focus` steps.
- Per-monitor-v2 DPI awareness in the driver.
- Sponsor page.

### Changed

- Trajectory switched to easeInOutCubic with a quadratic Bezier bow, decaying jitter and an end overshoot correction.
- README rewritten as a five-tool reference with measured results and known limits.

## [0.2.0] — 2026-10

### Added

- `human_screenshot` returns the captured image itself rather than a file path, closing the act → check → correct loop.
- `human_script` `focus` step.
- Full functional test (`test-full.mjs`) and trajectory test (`test-trajectory.mjs`).

### Fixed

- Tool output schema rewritten to a strict-compatible form; installation previously failed with `JsonSchemaError`.

## [0.1.0] — 2026-10

### Added

- Initial release: `human_pointer`, `human_keyboard`, `human_window`, `human_script` backed by a resident PowerShell + Win32 driver.
- Human-like cursor trajectory: eased movement, Bezier arc, decaying jitter.
- Per-character UTF-8 typing, including CJK.
- Global ESC abort.

[Unreleased]: https://github.com/20700499ww-byte/dsh-plugin-human-input/compare/v0.4.0...HEAD
[0.4.0]: https://github.com/20700499ww-byte/dsh-plugin-human-input/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/20700499ww-byte/dsh-plugin-human-input/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/20700499ww-byte/dsh-plugin-human-input/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/20700499ww-byte/dsh-plugin-human-input/releases/tag/v0.1.0
