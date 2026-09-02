# @j1nn0/pi-input-lock

Pi の対話入力を保護するウォッチロック拡張です。オプトイン方式のため、
`PI_INPUT_LOCK=1` を設定しない親プロセスには影響しません。

`WATCH` 中は文字入力、送信、ペースト、Pi のアプリケーションショートカットを消費します。
CSI と SSU の方向キーはフォーカス中のコンポーネントへ渡し、権限確認など外部 UI の
入力も常に妨げません。解除時には元のエディターと入力途中のテキストを復元します。

## インストール

```bash
pi install npm:@j1nn0/pi-input-lock
```

ローカル開発:

```bash
PI_INPUT_LOCK=1 pi -ne -e . --tui-mode fullscreen
```

## 使い方

明示的に有効化します。

```bash
export PI_INPUT_LOCK=1
```

既定の切替キーは `ctrl+alt+i` です。`.pi/agent/extensions/pi-input-lock/config.json` でキーを一つ設定できます。

```json
{ "toggleKey": "ctrl+alt+i" }
```

`/input-lock` または `/lock` でも同じ操作ができます。

状態はライフサイクル連携用に次の三つを使います。

- `IDLE`: 入力可能。
- `WATCH`: 入力をロックし、ステータスバーに `🔒 WATCH` を表示。
- `OVERRIDE`: 実行中に手動切替で一時的に入力可能。

エージェント開始で `WATCH`、処理完了でどちらの実行中状態からも `IDLE` に戻ります。
手動切替では `WATCH` と `OVERRIDE` を交互に変更します。実行中だと明確に確認できない
場合は安全のため `IDLE` として扱います。

## 開発

```bash
pnpm check
pnpm test
pnpm pack:check
PI_INPUT_LOCK=1 pi -ne -e . --tui-mode fullscreen
```

## ライセンス

MIT
