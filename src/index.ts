/**
 * pi-input-lock — Vim 風リーディングモード拡張（旧 pi-reader ベース、fullscreen）
 *
 * アーキテクチャ：TUI inputListener + onTerminalInput 二重チャネル:
 *   - alt+o（config.json: toggleKey で変更可能）で READING に出入り、Promise で非同期にツール展開
 *   - ctrl-u/d 半ページ上/下   ctrl-f/b 1ページ上/下   j/k 行単位
 *   - g g 先頭（300ms、同バッチの gg を含む）  G 末尾
 *   - [q/]q 質問  [a/]a 回答  [t/]t ツール  {/} 段落  / n/N 検索
 *   - esc/i/c で READING 終了   ? ヘルプポップアップ（英語、Esc で閉じる）
 *   - 入力欄は READING 時に左側に ◉ Reading を表示して覆い、元の入力は保持
 *   - count プレフィックス 1-9 を蓄積（0 は既存 buffer がある場合のみ追加、800ms でクリア）、5j / 3]q が有効
 * ダイアログ譲渡（plan-dialog-interaction-fix）：外部コンポーネントがフォーカスを奪っている期間（拡張ダイアログ/ui.input など）、
 *   インターセプトされるのは toggle キーのみ（解放するとコンテナ再構築 + promise 宙吊りになるため）、それ以外は全てパススルー；
 *   検出はキーごとのリアルタイムなフォーカス比較 focusedComponent ≠ reader エディタ（自前のヘルプ/検索コンポーネントは除外）
 * 検索ステートマシン（4つの目標を満たす）：
 *   READING --"/"--> SEARCH_INPUT --enter--> SEARCH_NAV --esc--> READING
 *   READING --"/"--> SEARCH_INPUT --esc--> READING（ハイライト解除）
 *   SEARCH_NAV --esc--> READING（検索バー close+ハイライト解除）
 *   READING（検索なし） --esc--> INSERT（リーディング終了）
 */
import { CustomEditor, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, stripTerminalSequences, truncateToWidth, visibleWidth, type TUI } from "@earendil-works/pi-tui";

// ---------- 純粋ロジック（単体テスト可能） ----------

/** ビューポート半ページスクロール量（TuiAltScreen と一致：floor(vh/2)） */
export function halfPage(vh: number): number {
  return Math.max(1, Math.floor(vh / 2));
}
/** ビューポート1ページスクロール量（TuiAltScreen OVERLAP=1 と一致：vh-1） */
export function pageStep(vh: number): number {
  return Math.max(1, vh - 1);
}

export type ReadingKey =
  | "toggle" | "halfUp" | "halfDown" | "pageUp" | "pageDown"
  | "lineUp" | "lineDown" | "top" | "bottom" | "exit" | "help" | "other";

// ---------- アンカーと可視性（単体テスト可能） ----------

export type Anchor = "pinTop" | "third" | "center" | number;
export type VisibleBehavior = "keep" | "reanchor";
export interface NavConfig {
  questionAnchor?: Anchor;
  visibleBehavior?: VisibleBehavior;
  wrapNavigation?: boolean;
  /** リーディングモード切替時にツール出力を自動展開/折りたたむか（plan §9.1）；未設定時のデフォルトは true */
  autoExpandTools?: boolean;
}

/** アンカーオフセットを計算 */
export function getAnchorOffset(vh: number, anchor: Anchor): number {
  if (typeof anchor === "number") return Math.max(0, Math.min(Math.floor(anchor), Math.max(0, vh - 1)));
  if (anchor === "pinTop") return 1;
  if (anchor === "third") return Math.max(0, Math.floor(vh / 3));
  if (anchor === "center") return Math.max(0, Math.floor(vh / 2));
  return 1;
}

/** 行が可視か判定（上下2行のマージンを残し、底に張り付くのを防ぐ） */
export function isRowVisible(row: number, scrollTop: number, vh: number): boolean {
  if (vh <= 0) return false;
  const visibleTop = scrollTop;
  const visibleBottom = scrollTop + vh - 1;
  // 底の2行は不可視とみなし、ユーザーがコンテキストを見やすくする
  return row >= visibleTop && row <= visibleBottom - 2;
}

/**
 * 目標スクロール位置を計算
 * @returns null は可視かつ keep 戦略時にビューポートを動かさないことを示す；そうでなければ clamp 後の scrollTop を返す
 */
export function computeTargetScrollTop(
  targetRow: number,
  scrollTop: number,
  vh: number,
  maxTop: number,
  anchor: Anchor,
  visibleBehavior: VisibleBehavior = "keep",
): number | null {
  if (isRowVisible(targetRow, scrollTop, vh) && visibleBehavior === "keep") return null;
  const offset = getAnchorOffset(vh, anchor);
  const desired = targetRow - offset;
  return Math.max(0, Math.min(desired, Math.max(0, maxTop)));
}

// ---------- 検索ステートマシン（単体テスト可能） ----------
export enum SearchMode {
  INACTIVE = 0, // 検索なし
  INPUT = 1,    // / が押下され、enter まで全入力を受信
  NAV = 2,      // 送信済み、n/N でナビゲーション、? ショートカットのみ受け付ける
}
export function isEnterKey(d: string): boolean {
  if (d === "\r" || d === "\n" || d === "\x0d" || d === "\x0a") return true;
  if (d.includes("\r") || d.includes("\n")) return true;
  try { if (matchesKey(d, "enter")) return true; } catch {}
  try { if (matchesKey(d, Key.enter)) return true; } catch {}
  if (/^\x1b\[13(;.*)?u$/.test(d)) return true;
  return false;
}
export function isEscKey(d: string): boolean {
  if (d === "\x1b" || d === "\x1b[27u") return true;
  if (d.startsWith("\x1b[27")) return true;
  try { if (matchesKey(d, "escape")) return true; } catch {}
  try { if (matchesKey(d, Key.escape)) return true; } catch {}
  // \x1b 単バイト esc は parseReadingKey で個別に処理済み、isEscKey は alt+o の誤判定を厳密に避ける必要がある
  if (d === "\x1b") return true;
  return false;
}

// ---------- キールーティング（二重チャネル共有コア、依存性注入で単体テスト可能；plan-dialog-interaction-fix §4.1.2 参照） ----------

/** TUI がネイティブ検索状態にあるか判定（activeSearch が存在すれば検索バーありとみなす） */
export function hasActiveSearch(tui: any): boolean {
  try { return !!(tui as any)?.activeSearch; } catch { return false; }
}

/** reader 所有のコンポーネント参照集合（フォーカス除外用） */
export interface OwnFocusRefs {
  /** reader が自前で作成した最新のエディタインスタンス（ScrollReaderEditor / ReadonlyEditor） */
  editor?: unknown;
  /** ヘルプ overlay コンポーネント参照 */
  help?: unknown;
  /** ネイティブ検索入力コンポーネント（activeSearch.component） */
  searchComponent?: unknown;
}

/**
 * ダイアログフォーカス奪取判定本体（純粋関数、単体テスト可能）：フォーカスが非 reader コンポーネントに保持されている場合に真。
 * 三重除外：reader エディタ、自前のヘルプ overlay、ネイティブ検索入力コンポーネント ——
 * 「overlay.hide が同期的に preFocus を復元する」という暗黙のタイミングに依存しない。
 */
export function isForeignFocus(focus: unknown, own: OwnFocusRefs): boolean {
  if (!focus) return false;
  if (focus === own.editor) return false;
  if (focus === own.help) return false;
  if (focus === own.searchComponent) return false;
  return true;
}

/** inputListener / onTerminalInput の戻り値 */
export type RouteResult = { consume: true } | undefined;

/** 二重チャネル共有キールーティングの依存性注入インターフェース：listener は薄い配線のみ、ルーティングロジックは独立して単体テスト可能 */
export interface ReadingRouterIO {
  /** READING 状態にあるか */
  isReading(): boolean;
  /** 検索ステートマシンの現在値 */
  searchMode(): SearchMode;
  /** ヘルプポップアップが開いているか */
  helpOpen(): boolean;
  /** 外部コンポーネントのフォーカス奪取検出（拡張ダイアログ/ui.input など全ての奪取シーン）；真の場合はチャネル1の toggle 以外は全てパススルー */
  dialogOpen(): boolean;
  /** 現在の TUI 参照 */
  getTui(): any;
  /** 二重チャネルの重複排除（terminal が極短時間内に重複配信するのを抑制） */
  isDuplicateNav(data: string, source: "input" | "terminal"): boolean;
  /** 検索入力処理（INPUT 状態で enter/esc まで全て受信）；undefined を返せば未消費 */
  handleSearchInput(data: string, tui: any, source: "input" | "terminal"): boolean | undefined;
  /** esc の二義性処理：検索バーがあれば検索を閉じてハイライト解除、なければリーディングを終了 */
  handleEsc(tui: any): void;
  /** 検索バーをクリアしてハイライト解除、ステートマシンをリセット、READING に留まる */
  closeSearch(tui: any): void;
  /** リーディングモード切替 */
  toggle(): void;
  /** ヘルプポップアップを開く */
  showHelp(): void;
  /** ヘルプ overlay を閉じる（done→hideOverlay；ダイアログがフォーカスを保持している場合は奪わない） */
  closeHelp(): void;
  /** app.tools.expand キーバインド一致 */
  matchesExpand(data: string): boolean;
  /** ツール展開切替（app.tools.expand ヒット時に呼び出し、アンカー保持付き） */
  toggleToolsExpanded(): void;
  /** セマンティックナビゲーション（/ n N {} と [q/a/t シーケンス）；true を返せば消費済み */
  trySemanticNav(data: string, tui: any): boolean;
  /** ビューポート高さ取得（例外時は 20 でフォールバック） */
  getViewportHeight(tui: any): number;
  /** gg ダブルクリック判定 */
  ggPress(): boolean;
  ggReset(): void;
  countPeek(): number | undefined;
  countReset(): void;
  /** count buffer と [ ] シーケンスバッファをリセット（パススルー前に残留修飾状態をクリア） */
  resetModifiers(): void;
  /** 前回のセマンティックジャンプ先を記録 */
  updateLastSemantic(row: number): void;
  requestRender(tui: any): void;
}

/**
 * 二重チャネル共有のキールーティングを作成（TUI inputListener = "input"、onTerminalInput = "terminal"）。
 *
 * 階層セマンティクス（plan §5）：
 * - 外部ダイアログがフォーカスを奪っている期間：インターセプトされるのは toggle のみ — それは「レイヤー」自体を直接操作する唯一のキーであり、
 *   解放するとエディタコンテナが再構築されダイアログの promise が永久に宙吊りになる（Bug B）；他のキーは全てパススルー；
 * - チャネル2の toggle/help はチャネル1に譲渡して一元処理し、二重チャネルの重複を避ける；
 * - READING 内の優先度：SEARCH_INPUT > toggle > help > exit > expand > セマンティックナビゲーション > スクロール。
 */
export function createReadingKeyRouter(io: ReadingRouterIO, source: "input" | "terminal"): (data: string) => RouteResult {
  return (data: string): RouteResult => {
    const tui = io.getTui();
    const reading = io.isReading();

    // ─── 外部ダイアログ/ヘルプ共存時のキー掌握（設計制約、セマンティクスを変更しないこと）─────
    //
    // ディスパッチモデル：pi-tui はまず TUI レベルの inputListeners を順に実行（本関数もその一つ）、
    // いずれかが consume すればディスパッチを終了；全てが解放して初めて focusedComponent.handleInput の番になる。
    // すなわち本関数はフォーカスコンポーネント（ダイアログ）の「上流の必須経路」に位置し、consume = キーは永遠に消失、
    // 解放 = 下流のフォーカスウィンドウへ流れ続ける。コアはダイアログ出現時に setFocus(ダイアログ) する、
    // ヘルプ overlay は視覚的に上層に残留するだけで既にフォーカスを失っている — 「論理的なスタックトップ」は本ルーティングの判定で模擬する。
    //
    // 三状態の決定表：
    //   ① help が開いており && フォーカスが外部に奪われている：UI 最上層はヘルプ → 論理的にも最前面に —
    //      esc でヘルプを閉じる（closeHelp は overlay hide を経由、自身がフォーカスを保持している場合のみフォーカスを復元、
    //      故ダイアログのフォーカスを奪わない）、他のキーは一律で受け止めて消費（ヘルプの通常状態「esc のみ認識」と一致、
    //      見えないダイアログへは漏らさず、誤った terminate を防止）；閉じた後は状態②へ落ちる
    //   ② 外部ダイアログのみがフォーカスを奪っている：toggle のみを消費 — それは「レイヤー」自体を直接操作する唯一のキーであり、
    //      解放するとコアの setCustomEditorComponent が無条件に editorContainer.clear() を発火し、
    //      ダイアログの promise が永久に宙吊りになる（Bug B）；その他は全てダイアログの通常操作のために解放（Bug A 修正）
    //   ③ どちらでもない：下方の通常リーディングルーティングへ落ちる
    // 検出はキーごとのリアルタイムなフォーカス比較（スナップショットではない）、連鎖ダイアログ select→input のコンポーネント切替も感知可能。
    if (io.dialogOpen()) {
      if (source === "terminal") {
        if (io.helpOpen()) {
          if (isEscKey(data) || data === "\x1b") {
            io.closeHelp();
            io.requestRender(tui);
          }
          // esc でヘルプを閉じる；他のキーは一律で受け止めてパススルーしない（UI とロジックをヘルプ層で統一）
          return { consume: true };
        }
        if (parseReadingKey(data) === "toggle") {
          return { consume: true };
        }
      }
      return undefined;
    }

    // ヘルプ overlay が開いている（外部ダイアログなし）：両チャネルとも早期リターン（フォーカスが overlay 上にあり、自ら入力を受け取る）
    if (io.helpOpen()) return undefined;

    const key = parseReadingKey(data);

    // チャネル1：toggle でリーディングモード切替（SEARCH_INPUT の前に配置、元の優先度を維持）
    if (source === "terminal" && key === "toggle") {
      io.toggle();
      io.requestRender(tui);
      return { consume: true };
    }

    // SEARCH_INPUT：enter まで全入力を受信（最優先、?/i/toggle などもテキストとして扱う）
    if (reading && io.searchMode() === SearchMode.INPUT) {
      const r = io.handleSearchInput(data, tui, source);
      if (r !== undefined) {
        io.requestRender(tui);
        return { consume: true };
      }
      return undefined;
    }

    // チャネル2：toggle/help は依然としてチャネル1で一元処理し、二重チャネルの重複を避ける
    if (source === "input" && (key === "toggle" || key === "help")) return undefined;

    // チャネル1：非リーディング状態では上方で処理済みの toggle のみを気にする
    if (source === "terminal" && !reading) return undefined;

    // チャネル1：? でヘルプを開く
    if (key === "help") {
      io.showHelp();
      io.requestRender(tui);
      return { consume: true };
    }

    // exit (esc/i/ctrl+c)：esc の二義性は handleEsc で一元処理 — 検索があればまず検索を閉じ、なければリーディングを終了
    if (key === "exit") {
      if (!reading) return undefined;
      if (isEscKey(data) || data === "\x1b") {
        io.handleEsc(tui);
        io.requestRender(tui);
        return { consume: true };
      }
      // i / ctrl+c：検索があればまず検索をクリア（READING に留まる）、検索がなければ終了
      if (io.searchMode() !== SearchMode.INACTIVE || hasActiveSearch(tui)) {
        io.closeSearch(tui);
        io.requestRender(tui);
        return { consume: true };
      }
      io.toggle();
      io.requestRender(tui);
      return { consume: true };
    }

    if (!reading) return undefined;

    // app.tools.expand（明示的にバインドされたキーは固定ホワイトリストのセマンティックナビゲーションより優先、plan §9.2）
    try {
      if (io.matchesExpand(data)) {
        if (io.isDuplicateNav(data, source)) return { consume: true };
        io.toggleToolsExpanded();
        io.requestRender(tui);
        return { consume: true };
      }
    } catch { /* キーバインド表が利用不可なら無視 */ }

    // 二重チャネルの重複排除：同一キーが極短時間内に重複して到達した場合は一度だけ処理
    if (io.isDuplicateNav(data, source)) return { consume: true };

    // セマンティックナビゲーション：/ n N {} と [q/a/t シーケンス
    if (io.trySemanticNav(data, tui)) {
      io.requestRender(tui);
      return { consume: true };
    }

    // スクロールナビゲーション
    const vh = Math.max(1, io.getViewportHeight(tui));
    const half = halfPage(vh);
    const page = pageStep(vh);
    const lineCnt = io.countPeek() ?? 1;
    switch (key) {
      case "halfUp": tui?.scrollBy?.(-half * lineCnt); io.countReset(); break;
      case "halfDown": tui?.scrollBy?.(half * lineCnt); io.countReset(); break;
      case "pageDown": tui?.scrollBy?.(page * lineCnt); io.countReset(); break;
      case "pageUp": tui?.scrollBy?.(-page * lineCnt); io.countReset(); break;
      case "lineUp": tui?.scrollBy?.(-lineCnt); io.countReset(); break;
      case "lineDown": tui?.scrollBy?.(lineCnt); io.countReset(); break;
      case "bottom": tui?.scrollToBottom?.(); io.countReset(); break;
      case "top":
        if (data === "gg") {
          io.ggReset();
          tui?.scrollToTop?.();
          io.countReset();
          io.updateLastSemantic(0);
        } else if (io.ggPress()) {
          tui?.scrollToTop?.();
          io.countReset();
          io.updateLastSemantic(0);
        } else {
          // 最初の g：ウィンドウ内で2回目の g を待機
          return { consume: true };
        }
        break;
      case "other":
        if (source === "terminal") {
          // 複数バイトの CSI/SSU シーケンス（application cursor keys \x1bO… を含む、§3.3）をフォーカスコンポーネントへパススルー。
          // 注：ここでは修飾バッファをクリアしない（input チャネルと非対称）— 同一キーはその後必ず input チャネルに到達するため、
          // 由其 CSI/SSU 透传分支统一 countReset+resetModifiers，净效果一致
          if (data.length > 1 && (data.startsWith("\x1b[") || data.startsWith("\x1bO"))) return undefined;
        } else {
          // 单字节（含数字与不可打印控制符）一律消费，避免泄漏进核心编辑器
          if (isPrintable(data) || data.length === 1) return { consume: true };
          // 多字节非 CSI/SSU 序列消费；CSI/SSU 透传
          if (!(data.startsWith("\x1b[") || data.startsWith("\x1bO"))) return { consume: true };
          io.countReset();
          io.resetModifiers();
          return undefined;
        }
        break;
      default:
        return undefined;
    }
    io.requestRender(tui);
    return { consume: true };
  };
}

// ---------- 行扫描（可单测） ----------

const OSC133_PROMPT_START = /^\x1b\]133;A(?:\x07|\x1b\\)/;
const OSC133_ZONE_PREFIX = /^(?:\x1b\]133;[ABC](?:\x07|\x1b\\))+/;
const TOOL_MARKERS = ["▌", "⎿", "●", "○", "◐", "◑", "◒", "◓", "│", "├", "└"];

function isBlankLine(line: string): boolean {
  return stripTerminalSequences(line ?? "").trim() === "";
}

/** 段落边界：空行或分隔线（─/—/—/━/─）或 OSC133 区域前缀，需视为段落分隔 */
export function isParagraphBoundary(line: string): boolean {
  const raw = line ?? "";
  // OSC133 区域标记本身视为边界（由 paintBox 剥离，但 scrollContentLines 仍保留）
  if (OSC133_ZONE_PREFIX.test(raw)) return true;
  const stripped = stripTerminalSequences(raw).trim();
  if (stripped === "") return true;
  if (/^[-─—═━\s]+$/.test(stripped)) return true;
  return false;
}

function isToolLine(strippedTrim: string): boolean {
  if (!strippedTrim) return false;
  if (TOOL_MARKERS.some((m) => strippedTrim.startsWith(m))) return true;
  if (/^(bash|read|edit|write|grep|find|ls|todo)\b/i.test(strippedTrim)) return true;
  return false;
}

/** 扫描 prompt 行（OSC133;A） */
export function findPromptRows(lines: string[]): number[] {
  const out: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (OSC133_PROMPT_START.test(lines[i] ?? "")) out.push(i);
  }
  return out;
}

/** 启发式扫描工具行 */
export function findToolRows(lines: string[]): number[] {
  const out: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    const stripped = stripTerminalSequences(lines[i] ?? "").trim();
    if (isToolLine(stripped)) out.push(i);
  }
  return out;
}

/** 回答行：每个 prompt 后的首个非空行 */
export function findAnswerRows(lines: string[]): number[] {
  const promptRows = findPromptRows(lines);
  if (promptRows.length === 0) return [];
  const res: number[] = [];
  for (const pr of promptRows) {
    let r = pr + 1;
    while (r < lines.length && isBlankLine(lines[r] ?? "")) r++;
    // 跳过可能紧跟的 133;B 结束标记行（同样含 OSC133 但非 A）
    while (r < lines.length && /^\x1b\]133;/.test(lines[r] ?? "")) {
      r++;
      while (r < lines.length && isBlankLine(lines[r] ?? "")) r++;
    }
    if (r < lines.length) res.push(r);
  }
  // 去重且保持递增
  return [...new Set(res)].sort((a, b) => a - b);
}

/**
 * 段落边界：空行/分隔线分隔
 * dir 1 找下一个段落首行，-1 找上一个段落首行
 */
export function findParagraphBounds(lines: string[], from: number, dir: -1 | 1): number | null {
  const n = lines.length;
  if (n === 0) return null;
  const isBoundary = (idx: number) => isParagraphBoundary(lines[idx] ?? "");
  const isContent = (idx: number) => !isBoundary(idx);
  if (dir === 1) {
    let i = from + 1;
    // 跳过当前段落剩余内容（若 from+1 仍在同段）
    while (i < n && isContent(i)) i++;
    // 跳过段落间边界
    while (i < n && isBoundary(i)) i++;
    if (i < n && isContent(i)) return i;
    return null;
  } else {
    // 往前找：先找到 from 所在段的段首，再往前找上一段
    let probe = from;
    // 若 from 在边界，先回退到内容
    while (probe >= 0 && isBoundary(probe)) probe--;
    if (probe < 0) return null;
    // 找到当前段首
    let curStart = probe;
    while (curStart >= 0 && isContent(curStart)) curStart--;
    curStart++;
    // 若 from 不在段首，上一段即 curStart 之前的段
    // 若 from 已在段首，需再往前一段
    let i = curStart - 1;
    while (i >= 0 && isBoundary(i)) i--;
    if (i < 0) return null;
    // i 在上一段内容中，找其段首
    let prevStart = i;
    while (prevStart >= 0 && isContent(prevStart)) prevStart--;
    prevStart++;
    while (prevStart < n && isBoundary(prevStart)) prevStart++;
    if (prevStart < n && isContent(prevStart)) return prevStart;
    return null;
  }
}

// ---------- ビューポート状態（単体テスト可能、try/catch によるフォールバックが必要） ----------

export interface ViewportState {
  scrollView: any | null;
  lines: string[] | null;
  scrollTop: number;
  vh: number;
  maxTop: number;
  contentHeight: number;
}

/** ビューポート状態を読み取り、try/catch の外側で regular 環境ではサイレントに保証 */
export function getViewportState(tui: any): ViewportState {
  try {
    const sv: any = tui?.currentLayout?.primaryScrollView ?? tui?.getPrimaryScrollView?.() ?? null;
    const vh: number = sv?.viewportHeight ?? tui?.getPrimaryScrollView?.()?.viewportHeight ?? 20;
    const scrollTop: number = sv?.scrollTop ?? tui?.viewportTop ?? 0;
    let lines: string[] | null = null;
    let contentHeight = 0;
    try {
      const layout: any = tui?.currentLayout;
      if (layout && sv) {
        // 复用 pi-tui 的 getScrollViewBox 逻辑：遍历 frame.root 树找 scrollView 对应的 box
        const findBox = (box: any): any | null => {
          if (!box) return null;
          if (box.scrollView === sv && box.scrollContentLines) return box;
          const children: any[] = box.children ?? [];
          for (const ch of children) {
            const found = findBox(ch);
            if (found) return found;
          }
          return null;
        };
        // frame.root 是根 box，若直接是 scrollView box 也处理
        let box: any = null;
        try {
          box = findBox(layout.root ?? layout);
          // 兜底：若 root 本身无 children，尝试 layout 本身的 scrollContentLines
          if (!box && layout.scrollContentLines) box = layout;
          // 兜底：遍历 layout 顶层属性找含 scrollContentLines 的对象
          if (!box) {
            for (const k of Object.keys(layout)) {
              const v: any = layout[k];
              if (v?.scrollContentLines && Array.isArray(v.scrollContentLines)) { box = v; break; }
            }
          }
        } catch {}
        if (box?.scrollContentLines) {
          lines = box.scrollContentLines as string[];
          contentHeight = lines.length;
        }
      }
      if (!lines) {
        const alt: any = sv?.scrollContentLines ?? tui?.scrollContentLines ?? null;
        if (Array.isArray(alt)) {
          lines = alt;
          contentHeight = lines.length;
        }
      }
    } catch {}
    if (!lines) {
      // 最后兜底：lines 为空时 contentHeight 用 vh 估算，maxTop 0
      contentHeight = Math.max(scrollTop + vh, vh);
    }
    const maxTop = Math.max(0, contentHeight - vh);
    return { scrollView: sv, lines, scrollTop, vh: Math.max(1, vh), maxTop, contentHeight };
  } catch {
    return { scrollView: null, lines: null, scrollTop: 0, vh: 20, maxTop: 0, contentHeight: 20 };
  }
}

/** アンカースクロール：ターゲットを計算して scrollTo し、スクロールしたかを返す */
export function scrollToAnchor(tui: any, targetRow: number, anchor: Anchor, visibleBehavior: VisibleBehavior = "keep"): boolean {
  const vs = getViewportState(tui);
  if (!vs.scrollView) return false;
  const computed = computeTargetScrollTop(targetRow, vs.scrollTop, vs.vh, vs.maxTop, anchor, visibleBehavior);
  if (computed === null) return false;
  try {
    vs.scrollView.scrollTo(computed, { disableFollow: true });
    tui?.requestRender?.();
    return true;
  } catch { return false; }
}

// ---------- スクロール锚点（模式切换保位，可单测；设计见 plan.md §4/§5） ----------

/** スクロール锚点：prompt 序号坐标系。展开/收起只改段内行数、不增删消息边界，k 跨切换严格稳定 */
export interface ScrollAnchor {
  /** ビューポート先頭行の直上にある直近の prompt 番号（findPromptRows のインデックス）；-1 は最初の prompt より前のヘッダー領域を示す */
  k: number;
  /** ビューポート先頭行から当該アンカーまでの行オフセット（セグメント内オフセット；k=-1 のときはドキュメント先頭からの距離） */
  d: number;
  /** 全文 prompt 总数，恢复时 O(1) 校验聊天树かどうか重建 */
  count: number;
}

/**
 * スクロールアンカーをキャプチャ：ビューポート先頭行の直近の prompt 境界に対する位置を記録。
 * @param lines 完整拍平内容行（getViewportState().lines）
 * @param scrollTop ビューポート顶行的绝对行号
 * @returns 行数组为空或全文无 prompt 时返す null（无法建立锚点）
 */
export function captureAnchor(lines: string[] | null, scrollTop: number): ScrollAnchor | null {
  if (!lines || lines.length === 0) return null;
  if (!Number.isFinite(scrollTop) || scrollTop < 0) return null;
  const promptRows = findPromptRows(lines);
  if (promptRows.length === 0) return null;
  // 二分找 ≤ scrollTop 的最后一个 prompt
  let lo = 0;
  let hi = promptRows.length - 1;
  let idx = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if ((promptRows[mid] ?? 0) <= scrollTop) { idx = mid; lo = mid + 1; } else { hi = mid - 1; }
  }
  if (idx < 0) return { k: -1, d: Math.trunc(scrollTop), count: promptRows.length };
  return { k: idx, d: scrollTop - (promptRows[idx] ?? 0), count: promptRows.length };
}

/**
 * 計算恢复目标行（统一 clamp 模型：scrollTop' = clamp(base + d', 0, maxTop)，见 plan §5）。
 *
 * 先做 O(1) 结构校验：prompt 总数与キャプチャ时不一致说明聊天树已重建，放弃恢复。
 * d 截断顺序：先夹进所在段（不超过下个 prompt），再整体夹进 [0, maxTop]——
 * 保证目标要么精确还原、要么落在同一问答边界内、要么贴底且仍在屏内。
 *
 * @param newLines 变更后的完整内容行
 * @param anchor 之前 captureAnchor 的产物
 * @param vh ビューポート高度（計算 maxTop 用）
 * @returns null 表示放弃恢复（结构变化或输入无效）；否则为绝对目标行号
 */
export function computeRestoreRow(newLines: string[] | null, anchor: ScrollAnchor, vh: number): number | null {
  if (!newLines || newLines.length === 0 || !anchor) return null;
  if (!Number.isFinite(vh) || vh < 1) return null;
  const promptRows = findPromptRows(newLines);
  if (promptRows.length !== anchor.count) return null;
  const maxTop = Math.max(0, newLines.length - Math.floor(vh));
  let base: number;
  let segEnd: number; // 所在段的结束界（不含）
  if (anchor.k < 0) {
    base = 0;
    segEnd = promptRows[0] ?? newLines.length;
  } else {
    const row = promptRows[anchor.k];
    if (row === undefined) return null;
    base = row;
    const next = promptRows[anchor.k + 1];
    segEnd = next === undefined ? newLines.length : next;
  }
  const dClamped = Math.min(Math.max(0, anchor.d), Math.max(0, segEnd - 1 - base));
  return Math.max(0, Math.min(base + dClamped, maxTop));
}

export interface ScrollRestoreMonitorOptions {
  /** 发起时的代际号；轮询期间不一致说明有新的高度变更动作，立即放弃 */
  generation: number;
  /** 当前代际号読み取り器 */
  getGeneration: () => number;
  /** 当前帧对象読み取り器（currentLayout 引用，换代即证明发生重排） */
  getFrame: () => unknown;
  /** 当前内容高度読み取り器 */
  getContentHeight: () => number;
  /** 布局稳定后的恢复回调（至多触发一次） */
  onRestore: () => void;
  /** 每次 tick 前主动请求一次渲染：pi-tui 按需渲染，空闲时零帧，
   *  不主动推进则“两个新帧”判据可能永远不满足（冒烟实测缺陷） */
  requestRender?: () => void;
  /** 轮询间隔 ms，默认 16 */
  intervalMs?: number;
  /** 最大轮询次数，默认 20，超限放弃 */
  maxTicks?: number;
}

/**
 * 恢复监视器：等布局稳定后执行一次恢复回调（plan §6 步骤③）。
 * 三重条件：generation 未变、currentLayout 帧代际变化、contentHeight 连续两个新帧相同。
 * 轮询默认 16ms/tick、上限 20 次，超限静默放弃（与包内フォールバック策略一致）。
 */
export class ScrollRestoreMonitor {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private ticks = 0;
  private prevFrame: unknown;
  private seenNewFrame = false;
  private lastHeight: number | null = null;
  private finished = false;

  constructor(private readonly o: ScrollRestoreMonitorOptions) {}

  /** 启动轮询；已启动/已完成时无效果 */
  start(): void {
    if (this.finished || this.timer !== undefined) return;
    this.prevFrame = this.safe(this.o.getFrame);
    this.schedule();
  }

  /** 中止轮询（含未决 timer） */
  stop(): void {
    this.finished = true;
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
  }

  private schedule(): void {
    if (this.finished) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.tick();
    }, this.o.intervalMs ?? 16);
  }

  private tick(): void {
    if (this.finished) return;
    try {
      if (this.o.getGeneration() !== this.o.generation) {
        this.stop();
        return;
      }
      try { this.o.requestRender?.(); } catch {}
      const frame = this.safe(this.o.getFrame);
      if (frame !== this.prevFrame) {
        const h = this.safe(this.o.getContentHeight);
        // 需要两个“不同帧”采样到相同高度才算稳定；采样失败（null）视为不稳定
        if (this.seenNewFrame && h !== null && h === this.lastHeight) {
          this.finished = true;
          this.stop();
          this.o.onRestore();
          return;
        }
        this.seenNewFrame = true;
        this.lastHeight = h;
      }
      this.prevFrame = frame;
    } catch { /* 防御：单次轮询异常不中断 */ }
    this.ticks += 1;
    if (this.ticks >= (this.o.maxTicks ?? 20)) {
      this.stop();
      return;
    }
    this.schedule();
  }

  private safe<T>(fn: () => T): T | null {
    try { return fn(); } catch { return null; }
  }
}

// ---------- toggleKey / NavConfig 缓存（启动时加载，修改后需 reload / 重启 pi 生效，无 TTL） ----------
let cachedToggleKeyRaw: string | undefined;
let hasToggleKeyCache = false;

let cachedNavConfig: NavConfig | undefined;
let hasNavCache = false;

function readConfigJson(): any {
  try {
    const fs: any = (globalThis as any).require?.("fs") ?? (globalThis as any).process?.getBuiltinModule?.("fs");
    if (!fs) return undefined;
    try {
      // jiti 会把模块编译为 base64 data:URL（import.meta.url 拿不到文件路径），
      // 但 CJS 包装作用域注入了 __dirname（实测可用）；从 src/ 加载时取父级即包目录
      let baseDir = "";
      try {
        baseDir = (typeof __dirname !== "undefined" && __dirname) ? __dirname : "";
      } catch {}
      const path: any = (globalThis as any).require?.("path") ?? (globalThis as any).process?.getBuiltinModule?.("path");
      const candidates = [
        baseDir ? path?.join?.(baseDir, "..", "config.json") : "",
        baseDir ? path?.join?.(baseDir, "config.json") : "",
      ];
      for (const cfg of candidates) {
        if (cfg && fs?.existsSync?.(cfg)) {
          return JSON.parse(fs.readFileSync(cfg, "utf8"));
        }
      }
    } catch {}
    const path: any = (globalThis as any).require?.("path") ?? (globalThis as any).process?.getBuiltinModule?.("path");
    const os: any = (globalThis as any).require?.("os") ?? (globalThis as any).process?.getBuiltinModule?.("os");
    const home: string = os?.homedir?.() ?? (process as any).env?.HOME ?? "";
    const extCfg = path?.join?.(home, ".pi", "agent", "extensions", "pi-reader", "config.json");
    if (extCfg && fs?.existsSync?.(extCfg)) {
      return JSON.parse(fs.readFileSync(extCfg, "utf8"));
    }
  } catch {}
  return undefined;
}

function readToggleKeyRaw(): string | undefined {
  const j = readConfigJson();
  if (j?.toggleKey) return String(j.toggleKey);
  return undefined;
}

function getToggleKeyRawCached(): string | undefined {
  if (hasToggleKeyCache) return cachedToggleKeyRaw;
  cachedToggleKeyRaw = readToggleKeyRaw();
  hasToggleKeyCache = true;
  return cachedToggleKeyRaw;
}

function getToggleKeyNormalized(): string {
  if ((process as any).env?.VITEST) return "alt+o";
  const raw = getToggleKeyRawCached();
  return raw ? raw.toLowerCase() : "alt+o";
}

function readNavConfigRaw(): NavConfig {
  if ((process as any).env?.VITEST) return {};
  const j = readConfigJson();
  if (!j) return {};
  const out: NavConfig = {};
  if (j.questionAnchor !== undefined) out.questionAnchor = j.questionAnchor as Anchor;
  if (j.visibleBehavior !== undefined) out.visibleBehavior = j.visibleBehavior as VisibleBehavior;
  if (j.wrapNavigation !== undefined) out.wrapNavigation = Boolean(j.wrapNavigation);
  if (j.autoExpandTools !== undefined) out.autoExpandTools = Boolean(j.autoExpandTools);
  return out;
}

export function getNavConfigCached(): NavConfig {
  if (hasNavCache) return cachedNavConfig ?? {};
  cachedNavConfig = readNavConfigRaw();
  hasNavCache = true;
  return cachedNavConfig ?? {};
}

/**
 * 需求 A：模式切换时かどうか自动展开/收拢工具输出（plan §9.1）。
 * 默认 false：保持工具状态不动，进出阅读位置天然无损；true 为显式选择，
 * 展开动作走锚点包装补偿位置。VITEST 空配置同样走此兑底，防测试基线漂移。
 */
export function isAutoExpandToolsEnabled(): boolean {
  const v = getNavConfigCached().autoExpandTools;
  return v === undefined ? false : v;
}

export function __resetNavConfigCacheForTest(): void {
  hasNavCache = false;
  cachedNavConfig = undefined;
  hasToggleKeyCache = false;
  cachedToggleKeyRaw = undefined;
}

/**
 * 归并终端原始键序列到阅读语义。兼容传统控制符（\x0f 等）与 Kitty 协议序列
 * （\x1b[<char>;5u）。"top" 由 g/g 及同批连发的 "gg" 触发，双击时序由
 * 调用方用 GgSequence 判定（"gg" 同块到达即视为双击命中）。
 */
export function parseReadingKey(d: string): ReadingKey {
  // 默认 alt+o，仅生效用户配置的那个；测试环境固定 alt+o
  const isToggle = (() => {
    try {
      if ((process as any).env?.VITEST) return d === "\x1bo" || d === "\u001b[111;3u";
      const active = getToggleKeyNormalized();
      const ctrlO = d === "\x0f" || d === "\u001b[111;5u" || d === "\x1b\x0f";
      const altO = d === "\x1bo" || d === "\u001b[111;3u";
      if (active === "ctrl+o" || active === "ctrl-o") return ctrlO;
      if (active === "alt+o" || active === "alt-o") return altO;
      // 无配置或未知：默认仅 alt+o 生效
      return altO;
    } catch { return d === "\x1bo" || d === "\u001b[111;3u"; }
  })();
  if (isToggle) return "toggle";
  if (d === "\x15" || d === "\u001b[117;5u") return "halfUp"; // ctrl+u
  if (d === "\x04" || d === "\u001b[100;5u") return "halfDown"; // ctrl+d
  if (d === "\x06" || d === "\u001b[102;5u") return "pageDown"; // ctrl+f
  if (d === "\x02" || d === "\u001b[98;5u") return "pageUp"; // ctrl+b
  if (d === "\x10" || d === "\u001b[112;5u") return "lineUp"; // ctrl+p
  if (d === "\x0e" || d === "\u001b[110;5u") return "lineDown"; // ctrl+n
  if (d === "k") return "lineUp";
  if (d === "j") return "lineDown";
  if (d === "G") return "bottom"; // shift+g
  if (d === "g" || d === "gg") return "top"; // gg 双击 / 同批连发
  if (d === "?") return "help";
  if (matchesKey(d, "escape") || d === "i" || matchesKey(d, Key.ctrl("c"))) return "exit";
  return "other";
}

/** gg 双击判定（纯时序，可测）。窗口过短（如 100ms）或浏览器/终端把两个 g
 *  合并为同一块输入时都会让 gg 失效，默认 500ms 较稳，实例化常用 300ms。 */
export class GgSequence {
  private lastAt = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  constructor(private winMs = 500) {}
  /** 記録一次 g；返す true 表示 winMs 内双击命中（顶部） */
  press(now = Date.now()): boolean {
    const hit = now - this.lastAt < this.winMs;
    this.clearTimer();
    if (hit) {
      this.lastAt = 0;
      return true;
    }
    this.lastAt = now;
    this.timer = setTimeout(() => { this.lastAt = 0; }, this.winMs);
    return false;
  }
  reset(): void {
    this.lastAt = 0;
    this.clearTimer();
  }
  private clearTimer(): void {
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
  }
}

/** count 前缀：1-9 累积，0 仅已有 buffer 时追加，800ms 清空 */
export class CountBuffer {
  private buf = "";
  private timer: ReturnType<typeof setTimeout> | undefined;
  constructor(private winMs = 800) {}
  push(d: string): boolean {
    if (!/^[0-9]$/.test(d)) return false;
    if (d === "0" && this.buf === "") return false; // 前导 0 忽略（vim 0 行首）
    if (this.buf.length >= 4) return false; // 避免超大 count
    this.buf += d;
    this.clearTimer();
    this.timer = setTimeout(() => { this.buf = ""; }, this.winMs);
    if (this.timer && typeof (this.timer as any).unref === "function") (this.timer as any).unref();
    return true;
  }
  consume(): number | undefined {
    if (this.buf === "") return undefined;
    const n = parseInt(this.buf, 10);
    this.reset();
    return Number.isFinite(n) && n > 0 ? n : undefined;
  }
  peek(): number | undefined {
    if (this.buf === "") return undefined;
    const n = parseInt(this.buf, 10);
    return Number.isFinite(n) && n > 0 ? n : undefined;
  }
  hasValue(): boolean { return this.buf !== ""; }
  reset(): void {
    this.buf = "";
    this.clearTimer();
  }
  private clearTimer(): void {
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
  }
}

/** [ / ] + q/a/t 序列，500ms 窗口 */
export class BracketSequence {
  private pending: "[" | "]" | null = null;
  private timer: ReturnType<typeof setTimeout> | undefined;
  constructor(private winMs = 500) {}
  /**
   * @returns "prevQ"|"nextQ"|"prevA"|"nextA"|"prevT"|"nextT" 命中；"pending" 表示已收 leader 等待；null 无命中
   */
  push(data: string, now = Date.now()): string | null {
    void now;
    if (data === "[" || data === "]") {
      this.pending = data as "[" | "]";
      this.clearTimer();
      this.timer = setTimeout(() => { this.pending = null; }, this.winMs);
      if (this.timer && typeof (this.timer as any).unref === "function") (this.timer as any).unref();
      return "pending";
    }
    if (this.pending && (data === "q" || data === "a" || data === "t")) {
      const dir = this.pending === "[" ? "prev" : "next";
      const kind = data.toUpperCase(); // Q/A/T
      this.pending = null;
      this.clearTimer();
      return `${dir}${kind}`;
    }
    // 非预期字符，清空 pending
    if (this.pending) {
      this.pending = null;
      this.clearTimer();
    }
    return null;
  }
  reset(): void {
    this.pending = null;
    this.clearTimer();
  }
  private clearTimer(): void {
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
  }
}

function isPrintable(data: string): boolean {
  const cc = data.charCodeAt(0) || 0;
  return data.length === 1 && cc >= 32;
}

// ---------- 编辑器组件 ----------

/** 占位编辑器：输入/渲染实际由 listener 接管（INSERT 时透传）。
 *  必须带真实 theme/keybindings 构造（空对象会让 Editor.render borderColor() 崩）。 */
export class ScrollReaderEditor extends CustomEditor {
  public onReadingChange?: (reading: boolean) => void;
  public tuiRef: TUI;

  constructor(tui: TUI, theme: any, keybindings: any) {
    super(tui, theme, keybindings);
    this.tuiRef = tui;
  }
}

/** 只读编辑器：READING 时完全覆盖原 input 位置，居中显示 ◉ Reading，无边框。
 *  検索输入态时同位置显示 Search: <query> (n/m)，替换式常驻、不堆叠。 */
export class ReadonlyEditor extends CustomEditor {
  private readonly accent: (s: string) => string;
  private readonly searchUiRef?: { mode: boolean; query: string; idx: number; total: number };
  constructor(tui: TUI, theme: any, keybindings: any, style: { accent: (s: string) => string }, searchUiRef?: any) {
    super(tui, theme, keybindings);
    this.accent = style.accent;
    this.searchUiRef = searchUiRef;
  }
  override render(width: number): string[] {
    const su = this.searchUiRef;
    const q = (su?.query ?? "").trim();
    const inSearchInput = !!(su && su.mode);
    let line: string;
    if (su && (q || inSearchInput)) {
      const count = su.total > 0 ? ` (${Math.max(1, su.idx + 1)}/${su.total})` : (q ? " (no matches)" : "");
      const label = inSearchInput ? `Search: ${q}${count}` : `Search "${q}"${count}`;
      line = "  " + this.accent(label);
    } else if (su && q) {
      const count = su.total > 0 ? ` (${Math.max(1, su.idx + 1)}/${su.total})` : " (no matches)";
      const label = `Search "${q}"${count}`;
      line = "  " + this.accent(label);
    } else {
      line = "  " + this.accent("◉ Reading");
    }
    const w = visibleWidth(line);
    line += " ".repeat(Math.max(0, width - 2 - w));
    const empty = " ".repeat(width);
    return [empty, line, empty];
  }
  override handleInput(_data: string): void {}
  override getText(): string { return ""; }
  override getExpandedText(): string { return ""; }
  override setText(_text: string): void {}
  override setPaddingX(_padding: number): void {}
  override setAutocompleteMaxVisible(_maxVisible: number): void {}
}

// ---------- 工厂与扩展装配 ----------
export default function (pi: ExtensionAPI) {
  let isReading = false;
  let currentCtx: ExtensionContext | undefined;
  let ctxBroken = false;
  let savedInput = "";
  let latestTui: TUI | undefined;
  // 需求 B：最近一次 factory 收到的应用级 keybindings（terminal 通道回调无 kb 入参，需在外层记账）
  let latestKb: any;
  // 工具展开状态本地镜像：核心 ui context 无読み取り getter，扩展发起的每次变更在此记账；
  // null 表示尚未得知（首次推导规则见 applyReaderUI）。已知限制：编辑态由核心路径
  // （actionHandler 等）切换工具输出时镜像不感知会漂移，进入 READING 后即重新对齐。
  let toolsExpandedMirror: boolean | null = null;
  // スクロール恢复代际号：每次新的高度变更动作递增，作废在途监视器（防快速连按竞态）
  let scrollGen = 0;
  let offTerminalInput: (() => void) | undefined;
  // inputListener 只安装一次：mainFactory 退出阅读恢复时会再次被调用，防止重复拦截。
  let listenerInstalled = false;
  // reader 自己创建的最新编辑器实例（两个工厂都要登记）；不能用 instanceof——
  // jiti 模块边界下会失效，核心自己也用 duck typing
  let currentReaderEditor: object | undefined;
  // reader 自有的ヘルプ overlay 组件引用（dialogOpen 豁免用）
  let currentHelpComponent: object | undefined;
  const gg = new GgSequence(300); // gg 300ms 双击（100ms 过短易失效）
  const countBuf = new CountBuffer(800);
  const bracketSeq = new BracketSequence(500);
  // 上次语义跳目标（5s 有效，用于 [q/]q 连续步进）
  let lastSemanticRow: number | null = null;
  let lastSemanticAt = 0;
  // 検索ステートマシン：INACTIVE（なし） -> INPUT（/ 後に全量受信） -> NAV（enter 後に ? ショートカットのみ）
  let searchMode: SearchMode = SearchMode.INACTIVE;
  // 双通道去重：同一 data 在极短时间重复到达只处理一次
  let lastNavData = "";
  let lastNavAt = 0;
  let lastNavSource: "input" | "terminal" | null = null;

  const themeFg = (theme: any) => (theme?.fg ? theme.fg.bind(theme) : (t: string) => t);

  // READING 指示：状态直接显示在输入栏内（ReadonlyEditor），不再使用上方 widget
  const readingBarWidget = (_tui: any, _theme: any) => ({
    render: () => [] as string[],
    invalidate: () => {},
  });
  void readingBarWidget;

  const updateLastSemantic = (row: number): void => {
    lastSemanticRow = row;
    lastSemanticAt = Date.now();
  };

  const isDuplicateNav = (data: string, source: "input" | "terminal"): boolean => {
    const now = Date.now();
    // 仅抑制 terminal 对 input 的极短时间内重复投递（pi 双通道同一按键会走两条路径）
    // 窗口收敛到 20ms，降低人工连击 "aa" 被误判概率
    if (source === "terminal" && data === lastNavData && lastNavSource === "input" && now - lastNavAt < 20) {
      return true;
    }
    lastNavData = data;
    lastNavAt = now;
    lastNavSource = source;
    return false;
  };

  const flash = (tui: any, msg: string): void => {
    try { (tui as any)?.flash?.(msg); return; } catch {}
    try { currentCtx?.ui?.notify?.(msg, "info"); } catch {}
  };

  /**
   * フォーカスが非 reader コンポーネントに保持されている場合に真（拡張ダイアログ/ui.input/ui.custom など全ての奪取シーン）、
   * このとき reader は譲らなければならない。検出はキーごとのリアルタイムなフォーカス比較（スナップショットではない）：連鎖ダイアログ
   * （select → input 换组件）也能正确感知。豁免 reader 自有的编辑器、ヘルプ组件
   * 与検索输入组件，不依赖「overlay.hide 同步还原 preFocus」的隐式时序。
   */
  const dialogOpen = (): boolean => {
    try {
      const tui: any = latestTui;
      return isForeignFocus(tui?.focusedComponent, {
        editor: currentReaderEditor,
        help: currentHelpComponent,
        searchComponent: tui?.activeSearch?.component,
      });
    } catch { return false; }
  };

  // 検索进度显示在底部输入栏（ReadonlyEditor）固定位置替换，不用 flash。
  // 検索阶段常驻显示 Search，直到 esc 取消，不做节流切回 Reading。
  const searchUi = { mode: false, query: "", idx: -1, total: 0 };

  const clearSearchUi = (): void => {
    searchUi.mode = false;
    searchUi.query = "";
    searchUi.idx = -1;
    searchUi.total = 0;
  };

  /** 关闭検索栏并取消高亮，重置状态机，留在 READING */
  const closeSearchAndReset = (tui: any): void => {
    try { (tui as any)?.closeSearch?.(); } catch {}
    searchMode = SearchMode.INACTIVE;
    clearSearchUi();
    try { (tui as any)?.requestRender?.(); } catch {}
  };

  const proxySearchOpen = (tui: any): boolean => {
    clearSearchUi();
    try {
      const fn: any = (tui as any)?.openSearch;
      if (typeof fn === "function") {
        fn.call(tui);
        // 隐藏原生右上角 overlay，仅保留底部 ReadonlyEditor 的 Search 栏（单入口，避免双重 Search）
        try { (tui as any)?.activeSearch?.overlay?.hide?.(); } catch {}
        // 仍保留原生匹配逻辑（refreshSearch）用于高亮，仅隐藏视觉
        searchMode = SearchMode.INPUT;
        // 初始化底部栏为输入态
        searchUi.mode = true;
        searchUi.query = "";
        searchUi.idx = -1;
        searchUi.total = 0;
        tui?.requestRender?.();
        return true;
      }
    } catch {}
    flash(tui, "Search unavailable");
    return false;
  };

  /**
   * 検索输入阶段（/ 到 enter）：接收所有输入直到 enter
   * - enter: 提交 -> NAV (高亮保留，n/N 接管) 或空查询则直接 INACTIVE
   * - esc: 取消 -> closeSearch 取消高亮，回到 READING
   * - 其他: 全部喂给官方 Input（含 j/k、退格、粘贴等）
   * 返す true 表示已消费
   */
  const handleSearchInput = (d: string, tui: any, source: "input" | "terminal"): boolean | undefined => {
    if (searchMode !== SearchMode.INPUT) return undefined;
    if (isDuplicateNav(d, source)) return true;
    if (isEnterKey(d)) {
      // enter 切状态：有查询则进入 NAV，高亮保留；空查询则关闭
      try {
        const q = String((tui as any)?.activeSearch?.component?.input?.getValue?.() ?? (tui as any)?.activeSearch?.query ?? "").trim();
        if (!q) {
          closeSearchAndReset(tui);
          return true;
        }
        try { (tui as any)?.navigateSearch?.(1); } catch {}
        try {
          const ov: any = (tui as any)?.activeSearch?.overlay;
          if (ov && typeof ov.hide === "function") ov.hide();
        } catch {}
        searchMode = SearchMode.NAV;
        // 同步底部栏显示
        setTimeout(() => {
          try {
            const a2: any = (tui as any)?.activeSearch;
            if (!a2) { clearSearchUi(); return; }
            const q2 = String(a2?.query ?? "").trim();
            if (!q2) { clearSearchUi(); return; }
            // hide 后可能因 render 重现 overlay，再次隐藏保留高亮
            try { const ov2: any = a2?.overlay; if (ov2 && typeof ov2.hide === "function") ov2.hide(); } catch {}
            searchUi.mode = false;
            searchUi.query = q2;
            searchUi.idx = a2?.selectedIndex ?? -1;
            searchUi.total = a2?.matches?.length ?? 0;
            (tui as any)?.requestRender?.();
          } catch {}
        }, 30);
      } catch {}
      return true;
    }
    if (isEscKey(d)) {
      // esc 有検索栏就关闭取消高亮，留在 READING
      closeSearchAndReset(tui);
      return true;
    }
    const comp: any = (tui as any)?.activeSearch?.component;
    if (comp && typeof comp.handleInput === "function") {
      try { comp.handleInput(d); } catch {}
      // 同步底部栏：实时反映 query 与匹配数（单入口，避免右上角重复）
      try {
        const curQ = String(comp.input?.getValue?.() ?? (tui as any)?.activeSearch?.query ?? "").trim();
        // 下一帧 refreshSearch 才会更新 matches，先用当前 activeSearch 的值
        setTimeout(() => {
          try {
            const a: any = (tui as any)?.activeSearch;
            if (!a) return;
            // 确保原生 overlay 保持隐藏（仅底部栏）
            try { a.overlay?.hide?.(); } catch {}
            searchUi.mode = true;
            searchUi.query = curQ;
            searchUi.idx = a.selectedIndex ?? -1;
            searchUi.total = a.matches?.length ?? 0;
            try { (tui as any)?.requestRender?.(); } catch {}
          } catch {}
        }, 15);
        if (curQ) {
          searchUi.mode = true;
          searchUi.query = curQ;
          try { (tui as any)?.requestRender?.(); } catch {}
        } else {
          searchUi.query = "";
          searchUi.idx = -1;
          searchUi.total = 0;
        }
      } catch {}
      return true;
    }
    // 组件尚未就绪：仍消费避免落入 reading 导航
    return true;
  };

  const proxySearchNavigate = (tui: any, dir: number): boolean => {
    try {
      const as: any = (tui as any)?.activeSearch;
      const fn: any = (tui as any)?.navigateSearch;
      if (as && typeof fn === "function") {
        fn.call(tui, dir);
        setTimeout(() => {
          try {
            const a2: any = (tui as any)?.activeSearch;
            try {
              const ov2: any = a2?.overlay;
              if (ov2 && typeof ov2.hide === "function") ov2.hide();
            } catch {}
            const q = String(a2?.query ?? "").trim();
            if (!q) { clearSearchUi(); return; }
            searchUi.mode = false;
            searchUi.query = q;
            searchUi.idx = a2?.selectedIndex ?? -1;
            searchUi.total = a2?.matches?.length ?? 0;
            (tui as any)?.requestRender?.();
          } catch {}
        }, 30);
        return true;
      }
    } catch {}
    return false;
  };

  const clamp = (n: number, lo: number, hi: number): number => Math.max(lo, Math.min(n, hi));

  const findNextRow = (rows: number[], from: number, dir: number, wrap: boolean): number | null => {
    if (dir > 0) {
      for (const r of rows) if (r > from) return r;
      if (wrap && rows.length > 0) return rows[0] ?? null;
      return null;
    } else {
      for (let i = rows.length - 1; i >= 0; i--) if ((rows[i] ?? 0) < from) return rows[i] ?? null;
      if (wrap && rows.length > 0) return rows[rows.length - 1] ?? null;
      return null;
    }
  };

  const navigateByKind = (kind: string, count: number, tui: any): boolean => {
    const vs = getViewportState(tui);
    if (!vs.lines) { flash(tui, "No content"); return true; }
    if (!vs.scrollView) return false;
    let rows: number[] = [];
    let label = "";
    switch (kind) {
      case "prevQ":
      case "nextQ":
        rows = findPromptRows(vs.lines);
        label = "Question";
        break;
      case "prevA":
      case "nextA":
        rows = findAnswerRows(vs.lines);
        label = "Answer";
        break;
      case "prevT":
      case "nextT":
        rows = findToolRows(vs.lines);
        label = "Tool";
        break;
      default: return false;
    }
    if (rows.length === 0) { flash(tui, `No ${label.toLowerCase()}s`); return true; }
    const dir = kind.startsWith("prev") ? -1 : 1;
    const cfg = getNavConfigCached();
    const anchor = (cfg.questionAnchor ?? "pinTop") as Anchor;
    const visibleBehavior = (cfg.visibleBehavior ?? "keep") as VisibleBehavior;
    const wrap = Boolean(cfg.wrapNavigation);
    let searchFrom: number;
    if (lastSemanticRow !== null && Date.now() - lastSemanticAt < 5000 && isRowVisible(lastSemanticRow, vs.scrollTop, vs.vh)) {
      searchFrom = dir > 0 ? lastSemanticRow + 1 : lastSemanticRow - 1;
    } else {
      searchFrom = vs.scrollTop;
      if (dir < 0 && vs.scrollTop === vs.maxTop) searchFrom = vs.scrollTop + vs.vh;
      else if (dir > 0) searchFrom = vs.scrollTop + 1;
    }
    let target: number | null = null;
    for (let i = 0; i < count; i++) {
      const nxt = findNextRow(rows, searchFrom, dir, wrap);
      if (nxt === null) break;
      target = nxt;
      searchFrom = dir > 0 ? nxt + 1 : nxt - 1;
    }
    if (target === null) {
      flash(tui, dir > 0 ? `No more ${label.toLowerCase()}s` : `No previous ${label.toLowerCase()}`);
      return true;
    }
    const isVis = isRowVisible(target, vs.scrollTop, vs.vh);
    if (isVis && visibleBehavior === "keep") {
      updateLastSemantic(target);
      const idx = rows.indexOf(target) + 1;
      flash(tui, `${label} ${idx}/${rows.length}`);
      return true;
    }
    const offset = getAnchorOffset(vs.vh, anchor);
    const desired = target - offset;
    const newTop = clamp(desired, 0, vs.maxTop);
    try {
      vs.scrollView.scrollTo(newTop, { disableFollow: true });
      updateLastSemantic(target);
      const idx = rows.indexOf(target) + 1;
      flash(tui, `${label} ${idx}/${rows.length}`);
      tui?.requestRender?.();
    } catch {}
    return true;
  };

  const navigateParagraph = (dir: -1 | 1, count: number, tui: any): boolean => {
    const vs = getViewportState(tui);
    if (!vs.lines) { flash(tui, "No content"); return true; }
    if (!vs.scrollView) return false;
    const cfg = getNavConfigCached();
    const anchor = (cfg.questionAnchor ?? "pinTop") as Anchor;
    let cur = vs.scrollTop;
    if (lastSemanticRow !== null && Date.now() - lastSemanticAt < 5000 && isRowVisible(lastSemanticRow, vs.scrollTop, vs.vh)) {
      cur = lastSemanticRow;
    }
    let target: number | null = null;
    for (let i = 0; i < count; i++) {
      const nxt = findParagraphBounds(vs.lines, cur, dir);
      if (nxt === null) break;
      target = nxt;
      cur = nxt;
    }
    if (target === null) {
      flash(tui, dir > 0 ? "No next paragraph" : "No previous paragraph");
      return true;
    }
    const offset = getAnchorOffset(vs.vh, anchor);
    const newTop = clamp(target - offset, 0, vs.maxTop);
    try {
      vs.scrollView.scrollTo(newTop, { disableFollow: true });
      updateLastSemantic(target);
      tui?.requestRender?.();
    } catch {}
    return true;
  };

  /**
   * 统一阅读态按键处理（供双通道复用）
   * @returns true 表示已消费
   */
  const tryHandleReadingNav = (data: string, tui: any): boolean => {
    if (data.length > 1 && !data.startsWith("\x1b") && data !== "gg") {
      let handledAny = false;
      let allHandled = true;
      for (const ch of data) {
        const r = tryHandleReadingNav(ch, tui);
        if (r) handledAny = true;
        else allHandled = false;
      }
      if (handledAny && allHandled) return true;
      if (!allHandled) return false;
      if (handledAny) return true;
      return false;
    }
    if (/^[0-9]$/.test(data) && data.length === 1) {
      const ok = countBuf.push(data);
      return true && (ok || true);
    }
    // 検索：/ 进入 INPUT（全量接收），n/N 在 NAV/有検索时导航
    if (data === "/") {
      const opened = proxySearchOpen(tui);
      if (opened) {
        countBuf.reset();
        bracketSeq.reset();
        tui?.requestRender?.();
        return true;
      }
      return false;
    }
    if (data === "n") {
      // 仅 NAV 或存在 activeSearch 时有效，避免无検索时误触发
      if (searchMode === SearchMode.NAV || hasActiveSearch(tui)) {
        proxySearchNavigate(tui, 1);
        countBuf.reset();
        tui?.requestRender?.();
        return true;
      }
      return false;
    }
    if (data === "N") {
      if (searchMode === SearchMode.NAV || hasActiveSearch(tui)) {
        proxySearchNavigate(tui, -1);
        countBuf.reset();
        tui?.requestRender?.();
        return true;
      }
      return false;
    }
    if (data === "{" || data === "}") {
      const cnt = countBuf.consume() ?? 1;
      bracketSeq.reset();
      navigateParagraph(data === "{" ? -1 : 1, cnt, tui);
      return true;
    }
    const bracketRes = bracketSeq.push(data);
    if (bracketRes === "pending") {
      countBuf.peek();
      return true;
    }
    if (bracketRes) {
      const cnt = countBuf.consume() ?? 1;
      navigateByKind(bracketRes, cnt, tui);
      return true;
    }
    return false;
  };

  // ? ヘルプポップアップ内容：key 列 + 説明列、固定幅で整列させボックスを整然と読みやすくする
  const getHelpEntries = (): Array<[string, string]> => {
    const toggle = getActiveToggleLabel();
    const entries: Array<[string, string]> = [
      [toggle, "Toggle reading mode"],
      ["Ctrl+U / Ctrl+D", "Half page up / down"],
      ["Ctrl+F / Ctrl+B", "Page down / up"],
      ["j / k  /  Ctrl+N / Ctrl+P", "Line down / up (count, e.g. 5j)"],
      ["g g (within 300ms)", "Go to top"],
      ["G (Shift+G)", "Go to bottom"],
      ["[q / ]q", "Prev/next question"],
      ["[a / ]a", "Prev/next answer"],
      ["[t / ]t", "Prev/next tool"],
      ["{ / }", "Prev/next paragraph"],
      ["/ (Search)", "n / N  next/prev match"],
      ["Esc / i / Ctrl+C", "Exit reading mode"],
      ["?", "Show this help"],
    ];
    // 需求 B：动态插入 app.tools.expand 键位行（拿不到键位则隐藏该行，plan §9.2）
    try {
      const keys: string[] = latestKb?.getKeys?.("app.tools.expand") ?? [];
      if (keys.length > 0) {
        entries.splice(1, 0, [keys.join("/"), "Toggle tool output (edit & reading)"]);
      }
    } catch { /* 拿不到则隐藏 */ }
    return entries;
  };

  let helpOpen = false;
  // ヘルプ overlay のクローズ入口（done コールバックのラップ）：esc パスとダイアログ期間のガードで共用
  let helpClose: (() => void) | undefined;
  const showHelp = () => {
    if (helpOpen) return;
    let ui: any;
    try { ui = currentCtx?.ui; } catch { return; }
    if (!ui?.custom) return;
    helpOpen = true;
    currentHelpComponent = undefined;
    ui.custom((tui: any, _theme: any, _kb: any, done: (v: any) => void) => {
      const comp = {
        render: (width: number) => {
          const entries = getHelpEntries();
          const padL = 2;
          const keyW = 28;
          const descW = 42;
          const innerNeed = padL + keyW + 2 + descW;
          const usable = Math.min(innerNeed, Math.max(44, width - 2));
          const t = truncateToWidth;
          const center = (s: string): string => {
            const w = visibleWidth(s);
            const left = Math.max(0, Math.floor((usable - w) / 2));
            return " ".repeat(left) + s + " ".repeat(Math.max(0, usable - left - w));
          };
          const body = (row: string): string => {
            const w = visibleWidth(row);
            return "│" + " ".repeat(padL) + row + " ".repeat(Math.max(0, usable - padL - w)) + "│";
          };
          const out: string[] = [];
          out.push("╭" + "─".repeat(usable) + "╮");
          const titleRow = center("Reading Mode Help").trimEnd();
          out.push("│" + titleRow + " ".repeat(Math.max(0, usable - visibleWidth(titleRow))) + "│");
          out.push("│" + " ".repeat(usable) + "│");
          for (const [k, d] of entries) {
            const key = t(k, keyW);
            const descW2 = Math.max(0, usable - padL - keyW - 2);
            const desc = t(d, descW2);
            const row = key + " ".repeat(Math.max(0, keyW - visibleWidth(key))) + "  " + desc;
            out.push(body(row));
          }
          out.push("│" + " ".repeat(usable) + "│");
          const closeRow = center("Press Esc to close").trimEnd();
          out.push("│" + closeRow + " ".repeat(Math.max(0, usable - visibleWidth(closeRow))) + "│");
          out.push("╰" + "─".repeat(usable) + "╯");
          return out;
        },
        handleInput: (data: string) => {
          if (matchesKey(data, "escape")) helpClose?.();
        },
        invalidate: () => {},
        focused: true,
      } as any;
      // reader 所有の overlay コンポーネント参照とクローズ入口を登録（dialogOpen のフォーカス比較除外 / ダイアログ期間は esc で先にヘルプを閉じる）
      currentHelpComponent = comp;
      helpClose = () => {
        if (!helpOpen) return;
        helpOpen = false;
        currentHelpComponent = undefined;
        helpClose = undefined;
        done(undefined);
      };
      return comp;
    }, { overlay: true, overlayOptions: { anchor: "center" as any } } as any)?.then(() => {
      helpOpen = false;
      currentHelpComponent = undefined;
      helpClose = undefined;
    }).catch(() => {
      helpOpen = false;
      currentHelpComponent = undefined;
      helpClose = undefined;
    });
  };

  // スクロール恢复代际号递增：作废在途监视器，返す新号
  const advanceScrollGen = (): number => {
    scrollGen += 1;
    return scrollGen;
  };

  /** 守卫链キャプチャ（plan §6）：scrollView 存在？lines 存在？非贴底跟随态？任一失败返す null */
  const tryCaptureAnchor = (): ScrollAnchor | null => {
    try {
      const tui: any = latestTui;
      if (!tui) return null;
      const sv: any = tui.currentLayout?.primaryScrollView ?? tui.getPrimaryScrollView?.() ?? null;
      if (!sv) return null;
      try { if (sv.isFollowingEnd === true) return null; } catch {}
      const vs = getViewportState(tui);
      return captureAnchor(vs.lines, vs.scrollTop);
    } catch { return null; }
  };

  /**
   * 挂布局稳定监视器；稳定后按锚点 scrollTo(target, { disableFollow: true })。
   * disableFollow 必带：否则目标落底时会重新武装 follow-end，前功尽弃（plan §6 约束 3）。
   */
  const scheduleScrollRestore = (anchor: ScrollAnchor | null): void => {
    if (!anchor) return;
    const gen = scrollGen;
    try {
      const tui: any = latestTui;
      if (!tui) return;
      new ScrollRestoreMonitor({
        generation: gen,
        getGeneration: () => scrollGen,
        getFrame: () => (tui as any).currentLayout,
        getContentHeight: () => getViewportState(tui).contentHeight,
        requestRender: () => (tui as any).requestRender?.(),
        onRestore: () => {
          try {
            const cur: any = latestTui;
            if (!cur || scrollGen !== gen) return;
            const vs = getViewportState(cur);
            const target = computeRestoreRow(vs.lines, anchor, vs.vh);
            if (target === null || !vs.scrollView) return;
            vs.scrollView.scrollTo(target, { disableFollow: true });
            cur.requestRender?.();
          } catch { /* 静默フォールバック */ }
        },
      }).start();
    } catch { /* 静默フォールバック */ }
  };

  /**
   * 扩展侧统一的工具展开变更入口：镜像记账 + 锚点保位（先キャプチャ再变更）。
   * applyReaderUI 的自动展开/收拢与 §9.2 阅读态手动分支都必须走这里。
   */
  const toggleToolsExpandedWithAnchor = (notify?: (msg: string) => void): void => {
    const next = !(toolsExpandedMirror ?? false);
    advanceScrollGen();
    // 必须在高度生效前同步キャプチャ（setExpanded 在下一次 render 才改变行数）
    const anchor = tryCaptureAnchor();
    try { currentCtx?.ui?.setToolsExpanded?.(next); } catch {}
    toolsExpandedMirror = next;
    scheduleScrollRestore(anchor);
    if (notify) notify(`Tool output: ${next ? "expanded" : "collapsed"}`);
  };

  // 统一应用 READING UI；输入栏用 ReadonlyEditor 覆盖，保留原输入内容，工具展开/收起 Promise 异步不阻塞首帧
  const applyReaderUI = (reading: boolean) => {
    let ui: any;
    try {
      ui = currentCtx?.ui;
    } catch {
      ctxBroken = true;
      return;
    }
    if (!ui) return;
    const safe = (fn: () => void) => { try { fn(); } catch { /* 忽略 */ } };
    advanceScrollGen(); // 作废在途恢复监视器
    const autoExpand = isAutoExpandToolsEnabled();
    // 镜像推导：首次未知时按“刚进入且 autoExpandTools=true → true，否则 false”（plan §9.4）
    toolsExpandedMirror = autoExpand ? reading : (toolsExpandedMirror ?? false);
    // キャプチャ必须在任何高度变化之前同步完成（plan §6 约束 1）
    const anchor = tryCaptureAnchor();
    if (reading) {
      try { savedInput = ui.getEditorText?.() ?? ""; } catch { savedInput = ""; }
      safe(() => ui.setEditorComponent?.(readonlyEditorFactory(ui)));
      safe(() => ui.setEditorText?.(""));
      Promise.resolve().then(() => {
        try { if (autoExpand) ui.setToolsExpanded?.(true); } catch {}
        scheduleScrollRestore(anchor);
      });
    } else {
      safe(() => ui.setEditorComponent?.(mainFactory));
      Promise.resolve().then(() => {
        try { if (autoExpand) ui.setToolsExpanded?.(false); } catch {}
        scheduleScrollRestore(anchor);
      });
      const toRestore = savedInput;
      savedInput = "";
      if (toRestore) safe(() => ui.setEditorText?.(toRestore));
    }
  };

  // toggle：只翻转状态 + 尽力应用 UI
  /** @returns 実際に反転したか（外部ダイアログがフォーカスを保持している場合はガードにブロックされ false を返す） */
  const toggle = (ctx?: ExtensionContext): boolean => {
    if (ctx) {
      currentCtx = ctx;
      ctxBroken = false;
    }
    // 多層防御：外部ダイアログがフォーカスを保持している場合は切替を禁止 — コンテナ再構築によりダイアログの promise が宙吊りになる（Bug B）
    if (dialogOpen()) return false;
    if (isReading) {
      gg.reset();
      countBuf.reset();
      bracketSeq.reset();
      helpOpen = false;
      // 退出 reading 时若検索还开着，一并关闭恢复视图
      try { (latestTui as any)?.closeSearch?.(); } catch {}
      searchMode = SearchMode.INACTIVE;
      clearSearchUi();
    } else {
      // 进入 reading 时确保検索状态干净
      searchMode = SearchMode.INACTIVE;
      clearSearchUi();
    }
    isReading = !isReading;
    applyReaderUI(isReading);
    return true;
  };

  /** esc 统一处理：有検索栏就关闭取消高亮，留在 READING；无検索才退出 READING */
  const handleEsc = (tui: any): boolean => {
    if (searchMode === SearchMode.INPUT || searchMode === SearchMode.NAV || hasActiveSearch(tui)) {
      closeSearchAndReset(tui);
      return true;
    }
    toggle();
    try { (latestTui as any)?.requestRender?.(); } catch {}
    return true;
  };

  // ---------- 可测性接缝：双渠道共用路由的薄接线（单测见 test/router.test.ts） ----------
  const routerIO: ReadingRouterIO = {
    isReading: () => isReading,
    searchMode: () => searchMode,
    helpOpen: () => helpOpen,
    dialogOpen,
    getTui: () => latestTui ?? (currentCtx as any)?.ui?.tui ?? (currentCtx as any)?.tui,
    isDuplicateNav,
    handleSearchInput: (d, tui, src) => handleSearchInput(d, tui, src),
    handleEsc: (tui) => { handleEsc(tui); },
    closeSearch: (tui) => { closeSearchAndReset(tui); },
    toggle: () => toggle(),
    showHelp,
    closeHelp: () => { try { helpClose?.(); } catch {} },
    matchesExpand: (d) => {
      try { return latestKb?.matches?.(d, "app.tools.expand") === true; } catch { return false; }
    },
    toggleToolsExpanded: () => {
      const tt: any = latestTui ?? (currentCtx as any)?.ui?.tui ?? (currentCtx as any)?.tui;
      toggleToolsExpandedWithAnchor((m) => flash(tt, m));
    },
    trySemanticNav: (d, tui) => tryHandleReadingNav(d, tui),
    getViewportHeight: (tui) => {
      try {
        return tui?.getPrimaryScrollView?.().viewportHeight ?? (latestTui as any)?.getPrimaryScrollView?.().viewportHeight ?? 20;
      } catch { return 20; }
    },
    ggPress: () => gg.press(),
    ggReset: () => gg.reset(),
    countPeek: () => countBuf.peek(),
    countReset: () => countBuf.reset(),
    resetModifiers: () => { countBuf.reset(); bracketSeq.reset(); },
    updateLastSemantic,
    requestRender: (tui) => { try { tui?.requestRender?.(); } catch {} },
  };
  const inputRoute = createReadingKeyRouter(routerIO, "input");
  const terminalRoute = createReadingKeyRouter(routerIO, "terminal");

  // TUI inputListener 高可靠拦截（不依赖 editor focus）
  const factory = (tui: TUI, theme: any, kb: any) => {
    const tt: any = tui;
    let ed: ScrollReaderEditor;
    try {
      ed = new ScrollReaderEditor(tui, theme, kb);
    } catch {
      ed = new ScrollReaderEditor(tui, theme ?? {}, kb ?? {});
    }
    try { latestTui = tui as any; } catch {}
    // dialogOpen 焦点比对基准：登记 reader 自己创建的最新编辑器实例
    currentReaderEditor = ed;
    // 需求 B：terminal 通道无 kb 入参，在此记账（仿 latestTui 先例，plan §9.2）
    try { latestKb = (kb as any) ?? undefined; } catch {}
    try {
      if (listenerInstalled) return ed;
      listenerInstalled = true;
      tt.addInputListener?.((d: string) => inputRoute(d));
    } catch {}
    return ed;
  };
  const mainFactory = (tui: TUI, theme: any, kb: any) => factory(tui, theme, kb);
  const readonlyEditorFactory = (ui: any) => {
    const fg = themeFg(ui?.theme);
    return (tui: TUI, theme: any, kb: any) => {
      const ro = new ReadonlyEditor(tui, theme, kb, { accent: (s: string) => fg("accent", s) }, searchUi);
      // dialogOpen 焦点比对基准：READing 态下登记最新编辑器实例
      currentReaderEditor = ro;
      return ro;
    };
  };
  const getActiveToggleLabel = (): string => {
    try {
      if ((process as any).env?.VITEST) return "Alt+O";
      const raw = getToggleKeyRawCached();
      if (raw) return String(raw);
    } catch {}
    return "Alt+O";
  };
  const refreshCtx = (ctx: ExtensionContext | undefined) => {
    if (ctx) {
      currentCtx = ctx;
      ctxBroken = false;
      try {
        const maybeTui: any = (ctx as any)?.ui?.tui ?? (ctx as any)?.tui;
        if (maybeTui?.scrollBy) latestTui = maybeTui;
      } catch {}
    }
  };
  const installTerminalListener = (ctx: ExtensionContext) => {
    try { offTerminalInput?.(); } catch {}
    try {
      offTerminalInput = ctx.ui.onTerminalInput?.((data: string) => terminalRoute(data)) as any;
    } catch {}
  };
  const handleSession = async (_event: any, ctx: ExtensionContext) => {
    refreshCtx(ctx);
    isReading = false;
    helpOpen = false;
    listenerInstalled = false;
    // ダイアログ検出基準をリセット：「resetExtensionUI が listener をクリア → ファクトリが先に再登録する」という間接的なタイミングに依存しない
    currentReaderEditor = undefined;
    currentHelpComponent = undefined;
    helpClose = undefined;
    gg.reset();
    countBuf.reset();
    bracketSeq.reset();
    searchMode = SearchMode.INACTIVE;
    clearSearchUi();
    lastSemanticRow = null;
    savedInput = "";
    // 新会话聊天树重建，工具展开回到核心默认（收拢）；作废在途恢复监视器
    toolsExpandedMirror = false;
    advanceScrollGen();
    // 配置常驻缓存，reload / 新会话时重新読み取り
    __resetNavConfigCacheForTest();
    try {
      ctx.ui.setEditorComponent((tui, theme, kb) => {
        latestTui = tui;
        return factory(tui, theme, kb);
      });
    } catch {}
    installTerminalListener(ctx);
  };
  pi.on("session_start", handleSession as any);
  pi.on("session_info_changed" as any, async (_e: any, ctx: ExtensionContext) => refreshCtx(ctx));
  pi.on("session_before_switch" as any, async (_e: any, ctx: ExtensionContext) => refreshCtx(ctx));
  pi.on("session_before_fork" as any, async (_e: any, ctx: ExtensionContext) => refreshCtx(ctx));
  pi.on("session_before_compact" as any, async (_e: any, ctx: ExtensionContext) => refreshCtx(ctx));
  pi.on("session_compact" as any, async (_e: any, ctx: ExtensionContext) => refreshCtx(ctx));
  pi.on("session_before_tree" as any, async (_e: any, ctx: ExtensionContext) => refreshCtx(ctx));
  pi.on("session_tree" as any, async (_e: any, ctx: ExtensionContext) => refreshCtx(ctx));
  pi.on("session_shutdown" as any, async (_e: any, ctx: ExtensionContext) => refreshCtx(ctx));

  const cmdHandler = async (_args: string, ctx: ExtensionContext) => {
    const applied = toggle(ctx);
    if (!applied) {
      // 多層防御パス（ダイアログがフォーカスを保持している場合はコマンド入力はそもそも到達不能）：発生していない状態遷移を宣言しない
      const label = getActiveToggleLabel();
      ctx.ui.notify(`外部ダイアログがフォーカスを保持しているため、無視しました ${label} リーディングモード切替`, "info");
      return;
    }
    const label = getActiveToggleLabel();
    ctx.ui.notify(isReading
      ? `已进入阅读模式（${label} 切换）：ctrl-u/d 半页 f/b 整页 gg/G 顶底 j/k 行 esc/i 退出，? ヘルプ`
      : "已退出阅读模式，恢复编辑", "info");
  };
  pi.registerCommand("reader", {
    description: "切换阅读模式（vim 翻页：ctrl-u/d f/b gg/G + [q/a/t { } / n N）",
    handler: cmdHandler,
  });
  pi.registerCommand("scroll", {
    description: "切换阅读模式（别名，等同 /reader）",
    handler: cmdHandler,
  });
}
