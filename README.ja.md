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

既定の切替キーは `ctrl+alt+i` です。`~/.pi/agent/pi-input-lock.json` で設定できます。

| 設定 | 型 | 既定値 | 説明 |
| --- | --- | --- | --- |
| `toggleKey` | string | `ctrl+alt+i` | ロックを切り替えるキー。 |
| `allowToolExpandInWatch` | boolean | `false` | `WATCH` 中に設定済みの `app.tools.expand` アクションを許可。 |
| `unlockPolicy` | `agent-settled` \| `manual` | `agent-settled` | 完了時に自動解除するか、手動解除にするか。 |

推奨する設定の組み合わせ:

```json
{
  "toggleKey": "ctrl+alt+i",
  "allowToolExpandInWatch": true,
  "unlockPolicy": "manual"
}
```

設定はプロセスの存続中キャッシュされるため、変更後は Pi を再起動してください。

`~/.pi/agent/extensions/pi-input-lock/config.json` は従来の互換経路として
引き続き読み込みますが、正規のユーザー設定は `~/.pi/agent/pi-input-lock.json` です。
両方がある場合は正規の方が優先され、設定はマージされません。

`/input-lock` または `/lock` でも同じ操作ができます。

状態はライフサイクル連携用に次の三つを使います。

- `IDLE`: 入力可能。
- `WATCH`: 入力をロックし、ステータスバーに `🔒 WATCH` を表示。
- `OVERRIDE`: 実行中に手動切替で一時的に入力可能。

既定の `agent-settled` では、エージェント開始で `WATCH`、処理完了でどちらの実行中状態からも
`IDLE` に戻ります。`manual` では、処理完了後もエディターと入力途中のテキストを保持した
`WATCH` を続け、非実行中の切替で復元します。手動モードは起動時に強制されず、拡張は
常に `IDLE` から始まります。セッション境界やリセットイベントでは常に `IDLE` に戻り、
`WATCH` は維持されません。実行中だと明確に確認できない場合は安全のため `IDLE` として扱います。

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
