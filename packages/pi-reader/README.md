# @inobit/pi-reader

**English** | [中文](./README.zh-CN.md)

Vim-style reading mode for Pi `fullscreen`: press `alt+o` to enter read-only and auto-expand `transcript` tool outputs, `ctrl-u/d/f/b`, `gg/G`, `j/k` to scroll, plus semantic jumps `[q/a/t`, paragraph `{}` and search `/`/`n`/`N`; your reading position is preserved across mode toggles and manual expand/collapse (prompt-ordinal anchoring), and exit restores `emacs` editing and collapsed tools.

- **Single-key toggle + auto-expand**: `alt+o` (intercepted via `TUI inputListener`, remappable via `toggleKey` in `extensions/pi-reader/config.json`) → `READING` with auto-expanded tool outputs; collapsed state is restored on exit. Prefer the tool state untouched? Set `autoExpandTools: false`
- **Position anchoring**: mode toggles and manual expand/collapse pin the viewport to the Q/A you were reading — anchored in the `OSC133` prompt-ordinal coordinate system (expand/collapse never adds/removes message boundaries, so ordinals are strictly stable); when collapsed content is shorter than one viewport it pins to the last page with the anchored line still on screen
- **Zero-intrusion editing**: fully passthrough in `INSERT`, keys intercepted only in `READING`; `ctrl+u = deleteToLineStart` by default with zero regressions
- **Pixel-perfect Pi scrolling**: `half = viewportHeight/2`, `page = viewportHeight-1` (`OVERLAP=1`), matching `TuiAltScreen`
- **Semantic navigation**: `[q/]q` question, `[a/]a` answer, `[t/]t` tool, `{`/`}` paragraph, `/` search with `n`/`N` (vim-style after `Enter`)
- **Robust event routing**: keys go through `TUI inputListener` — reading mode swallows keys, `INSERT` passes through; `ctx` is refreshed across multi-session events so `resume` on old sessions works

## Installation

```bash
pi install npm:@inobit/pi-reader
```

Local dev (isolated, --no-extensions excludes installed old version):

```bash
pi -ne -e ./packages/pi-reader --tui-mode fullscreen
```

> Only `fullscreen` is scrollable; in `regular` mode `scrollBy` has no viewport and the extension silently ignores it.

## Key Bindings

| Action | Key | Notes |
| --- | --- | --- |
| **Toggle reading** | `alt+o` / `/reader` / `/scroll` (toggle) | Default `alt+o`, remappable via `toggleKey` in `config.json` (e.g. `ctrl+o`); effective key is shown in the `?` popup |
| **Exit** | `esc` / `i` / `ctrl+c` | `esc`/`i`/`ctrl+c` in reading mode (`ctrl+c` does not clear screen), `i` does not leak into input |
| **Help** | `?` | Only in READING — shows English shortcut reference, `esc` to close |
| **Half page up / down** | `ctrl+u` / `ctrl+d` | `scrollBy(∓half)`; `ctrl+u` still deletes to line start in edit mode; `count` prefix e.g. `3 ctrl+u` |
| **Page down / up** | `ctrl+f` / `ctrl+b` | `scrollBy(±page)`; with `count` |
| **Line down / up** | `j` / `k` + `ctrl+n` / `ctrl+p` | `scrollBy(±1)`; with `count` e.g. `5j` |
| **Top** | `g g` | Double `g` within 300ms (including batched `gg`) → `scrollToTop()` |
| **Bottom** | `G` (`shift+g`) | `scrollToBottom()`, follows output |
| **Prev / next question** | `[q` / `]q` | `OSC133;A` prompt rows; `count` prefix e.g. `3]q`; flash `Question 2/5`; `visibleBehavior=keep` keeps viewport if already visible |
| **Prev / next answer** | `[a` / `]a` | First non-empty line after prompt; `count` supported |
| **Prev / next tool** | `[t` / `]t` | Heuristic `▌/⎿/●` etc.; `count` supported |
| **Prev / next paragraph** | `{` / `}` | Blank-line separated; `count` e.g. `2}` |
| **Search** | `/` then `n` / `N` | `/` enters search input (self-contained, flash echoes the query + `n/m` match count); while typing, every printable key (incl. `j/k/n`) is part of the query; `Enter` commits, `n` next / `N` prev cycle through matches |
| **Count prefix** | `1-9` (`0` after) | Accumulates up to 4 digits, `800ms` timeout, applies to `j/k`, half/page, `[q/a/t`, `{}` |
| **Expand / collapse tool output** | `app.tools.expand` (default `ctrl+o`, remappable in `keybindings.json`, e.g. `alt+o`) | **Works in both edit and READING mode**; inside READING its priority is below toggle/exit/help — don't bind it to the same key as `toggleKey` |

## Configuration

- Reading toggle: `extensions/pi-reader/config.json`
  ```json
  { "toggleKey": "alt+o", "autoExpandTools": true, "questionAnchor": "pinTop", "visibleBehavior": "keep", "wrapNavigation": false }
  ```
  `autoExpandTools`: `true` (default) auto expands/collapses tool output on toggle; `false` keeps tool state untouched (position is then naturally lossless). Others: `questionAnchor`: `pinTop` (=1, default) | `third` (=floor(vh/3)) | `center` (=floor(vh/2)) | `number`; `visibleBehavior`: `keep` (default, keep viewport if target already visible, flash only) | `reanchor`; `wrapNavigation`: wrap at ends. `?` popup shows the effective toggle key.

## Behavior

- **Read-only**: printable keys are swallowed in reading mode (`INSERT` passes through), the input bar is hidden behind a left-aligned `◉ Reading` overlay (borderless, fully covers the original position), original input is preserved and restored on exit
- **Anchoring**: semantic jumps compute `row - offset` (offset by `questionAnchor`) clamped to `maxTop` with `disableFollow:true`; visible targets with `keep` stay in place and flash `Question 2/5` instead of scrolling
- **Indicator**: `?` in READING shows the English help overlay (`Esc` to close) — a centered bordered box (`╭─╮`) with aligned key/description columns
- **Count**: digits `1-9` accumulate (`0` only after existing buffer), cleared after `800ms` or after jump/scroll; `[`/`]` (`500ms`) is leader sequence; `/` search runs fully inside the extension (no TUI overlay) so `Enter`/`n`/`N` never fight the input focus
- **Restore**: clears the `gg`/count/bracket buffers on exit, restores input and tool collapse state (tool expand/collapse is async and does not block the first frame)
- **Position anchoring**: captures an anchor (nearest prompt ordinal + in-segment offset) synchronously before any height change, then restores via the unified clamp model once layout settles (exact restore → in-segment truncation → pin to last page when content below is shorter than a viewport, anchored line still on screen); the restore monitor calls `requestRender` every tick (pi-tui renders on demand — zero frames while idle, so the stability criterion would never fire otherwise); toggling while following-end is left to native follow-end semantics

## Compatibility & Limitations

- **Key protocol**: compatible with legacy control sequences and `Kitty` keyboard protocol
- Mouse wheel / trackpad, text selection + copy, and `ctrl+shift+f` search still pass through in fullscreen
- `regular` mode has no `ScrollView` — navigation silently no-ops

## Development

```bash
pnpm --filter @inobit/pi-reader check
pnpm --filter @inobit/pi-reader test   # parseReadingKey/halfPage/pageStep/GgSequence + new navigation helpers
pnpm --filter @inobit/pi-reader pack:check
pi -ne -e ./packages/pi-reader --tui-mode fullscreen
```

## License

MIT
