# @j1nn0/pi-input-lock

Pi coding agent の独立拡張。`@earendil-works/pi-coding-agent` 0.84.2+、jiti直載、コンパイル不要。

## 技術スタック
- Node >=24 · pnpm 11.22.0（`packageManager`で固定）
- TypeScript ^7.0.0（`tsc --noEmit`のみ）
- vitest ^4.1.8
- 実行時依存なし、Pi本体は`peerDependencies`

## 構成
- `package.json` … 公開メタデータ、Piエントリ `["./index.ts"]`
- `index.ts` … 再エクスポート
- `src/index.ts` … 入力ロック本体（約620行）
- `test/` … 状態機械・ルーティングテスト
- `config.json` … 任意設定（ignore、未追跡）

## 状態機械
- `IDLE` … エージェント停止中、通常入力
- `WATCH` … エージェント実行中、入力をblock、toggleのみ許可、外部UIはpass-through
- `OVERRIDE` … 実行中に手動で一時解除、入力可能、再度toggleで`WATCH`へ
- 遷移: `IDLE --agent_start→ WATCH --toggle→ OVERRIDE --toggle→ WATCH --agent_settled→ IDLE`。`IDLE + toggle → IDLE`（手動でWATCHに入れない）。`WATCH/OVERRIDE + agent_settled → IDLE` は常にIDLEへ。`nextState(state,event)` は純粋関数で単体テスト可能。重複`agent_start`/`settled`は冪等。

## 有効化
- `PI_INPUT_LOCK=1` のときのみ動作。未設定では拡張はno-op（エディタ置換・listener登録・status表示なし、純粋関数はimport可能）。親Piが `HERDR_ENV` を持っていても影響しない。`VITEST`時はテストのため有効とみなす。

## 入力ルーティング
- `tui.addInputListener` (TUI) + `ctx.ui.onTerminalInput` (terminal) の二重チャネル。`listenerInstalled`で重複登録防止、`offTerminalInput`で解除。
- ルータ `createInputLockRouter(io, source)` は `dialogOpen()` を毎キーで `isForeignFocus(tui.focusedComponent, {editor})` 比較。外部UIがフォーカスを持つ場合は`terminal+toggle`以外は全て`undefined`でpass-through、そうでなければ`WATCH`時のみ`toggle`(terminal所有)以外を`{consume:true}`でblock。`isDuplicateNav`で二重配送を20ms抑制、矢印CSI/SSUはpass-throughでLockedEditor(no-op)へ。
- `LockedEditor` は中央 `🔒 WATCH · <toggle> to interact` を描画、`handleInput`はno-opでPi shortcutも二次的にblock。`BaseEditor`は通常エディタ。

## エディタ保存・復元
- `applyLockUI(locked)` が `savedInput` に `ui.getEditorText()` を保存し `setEditorComponent(lockedEditorFactory)`→`setEditorText("")`、解除時は `setEditorComponent(mainFactory)`→`setEditorText(savedInput)`。失敗時は逆操作でfail-open。`forceIdle()`は`WATCH`からの復元を保証。`currentEditor/currentLockedEditor`は`focusedComponent`判定の基準。

## Fail-open
- `refreshCtx`で`ctx.isIdle()===true`なら`forceIdle()`で必ず`IDLE`へ。`agent_start`以外で`WATCH`に入らない。例外・abort・error・`/new`・session切替・reload・重複イベントでは`applyTransition`が冪等、`handleSession`系は`IDLE`へリセット、`setStatus`はtry/catch。

## トグル
- 既定 `ctrl+alt+i` (Kitty `\x1b[105;7u` と legacy `\x1b\x09`)、`config.json: {toggleKey}`で任意の`KeyId`に変更可能 (`readConfigJson`は`__dirname`と`~/.pi/agent/extensions/pi-input-lock/config.json`を走査)。`matchesToggleKey`は`matchesKey` + 105;6u互換、`getToggleKeyId`で正規化。コマンド`/input-lock` `/lock` は`IDLE`時は `Input lock is only available while an agent is running.` を通知してno-op。

## テスト
- `pnpm check` / `pnpm test` / `pnpm pack:check` で検証。ルーティング変更時は `test/router.test.ts` のforeign/ownedケースを維持。`ScrollReaderEditor`/`LockedEditor`は実theme/keybindingsで生成すること。
- 主要テスト: `nextState`の6遷移+重複、`isForeignFocus`、`toggleKey`一致、routerのWATCH block/OVERRIDE/IDLE、エディタ保存復元、agent lifecycle、無効時。

## リリース
- `package.json` `CHANGELOG.md` を更新、tagは `v0.1.0` 形式。`pi-reader`由来のMIT `Copyright (c) 2026 inobit` を保持。
