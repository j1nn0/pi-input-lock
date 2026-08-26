# @inobit/pi-undo

**English** | [中文](./README.zh-CN.md)

Undo for Pi coding agent: restore the last sent prompt to the editor and remove it from the conversation, single-per-turn, abort-then-undo.

- **Undo**: removes the last `user` turn and its entire assistant response (complete or partial) and restores it to the editor, recoverable via `/tree`; file side-effects are NOT reverted
- **Single per turn**: one undo per turn, reset on next `before_agent_start`; draft checked atomically before revert
- **Abort-then-undo**: if streaming, `abort()` then `waitForIdle()` before reverting the just-sent message
- **Queue non-empty = official dequeue (alt+up)**: recalls all queued text to the editor and clears steer/followUp queues **without interrupting the current turn**, session untouched. Implemented by capturing the TUI reference via a zero-height widget and directly invoking the host `CustomEditor`'s registered `app.message.dequeue` handler (the same function object bound for alt+up); falls back to a notify hint if unreachable

## Installation

```bash
pi install npm:@inobit/pi-undo
```

Restart Pi or run `/reload`.

Local dev (isolated, --no-extensions excludes installed old version):

```bash
pi -ne -e ./packages/pi-undo
# send a message, then /undo or alt+u
```

## Usage

- `/undo` — undo last sent prompt to editor. Only notifies on error (English).
- `alt+u` — same as `/undo`.

Behavior:
- If editor is non-empty, notifies `Editor has draft, clear it first` and does not undo. This guard has the highest priority and applies to every branch — including after an abort, when a misbehaving host may have restored queued text into the editor (it counts as a draft).
- Streaming with non-empty queue: equivalent to official dequeue — all queued text restored to the editor, queues cleared, current turn keeps running, session untouched (same effect as pressing alt+up).
- Streaming with empty queue: aborts then reverts the just-sent user message.
- Idle: reverts the last user message.
- If the host editor cannot be reached (version drift / non-TUI mode): notifies to use the dequeue shortcut (`alt+up`; `alt+q` on Windows).
- No redo: recover via `/tree`.

## Configuration

Shortcut is configurable via `~/.pi/agent/extensions/pi-undo/config.json` (requires `/reload`):

```json
{
  "shortcut": "alt+u"
}
```

Default `alt+u`. When trusted, project config at `.pi/extensions/pi-undo/config.json` overrides global.

## Compatibility & Limitations

- Reverts page immediately and persists across `--session`; first message via `resetLeaf`.
- File side-effects NOT reverted (edits/writes/bash); undo only reverts conversation branch.
- Queue recall relies on the host's `CustomEditor.actionHandlers` internal structure (undocumented API): if a pi upgrade changes it, the extension degrades gracefully to an alt+up hint. No programmatic dequeue API exists upstream.

## Development

```bash
pnpm --filter @inobit/pi-undo check   # tsc --noEmit
pnpm --filter @inobit/pi-undo test    # vitest
pnpm --filter @inobit/pi-undo pack:check
pi -ne -e ./packages/pi-undo
```

## License

MIT
