# @j1nn0/pi-input-lock

Standalone Pi coding agent extension for `@earendil-works/pi-coding-agent` 0.84.2+, loaded via jiti without build.

## Tech Stack
- Node >=24 · pnpm 11.22.0 (pinned via `packageManager`)
- TypeScript ^7.0.0 (`tsc --noEmit` only)
- vitest ^4.1.8
- No runtime dependencies; Pi packages are `peerDependencies`

## Structure
- `package.json` … publish metadata, Pi entry `["./index.ts"]`
- `index.ts` … re-export
- `src/index.ts` … input lock implementation (~620 lines)
- `test/` … state machine and routing tests
- `config.json` … optional local config (ignored, not tracked)

## State Machine
- `IDLE` … agent idle, input available
- `WATCH` … agent running, input blocked, only toggle allowed, foreign UI passes through
- `OVERRIDE` … manual temporary unlock during a run, input available, toggle returns to `WATCH`
- Transitions: `IDLE --agent_start→ WATCH --toggle→ OVERRIDE --toggle→ WATCH --agent_settled→ IDLE`. `IDLE + toggle → IDLE` (manual WATCH is not allowed). `WATCH/OVERRIDE + agent_settled → IDLE` always. `nextState(state,event)` is pure and unit-testable. Duplicate `agent_start`/`settled` are idempotent.

## Activation
- Enabled only when `PI_INPUT_LOCK=1`. When unset, the extension is a no-op (no editor replacement, no listeners, no status, but pure functions remain importable). A parent Pi may have `HERDR_ENV` set and is still unaffected.

## Input Routing
- Dual channel: `tui.addInputListener` (TUI) + `ctx.ui.onTerminalInput` (terminal). `listenerInstalled` prevents duplicate registration, `offTerminalInput` cleans up.
- Router `createInputLockRouter(io, source)` does per-key `isForeignFocus(tui.focusedComponent, {editor})` via `dialogOpen()`. When a foreign UI holds focus, everything except `terminal+toggle` is `undefined` (pass-through); otherwise in `WATCH` only `toggle` (owned by terminal) passes, others are `{consume:true}` (block). `isDuplicateNav` suppresses duplicate delivery for 20ms, arrow CSI/SSU passes through to `LockedEditor` (no-op).
- `LockedEditor` renders `🔒 WATCH · <toggle> to interact` centered, `handleInput` is no-op and secondarily blocks Pi shortcuts. `BaseEditor` is the normal editor.

## Editor Preservation
- `applyLockUI(locked)` saves `ui.getEditorText()` to `savedInput`, then `setEditorComponent(lockedEditorFactory)`→`setEditorText("")`; on unlock `setEditorComponent(mainFactory)`→`setEditorText(savedInput)`. On failure it reverses for fail-open. `forceIdle()` guarantees restoration from `WATCH`. `currentEditor/currentLockedEditor` are the `focusedComponent` check basis.

## Fail-open
- `refreshCtx` forces `forceIdle()` to `IDLE` whenever `ctx.isIdle()===true`. `WATCH` is only entered via `agent_start`. Exceptions, abort, error, `/new`, session switch, reload, duplicate events are idempotent via `applyTransition`, `handleSession` resets to `IDLE`, `setStatus` is try/catch.

## Toggle
- Default `ctrl+alt+i` (Kitty `\x1b[105;7u` and legacy `\x1b\x09`), configurable via `config.json: {toggleKey}` as any `KeyId` (`readConfigJson` scans `__dirname` and `~/.pi/agent/extensions/pi-input-lock/config.json`). `matchesToggleKey` uses `matchesKey` + 105;6u compatibility, `getToggleKeyId` normalizes. Commands `/input-lock` `/lock` are no-op with `Input lock is only available while an agent is running.` when `IDLE`.

## Tests
- Verify via `pnpm check` / `pnpm test` / `pnpm pack:check`. When changing routing, keep `test/router.test.ts` foreign/owned cases. `BaseEditor`/`LockedEditor` must be constructed with real theme/keybindings.
- Main tests: 6 `nextState` transitions + duplicates, `isForeignFocus`, `toggleKey` matching, router WATCH block/OVERRIDE/IDLE, editor save/restore, agent lifecycle, disabled.

## Release
- Update `package.json` `CHANGELOG.md`, tag is `v0.1.0` form. Keep `pi-reader` derived MIT `Copyright (c) 2026 inobit`.
- Commit messages do not require `Co-authored-by: inobit pi-reader`.
