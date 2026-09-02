# @j1nn0/pi-input-lock

A small Pi extension that protects interactive input while an agent is running.
It is opt-in: the parent process is unchanged unless `PI_INPUT_LOCK=1` is set.

In `WATCH`, text, submit keys, paste, and Pi application shortcuts are consumed.
CSI and SSU arrow sequences continue to reach the focused component, and foreign
interactive UIs such as permission dialogs always receive their input. The
original editor and draft text are restored when the lock is released.

## Installation

```bash
pi install npm:@j1nn0/pi-input-lock
```

For local development:

```bash
PI_INPUT_LOCK=1 pi -ne -e . --tui-mode fullscreen
```

## Usage

Enable the extension explicitly:

```bash
export PI_INPUT_LOCK=1
```

The default toggle is `ctrl+alt+i`. Configure one shortcut in
`.pi/agent/extensions/pi-input-lock/config.json`:

```json
{ "toggleKey": "ctrl+alt+i" }
```

The same action is available as `/input-lock` or `/lock`.

States are lifecycle-aware:

- `IDLE`: input is available.
- `WATCH`: input is locked and the status bar shows `🔒 WATCH`.
- `OVERRIDE`: input is available after a manual toggle during an active run.

Agent start enters `WATCH`; agent settled returns from either active state to
`IDLE`. A manual toggle changes `WATCH` to `OVERRIDE` and back. If the runtime
cannot confirm that an agent is active, it fails open to `IDLE`.

## Development

```bash
pnpm check
pnpm test
pnpm pack:check
PI_INPUT_LOCK=1 pi -ne -e . --tui-mode fullscreen
```

## License

MIT
