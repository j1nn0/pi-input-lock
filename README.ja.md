# @j1nn0/pi-input-lock

Pi の対話入力を一時的にロックし、エージェント実行中の誤操作を防ぐための拡張機能です。
オプトイン方式のため、`PI_INPUT_LOCK=1` を設定しない場合は Pi の動作は変わりません。

`WATCH` 中は文字入力、送信、ペーストなどを受け付けず、通常の Pi ショートカットも実行されないようにします。
方向キーなどの操作はフォーカス中のコンポーネントにそのまま渡されます。Pi や他の拡張機能が表示する確認ダイアログなどにフォーカスが移った場合、その UI の操作は妨げません。
ロックを解除すると、元のエディターと入力途中の内容が復元されます。

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

既定の切替キーは `ctrl+alt+i` です。設定ファイルは `~/.pi/agent/pi-input-lock.json` を使用します。

| 設定 | 型 | 既定値 | 説明 |
| --- | --- | --- | --- |
| `toggleKey` | string | `ctrl+alt+i` | ロックを切り替えるキー。 |
| `allowToolExpandInWatch` | boolean | `false` | `WATCH` 中もツール出力の展開・折りたたみ操作を使えるようにする。Pi の `app.tools.expand` のキー設定に従う（既定は Ctrl+O）。 |
| `unlockPolicy` | `agent-settled` \| `manual` | `agent-settled` | エージェントの処理完了時に自動でロックを解除するか、明示的に解除するまで `WATCH` を維持するかを選択します。 |

推奨する設定の組み合わせ:

```json
{
  "$schema": "https://raw.githubusercontent.com/j1nn0/pi-input-lock/main/pi-input-lock.schema.json",
  "toggleKey": "ctrl+alt+i",
  "allowToolExpandInWatch": true,
  "unlockPolicy": "manual"
}
```

`pi-input-lock.schema.json` を利用すると、対応するエディターで設定項目の補完や検証を利用できます。

設定はプロセスの存続中キャッシュされるため、変更後は Pi を再起動してください。

以前のパスである `~/.pi/agent/extensions/pi-input-lock/config.json` も引き続き読み込めます。
両方のファイルがある場合は新しい方を優先し、2つの設定を組み合わせて読み込むことはありません。

`WATCH`/`OVERRIDE` 中は `/input-lock` または `/lock` でも切り替えできます。エージェント停止中に手動の `WATCH` を ON/OFF するには、設定した切替キーを使ってください。
`/input-lock status` で、現在の状態、エージェントの実行状態、解除ポリシー、ツール出力の展開設定、切替キーを確認できます。状態は変更されません。`/lock status` も利用できます。

動作状態は次の3つです。

- `IDLE`: 入力可能。
- `WATCH`: 入力をロックし、ステータスバーに `🔒 WATCH` を表示。
- `OVERRIDE`: 実行中に手動切替で一時的に入力可能。

既定の `agent-settled` では、エージェントの実行開始時に `WATCH` へ入り、処理が完了すると自動的に `IDLE` へ戻ります（どちらの実行中状態からも `IDLE` に戻ります）。
`manual` を指定すると、エージェントの処理が完了しても `WATCH` は解除されません（`OVERRIDE` からは `IDLE` に戻ります）。エージェント停止後に切替キー（既定は Ctrl+Alt+I）を押すと `WATCH` が解除され、元のエディターと入力途中の内容が復元されます。手動モードでも起動時に `WATCH` になることはなく、拡張は常に `IDLE` から始まります。
`manual` ではエージェントが動いていないときも、切替キーで `WATCH` を手動で ON/OFF できます。エージェント実行中に切替キーを押すと、一時的に入力できる `OVERRIDE` へ移行します。もう一度押すと `WATCH` に戻ります。
`allowToolExpandInWatch` を有効にすると、`WATCH` 中でもツール出力の展開・折りたたみ操作を利用できます。Pi の既定キーは Ctrl+O です（`app.tools.expand` の設定に従うため、キーを変更している場合はそのキーが使われます）。

セッション境界やリセットイベントでは常に `IDLE` に戻り、`WATCH` は維持されません。既定の `agent-settled` では、エージェントが実行中か確認できない場合は安全のため `IDLE` として扱います。`manual` では、処理完了後に残った `WATCH` は明示的に解除するまで維持されます。

既知の動作上の制約: `manual` ではエージェント停止後も `WATCH` が残るため、端末経由で注入された入力（Herdr から次の指示をキー入力として送る場合など）はブロックされたままになります。回避方法: 1. 切替キーで `WATCH` → `IDLE` に戻す 2. Herdr から指示を送る 3. エージェント開始時に自動で `WATCH` に戻ります。

## 開発

```bash
pnpm check
pnpm test
pnpm pack:check
PI_INPUT_LOCK=1 pi -ne -e . --tui-mode fullscreen
```

## ライセンス

MIT License.

本プロジェクトは `@inobit/pi-reader`（Copyright (c) 2026 inobit、MIT License）の一部を派生利用しています。
