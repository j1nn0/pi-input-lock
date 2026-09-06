# AGENTS.md

## Communication

- Use Japanese only for user-facing communication.
- Use English for all non-user-facing communication and generated artifacts unless the repository, task, or existing content requires another language.
- Use English for agent-to-agent communication, delegation prompts, plans, findings, summaries, intermediate reports, tool-related annotations, code comments, documentation, and commit messages.
- Keep non-user-facing communication concise and information-dense. Do not restate context already available to the receiving agent.
- Preserve the language of existing content when editing it unless the task explicitly requires changing it.

## Project Rules

- The extension always loads; `PI_INPUT_LOCK=1` only selects the startup runtime-enabled state. `/input-lock enable|disable` changes it for the current process only and never persists.
- Use `ctx.isIdle()` as the source of truth for agent activity; do not infer activity from the lock state.
- Preserve input ownership for foreign focused UI and avoid dispatching one terminal event twice.
- Restore the exact borrowed editor factory and draft when releasing the lock.
- Keep runtime dependencies empty and load TypeScript directly without a build step.
- Update both English and Japanese documentation when user-facing behavior changes.

## Architecture

`src/index.ts` is the whole extension (`index.ts` only re-exports the default).
There is no build step: Pi loads TypeScript directly.

Two layers live in that file:

1. Exported pure functions — `nextState`, `nextStateWithPolicy`, `isForeignFocus`,
   `createInputLockRouter`, `matchesToggleKey`, the config readers, `LockedEditor`.
   Tests drive these directly.
2. The default-exported closure — all mutable state (lock state, saved editor factory,
   saved draft, listener disposers) plus the `pi.on(...)` lifecycle wiring.

Key invariants that are hard to infer from any single function:

- **Dual input channels.** The same router factory is instantiated twice, as
  `source: "terminal"` (`ctx.ui.onTerminalInput`) and `source: "input"`
  (`tui.addInputListener`). The terminal channel owns the toggle; the input channel
  deliberately defers it so one physical key never toggles twice. `isDuplicateNav`
  suppresses identical data delivered on both channels within 20ms.
- **Editor borrowing.** `applyLockUI(true)` captures `ui.getEditorComponent()` and the
  draft text, then installs the `LockedEditor` factory; `applyLockUI(false)` restores the
  exact captured factory, falling back to `undefined` (Pi's default editor) if the restore
  throws. WATCH entered while a foreign UI holds focus stays *unborrowed*.
- **Foreign focus is re-derived on every routing pass** by `dialogOpen()`, using reference
  identity only (never shape). It also gates `LockedEditor`'s cursor marker.
- **Fail open.** Almost every Pi API call is wrapped in a swallowing `try/catch` that
  degrades toward IDLE/unlocked. This is intentional: the lock must never break Pi's input
  pipeline. Keep new code in that style. The one intentional exception is
  `unlockPolicy: manual`, where WATCH persists after settlement.
- **Config precedence, never merged.** `readConfigJson()` returns the first existing file:
  `<pkg>/../config.json`, `<pkg>/config.json`, `~/.pi/agent/pi-input-lock.json`, then the
  legacy `~/.pi/agent/extensions/pi-input-lock/config.json`. Values are cached for the
  process lifetime — tests must call `resetInputLockConfigCache()`. A repo-root
  `config.json` is gitignored and wins during `pi -e .` development.

## Commands

- `pnpm check` — typecheck only (`pnpm lint` is the same command).
- `pnpm test` — Vitest. Single file: `pnpm exec vitest run test/router.test.ts`.
  Single case: `pnpm exec vitest run -t "<test name>"`.
- `pnpm pack:check` — packs to `/tmp`; verifies the `files` list in package.json.
- `pnpm smoke:pty` — boots real Pi in a PTY against a localhost mock model server.
  Requires the `script` command (util-linux) and a working `pnpm pack`; runs fully offline.
  Slow; run it when touching extension wiring, commands, or release metadata.
- Manual check: `PI_INPUT_LOCK=1 pi -ne -e . --tui-mode fullscreen`.
- pnpm only (`packageManager: pnpm@11.22.0`, Node >= 24); CI uses `--frozen-lockfile`.

## Testing

- `test/input-lock.test.ts` drives the extension through `makeHarness()`, a fake Pi
  (`pi.on` handler map, `ui.getEditorComponent`/`setEditorComponent`, `tui`, `ctx.isIdle`).
  Add lifecycle tests by invoking the captured handlers, not by touching internals.
- `test/router.test.ts` builds only the router IO seam — use it for input-routing rules.
- Config-reading tests must reset the module cache; env-dependent tests must restore
  `PI_INPUT_LOCK`.

## Coupled Changes

- New config option → reader + cache reset in `src/index.ts`, `pi-input-lock.schema.json`
  (`additionalProperties: false`), the option tables in both READMEs, and the
  "configuration" / "user config paths" tests.
- Pi version bump → devDependencies in package.json, `PI_VERSION` **and** the hardcoded
  boot regex `/pi v0\.85\.1/` in `scripts/pty-smoke.ts`, the `peerDependencies` range, and
  the pinned minimum in `.github/workflows/pi-compatibility.yml`.
- Release → bump `version`, add a `## [x.y.z]` section to CHANGELOG.md (the release
  workflow extracts it by awk and fails the tag if `v<version>` does not match
  package.json), then push the tag.
- Changing `files` in package.json → run `pnpm pack:check`.
- Commit messages follow Conventional Commits (`feat:`, `fix:`, `docs:`, `ci:`, `test:`,
  `chore:`; `feat!:` for breaking changes).

## Validation

- Run `pnpm check` and `pnpm test` after code changes.
- Run `pnpm pack:check` when changing package contents or release metadata.
- Run `pnpm smoke:pty` when changing extension wiring, commands, or release metadata.
