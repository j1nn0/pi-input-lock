# Changelog

## [0.1.3] - 2026-08-29

- fix: harden queued-message recall path
  - fix: `findCustomEditor` now matches by action key — require `has("app.message.dequeue")` so decoy nodes with an `actionHandlers` map cannot shadow the real editor
  - fix: `session_shutdown` clears the captured TUI reference (`capturedTui.current = undefined`) to avoid stale cross-session references
  - fix: split the two queue-recall fallback notices — missing TUI reference (`Host TUI reference unavailable`) vs host structure drift (`Host editor structure changed`); both keep the manual dequeue shortcut hint
  - fix: `hasPendingMessages` throwing now returns conservatively (notify + return, no fall-through to the abort branch); hosts without the method keep the original fall-through semantics
- test: add cases for decoy-map still resolving the real editor, shutdown clearing the TUI reference, and the conservative `hasPendingMessages`-error path; update fallback assertions affected by the notice split

## [0.1.2] - 2026-08-25

- fix: mid-turn alt+u undid an arbitrary earlier exchange instead of the just-sent message (no stable pattern)
  - Root cause: the mirror-based soft-undo path consumed stale queue entries. The extension cannot observe the host clearing its steer/followUp queues on abort (`restoreQueuedMessagesToEditor`) or manual dequeue, so mirrored leftovers stayed forever; every later alt+u popped a stale copy instead of hard-reverting the just-sent message
  - Popping a local copy was a fake undo anyway: queued messages in the host queue would still be sent; only the editor gained a duplicate text
- feat(breaking-ish): remove the mirror queue and soft-undo path; unified alt+u semantics:
  - Queue non-empty while streaming: equivalent to the official dequeue action — recall all queued text to the editor and clear steer/followUp queues without interrupting the current turn or touching the session tree. Implemented by capturing the TUI reference through a zero-height `setWidget` component factory, locating the host `CustomEditor`, and directly invoking its registered `app.message.dequeue` handler (the same function object bound for alt+up). No programmatic dequeue API exists upstream (`alt+up` is a TUI-internal keybinding), so this is the closest official path
  - Streaming with empty queue: abort → wait for idle → hard-revert the just-sent user message
  - Draft guard has the highest priority across all branches: any non-empty editor (including queue text restored by the host during abort) is treated as a draft — notify and skip
  - Idle: hard-revert the last user message as before
  - If the host editor or its action map cannot be found (version drift), notify "Cannot reach host editor — press the dequeue shortcut (alt+up; alt+q on Windows)…" instead of failing silently
- test: drop mirror-related cases; add coverage for queue-recall dispatch via the captured editor, unreachable-editor notification, dequeue-handler error propagation, draft-guard precedence over the queue branch, tree-drift fallback, and that the queue path does not consume the single-per-turn budget

## [0.1.1] - 2026-08-22

- fix: three issues — message not removed from UI after undo, in-process LLM context not updated (silent correctness defect), undone messages resurrecting after resume
  - Root cause: `branch()/resetLeaf()` only moved the in-memory leaf pointer without persisting; in-process context/UI rebuild only happens inside host `navigateTree`; shortcut context lacks `navigateTree` capability causing silent degradation
  - Unified on `navigateTree(userEntryId, { summarize: false })`: the host special-cases user targets to leaf=parentId (auto resetLeaf for root), one path covers first/non-first messages with built-in UI/context rebuild; extension-side first-message special-casing removed
  - Append sentinel entry `pi-undo-pin` after successful undo (`pi.appendEntry`): pins the effective branch end to disk so resume (which rebuilds the leaf from the last file entry) no longer resurrects undone messages; sentinel stays out of LLM context and TUI rendering
  - Explicit navigation-result handling: target-is-current-leaf no-op early return, `session_before_tree` cancellation, and unmoved leaf all treated as failure — notify without editor refill, without consuming single-per-turn budget, never writing the sentinel
- feat(breaking-ish): alt+u now delegates to the `/undo` command pipeline (`pi.sendUserMessage("/undo", { expandPromptTemplates: true })`), guaranteeing behavioral parity with typing /undo by construction; direct doUndo invocation previously received a reduced ctx lacking session-control capabilities
- fix: restricted contexts without `navigateTree` now fail explicitly with a hint to use /undo; removed silent degradation to `sessionManager.branch()` (only moved in-memory pointers; UI/context/disk all stayed stale)
- test: rewrote parentId→entryId and first-message resetLeaf cases; added delegation-parity, no-op trap, navigation cancelled/unmoved, sentinel args & failure-no-pin, first-message-is-leaf edge cases
## [0.1.0] - 2026-08-21

- feat: first release — hard branch revert with single-per-turn guard, queue-aware, abort-then-undo
  - Command `/undo` + shortcut `alt+u` share `doUndo` (hard revert via `navigateTree(parentId)`/`branch(parentId)`/`resetLeaf` for first message, recoverable via `/tree`); file side-effects not reverted; only errors notified in English
  - Queue-aware: `a sent + b,c queued` → `undo` pops `c` to editor once (mirror `steer|followUp`, cap 20); next undo goes to history; draft check atomic before abort
  - Abort-then-undo: `!isIdle` → `abort()` → `waitUntilIdle` (event + 3s timeout / poll) before revert; draft re-checked after wait
  - Single per turn: `canUndo` per `sessionId`, reset on `before_agent_start`, set false after undo, `session_start` clears mirror; pending mutex prevents concurrent double-undo
  - Shortcut configurable via `~/.pi/agent/extensions/pi-undo/config.json` (`{"shortcut":"alt+u"}`), default `alt+u` (project override when trusted); no redo; editor has draft → "Editor has draft, clear it first" and do not overwrite
- test: history/config/undo state machine (extractText, findLastUserEntry, canUndo, mirror) + integration tests for `doUndo` (hasUI/draft/mirror/abort/hard revert/concurrency)
