# @j1nn0/pi-input-lock

[English](./README.md) | **日本語**

Pi `fullscreen` 向け Vim 風リーディングモード：トグルキーで読み取り専用スクロール（`ctrl-u/d/f/b`、`gg/G`、`j/k`、`[q/a/t` セマンティックジャンプ、`{}` 段落、`/`・`n`/`N` 検索）。リーディングモードの切り替えや手動での展開/折りたたみでも読書位置を保持（prompt 番号アンカー）、終了時は `emacs` 編集を元のまま復元します。

> `@inobit/pi-reader` をベースにしています。

- **ワンキートグル**：`alt+o`（`TUI inputListener` でインターセプト、`extensions/pi-input-lock/config.json` の `toggleKey` で変更可能）→ `READING`。デフォルトではツール出力の状態はそのまま保持（`autoExpandTools: true` で切り替え時に自動展開/折りたたみを選択可能）
- **位置保持（アンカー）**：リーディングモードの出入りや手動展開/折りたたみ時に、ビューポートを読んでいた Q/A 付近に固定 — `OSC133` prompt 番号座標系にアンカー（展開/折りたたみでメッセージ境界は増減しないため番号は切り替えを跨いで厳密に安定）。折りたたみ後に内容が1画面に満たない場合は末尾に寄せつつ、アンカー行は画面内に留まります
- **ゼロ侵入編集**：`INSERT` 状態では完全パススルー、`READING` 状態でのみインターセプト。デフォルトで `ctrl+u = deleteToLineStart` もリグレッションなし
- **Pi スクロールの正確な再現**：`half = viewportHeight/2`、`page = viewportHeight-1`（`OVERLAP=1`）、`TuiAltScreen` と一致
- **セマンティックナビゲーション**：`[q/]q` 質問、`[a/]a` 回答、`[t/]t` ツール、`{`/`}` 段落、`/·n/N` 検索（`Enter` 後に Vim 風 `n`/`N`）
- **高信頼なイベントルーティング**：キーは `TUI inputListener` でインターセプト、リーディング状態ではキーを消費、`INSERT` ではパススルー。`ctx` は複数セッションイベントでリフレッシュされ、`resume` で古いセッションも正しく動作
- **ダイアログ共存**：リーディング中に拡張ダイアログ（例：権限確認）が表示された場合、トグルキー以外はすべて譲渡 — ダイアログは通常通り操作可能（方向キー/`Enter`/`Esc`、連鎖する理由入力も含む）。トグルキー自体はブロックされ、コンテナ再構築によるダイアログの promise 宙吊りを防止。`?` ヘルプが開いている場合は論理的に最前面として扱われ、`Esc` で閉じるまで全キーを消費し、その後ダイアログに制御が渡ります

## インストール

```bash
pi install npm:@j1nn0/pi-input-lock
```

ローカル開発（分離、`--no-extensions` でインストール済みの古いバージョンを除外）：

```bash
pi -ne -e . --tui-mode fullscreen
```

> スクロール可能なのは `fullscreen` のみ。`regular` では `scrollBy` にビューポートがなく、拡張は静かに無視します。

## キーバインド

| 役割 | キー | 備考 |
| --- | --- | --- |
| **リーディング切替** | `alt+o` / `/reader` / `/scroll`（トグル） | デフォルト `alt+o`、`config.json` の `toggleKey` で変更可能（例：`ctrl+o`）、`?` ポップアップで有効なキーを表示 |
| **終了** | `esc` / `i` / `ctrl+c` | リーディング状態で `esc`/`i`/`ctrl+c` で終了（`ctrl+c` は画面クリアなし）、`i` は入力に漏れません |
| **ヘルプ** | `?` | READING でのみ有効、英語のショートカット一覧を表示、`esc` で閉じる |
| **半ページ上 / 下** | `ctrl+u` / `ctrl+d` | `scrollBy(∓half)`；編集状態では `ctrl+u` は行頭まで削除；`count` 対応（例：`3 ctrl+u`） |
| **1ページ下 / 上** | `ctrl+f` / `ctrl+b` | `scrollBy(±page)`；`count` 対応 |
| **行下 / 上** | `j` / `k` + `ctrl+n` / `ctrl+p` | `scrollBy(±1)`；`count` 対応（例：`5j`） |
| **先頭** | `g g` | 300ms 以内の `g` 二回（同バッチの `gg` を含む）→ `scrollToTop()` |
| **末尾** | `G` (`shift+g`) | `scrollToBottom()`、出力に追従 |
| **前/次の質問** | `[q` / `]q` | `OSC133;A` prompt 行；`count` 対応（例：`3]q`）；`flash Question 2/5`；可視時は `keep` で動かさず |
| **前/次の回答** | `[a` / `]a` | prompt 直後の最初の非空行；`count` 対応 |
| **前/次のツール** | `[t` / `]t` | ヒューリスティック `▌/⎿/●` など；`count` 対応 |
| **前/次の段落** | `{` / `}` | 空行区切り；`count` 対応（例：`2}`） |
| **検索** | `/` 後に `n` / `N` | `/` で検索入力（拡張独自：`flash` でクエリと `n/m` のマッチ進捗をリアルタイム表示）；入力中はすべての印字可能キー（`j/k/n` を含む）がクエリの一部、`Enter` 確定後に `n` 次・`N` 前で循環 |
| **count プレフィックス** | `1-9`（`0` は buffer がある場合のみ） | 最大4桁、`800ms` タイムアウト、`j/k`・半ページ/1ページ・`[q/a/t`・`{}` に適用 |
| **ツール出力の展開/折りたたみ** | `app.tools.expand`（デフォルト `ctrl+o`、`keybindings.json` で変更可能、例：`alt+o`） | **編集状態と READING 状態の両方で有効**；READING 内では切替/終了/ヘルプより優先度が低い — `toggleKey` と同じキーにバインドしないでください |

## 設定

- リーディング切替：`extensions/pi-input-lock/config.json`
  ```json
  { "toggleKey": "alt+o", "autoExpandTools": false, "questionAnchor": "pinTop", "visibleBehavior": "keep", "wrapNavigation": false }
  ```
  `autoExpandTools`：`false`（デフォルト）でリーディングの出入り時にツール状態をそのまま保持 — この場合は位置が自然にロスレス。`true` で出入り時に自動展開/折りたたみ（位置はアンカーで補正）。その他：`questionAnchor`：`pinTop`（=1、デフォルト）| `third`（=floor(vh/3)）| `center`（=floor(vh/2)）| 数値；`visibleBehavior`：`keep`（デフォルト、対象が既に可視ならビューポートを動かさず flash のみ）| `reanchor`；`wrapNavigation`：端で折り返し。`?` ポップアップで有効なキーを表示します

## 動作

- **読み取り専用**：リーディング状態では印字可能キーを消費（`INSERT` はパススルー）、入力バーは左寄せ `◉ Reading`（枠線なし、元の位置を完全に覆う）に置換。元の入力は保持され、終了時に復元
- **アンカー**：セマンティックジャンプは `row - offset`（`questionAnchor` で決定）を `clamp` して `maxTop` に収め `disableFollow:true` で実行。可視かつ `keep` の場合はビューポートを動かさず `flash Question 2/5` のみ
- **インジケータ**：`?` で READING 中に英語ヘルプ（`Esc` で閉じる）を表示：中央に枠線（`╭─╮`）付きボックス、key/説明の2列を整列
- **count**：`1-9` を蓄積（`0` は既存 buffer がある場合のみ追加）、`800ms` で自動クリア。`[`/`]` は 500ms の leader ウィンドウ。`/` 検索は拡張内で完結（TUI overlay に触れない）ため `Enter`/`n`/`N` は入力フォーカスと競合しません
- **復元**：終了時に `gg`/count/bracket バッファをクリアし、入力を復元。`autoExpandTools: true` 時はツール状態も同時に折りたたみ（ツール展開/折りたたみは非同期で、最初のフレームをブロックしません）
- **位置保持**：モード切替/手動展開の前に同期的にアンカー（直近の prompt 番号 + セグメント内オフセット）をキャプチャし、レイアウトが落ち着いた後に統一された clamp モデルで復元（正確に復元 → セグメント内で切り詰め → 下側が不足する場合は末尾に寄せつつアンカーは画面内に残す）。復元モニタは tick ごとに `requestRender` を呼び出し（pi-tui はオンデマンド描画のため、アイドル時はフレームがゼロ — 能動的に進めないと安定性判定が永遠に成立しません）。末尾追従状態での切替は介入せず、ネイティブの follow-end に委譲します

## 互換性と制限

- **キープロトコル**：従来の制御シーケンスと `Kitty` プロトコルに対応。方向キーのパススルーは `CSI` (`\x1b[`) と application cursor keys の `SSU` (`\x1bO`) の両プレフィックスをカバー
- マウスホイール/トラックパッド、テキスト選択＋コピー、`ctrl+shift+f` 検索は fullscreen でもパススルー
- `regular` では `ScrollView` が存在しないため、ナビゲーションは静かに何もしません

## 開発

```bash
pnpm check
pnpm test
pnpm pack:check
pi -ne -e . --tui-mode fullscreen
```

## ライセンス

MIT
