# @j1nn0/pi-input-lock

Pi の対話入力を保護する手動ウォッチロック拡張です。ロック中は文字入力、送信、
アクションを消費しますが、CSI と SSU の方向キーはフォーカス中のコンポーネントへ
そのまま渡します。解除すると元のエディターと入力途中のテキストを復元します。

## インストール

```bash
pi install npm:@j1nn0/pi-input-lock
```

ローカル開発:

```bash
pi -ne -e . --tui-mode fullscreen
```

## 使い方

- `alt+o` でロックを切り替えます。
- `/input-lock` または `/lock` でも切り替えられます。
- `.pi/agent/extensions/pi-input-lock/config.json` でキーを設定できます。

```json
{ "toggleKey": "alt+o" }
```

状態は将来のライフサイクル連携に備えて `IDLE`、`WATCH`、`OVERRIDE` を使います。
入力を遮断するのは `WATCH` だけです。エージェントのライフサイクル連携は次の段階で
追加します。

## 開発

```bash
pnpm check
pnpm test
pnpm pack:check
```

## ライセンス

MIT
