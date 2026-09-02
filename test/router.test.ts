import { describe, it, expect, vi } from "vitest";
import {
  createReadingKeyRouter,
  hasActiveSearch,
  isForeignFocus,
  SearchMode,
  type ReadingRouterIO,
} from "../src/index.ts";

/**
 * 二重チャネル共有ルーティングの単体テスト：依存性注入による fake tui と制御可能な状態。
 * 注意：extensionSelector を持つ偽オブジェクトは構築しない — 実ランタイムではそのプライベートフィールドは常に到達不能、
 * ダイアログ検出は focusedComponent の参照比較で行い、fake は切替可能な dialogOpen() を提供すればよい。
 */
function makeHarness(overrides: Partial<ReadingRouterIO> = {}) {
  const state = {
    isReading: true,
    searchMode: SearchMode.INACTIVE,
    helpOpen: false,
    dialogOpen: false,
  };
  const calls = {
    toggle: vi.fn(),
    showHelp: vi.fn(),
    handleEsc: vi.fn(),
    closeSearch: vi.fn(),
    expand: vi.fn(),
    renders: vi.fn(),
    searchInput: vi.fn(),
    semanticNav: vi.fn(),
  };
  const tui: any = {
    scrollBy: vi.fn(),
    scrollToTop: vi.fn(),
    scrollToBottom: vi.fn(),
    requestRender: vi.fn(),
  };
  const io: ReadingRouterIO = {
    isReading: () => state.isReading,
    searchMode: () => state.searchMode,
    helpOpen: () => state.helpOpen,
    dialogOpen: () => state.dialogOpen,
    getTui: () => tui,
    isDuplicateNav: () => false,
    handleSearchInput: (d, tt, src) => { calls.searchInput(d, tt, src); return true; },
    handleEsc: () => { calls.handleEsc(); },
    closeSearch: () => { calls.closeSearch(); },
    toggle: () => { calls.toggle(); state.isReading = !state.isReading; },
    showHelp: () => { calls.showHelp(); },
    closeHelp: () => { state.helpOpen = false; },
    matchesExpand: () => false,
    toggleToolsExpanded: () => { calls.expand(); },
    trySemanticNav: (d, tt) => { calls.semanticNav(d, tt); return false; },
    getViewportHeight: () => 20,
    ggPress: () => false,
    ggReset: () => {},
    countPeek: () => undefined,
    countReset: () => {},
    resetModifiers: () => {},
    updateLastSemantic: () => {},
    requestRender: () => { calls.renders(); },
    ...overrides,
  };
  return {
    state,
    calls,
    tui,
    term: createReadingKeyRouter(io, "terminal"),
    input: createReadingKeyRouter(io, "input"),
  };
}

describe("router: 外部ダイアログがフォーカスを奪っている期間（dialogOpen=true）", () => {
  it("チャネル1：Enter/j/CSI Down/SSU Down/?/esc は全てパススルー（undefined を返す）", () => {
    const h = makeHarness();
    h.state.dialogOpen = true;
    for (const d of ["\r", "j", "k", "\x1b[B", "\x1bOB", "?", "\x1b"]) {
      expect(h.term(d)).toBeUndefined();
    }
    // リーディングの副作用は一切発生しない
    expect(h.calls.toggle).not.toHaveBeenCalled();
    expect(h.calls.handleEsc).not.toHaveBeenCalled();
    expect(h.calls.showHelp).not.toHaveBeenCalled();
    expect(h.tui.scrollBy).not.toHaveBeenCalled();
  });

  it("チャネル1：toggle キーは消費してブロック、ただし isReading は反転せず UI 切替も発火しない（Bug B 防止）", () => {
    const h = makeHarness();
    h.state.dialogOpen = true;
    // VITEST 下では toggle は alt+o に固定
    expect(h.term("\x1bo")).toEqual({ consume: true });
    expect(h.calls.toggle).not.toHaveBeenCalled();
    expect(h.state.isReading).toBe(true);
    // Kitty プロトコルシーケンスも同様にブロック
    expect(h.term("\u001b[111;3u")).toEqual({ consume: true });
    expect(h.calls.toggle).not.toHaveBeenCalled();
  });

  it("チャネル2：toggle キーも全てパススルー（チャネル1に譲渡、ローカルで消費しない）", () => {
    const h = makeHarness();
    h.state.dialogOpen = true;
    expect(h.input("\x1bo")).toBeUndefined();
    expect(h.calls.toggle).not.toHaveBeenCalled();
  });

  it("チャネル2：SEARCH_INPUT 状態でも文字は同様にダイアログへパススルー（ガードが検索状態より優先）", () => {
    const h = makeHarness();
    h.state.dialogOpen = true;
    h.state.searchMode = SearchMode.INPUT;
    for (const d of ["a", "\r", "\x1bOB"]) {
      expect(h.input(d)).toBeUndefined();
    }
    expect(h.calls.searchInput).not.toHaveBeenCalled();
  });
});

describe("router: ダイアログなし通常パス（リグレッション）", () => {
  it("チャネル1：toggle は正常に切替えて消費", () => {
    const h = makeHarness();
    expect(h.term("\x1bo")).toEqual({ consume: true });
    expect(h.calls.toggle).toHaveBeenCalledTimes(1);
    expect(h.state.isReading).toBe(false);
  });

  it("チャネル2：toggle はチャネル1に譲渡（undefined を返し、二重切替しない）", () => {
    const h = makeHarness();
    expect(h.input("\x1bo")).toBeUndefined();
    expect(h.calls.toggle).not.toHaveBeenCalled();
  });

  it("READING 下で j/k 行スクロール + count プレフィックスが有効", () => {
    const h = makeHarness({ countPeek: () => 5 });
    expect(h.term("j")).toEqual({ consume: true });
    expect(h.tui.scrollBy).toHaveBeenLastCalledWith(5);
    expect(h.input("k")).toEqual({ consume: true });
    expect(h.tui.scrollBy).toHaveBeenLastCalledWith(-5);
  });

  it("§3.3：application cursor keys の SSU 方向キーシーケンス透過（\\x1bO プレフィックス）", () => {
    const h = makeHarness();
    // Down/Up は application cursor keys モードでは \x1bOB/\x1bOA となり、フォーカスコンポーネントへパススルーすべきで消費されてはならない
    expect(h.term("\x1bOB")).toBeUndefined();
    expect(h.term("\x1bOA")).toBeUndefined();
    // CSI シーケンスは従来通りパススルー
    expect(h.term("\x1b[B")).toBeUndefined();
    // 複数バイトの非 CSI/SSU シーケンスは依然として消費し、コアへの漏洩を防ぐ
    expect(h.term("\x1bz")).toEqual({ consume: true });
  });

  it("編集状態（isReading=false）：ナビゲーションキーは消費せずスクロールもしない", () => {
    const h = makeHarness();
    h.state.isReading = false;
    expect(h.term("j")).toBeUndefined(); // 渠道 1 非阅读态只閉心 toggle
    expect(h.input("j")).toBeUndefined(); // チャネル2は非リーディング状態でパススルー
    expect(h.tui.scrollBy).not.toHaveBeenCalled();
  });

  it("?：チャネル2は譲渡、チャネル1はヘルプを開いて消費；helpOpen 時は両チャネルとも早期リターン", () => {
    const h = makeHarness();
    expect(h.input("?")).toBeUndefined();
    expect(h.calls.showHelp).not.toHaveBeenCalled();
    expect(h.term("?")).toEqual({ consume: true });
    expect(h.calls.showHelp).toHaveBeenCalledTimes(1);
    h.state.helpOpen = true;
    expect(h.term("?")).toBeUndefined();
    expect(h.input("?")).toBeUndefined();
  });

  it("esc の二義性：検索なし時は handleEsc 経由で終了；i は NAV 状態で検索をクリアして READING に留まる", () => {
    const h = makeHarness();
    expect(h.term("\x1b")).toEqual({ consume: true });
    expect(h.calls.handleEsc).toHaveBeenCalledTimes(1);
    expect(h.calls.toggle).not.toHaveBeenCalled();

    h.state.searchMode = SearchMode.NAV;
    expect(h.term("i")).toEqual({ consume: true });
    expect(h.calls.closeSearch).toHaveBeenCalledTimes(1);
    expect(h.calls.toggle).not.toHaveBeenCalled();

    // 无搜索时 i 直接退阅读
    h.state.searchMode = SearchMode.INACTIVE;
    expect(h.term("i")).toEqual({ consume: true });
    expect(h.calls.toggle).toHaveBeenCalledTimes(1);
  });

  it("SEARCH_INPUT：両チャネルとも handleSearchInput に委譲；消費されなければパススルー", () => {
    const h = makeHarness();
    h.state.searchMode = SearchMode.INPUT;
    expect(h.term("a")).toEqual({ consume: true });
    expect(h.input("b")).toEqual({ consume: true });
    expect(h.calls.searchInput).toHaveBeenCalledWith("a", h.tui, "terminal");
    expect(h.calls.searchInput).toHaveBeenCalledWith("b", h.tui, "input");
    // handler 返回 undefined（如非 INPUT 兜底）→ 不消费
    const h2 = makeHarness({ handleSearchInput: () => undefined });
    h2.state.searchMode = SearchMode.INPUT;
    expect(h2.term("a")).toBeUndefined();
  });

  it("gg は同バッチ連発で先頭へ直行；単一 g はダブルクリック待ちで消費のみ、スクロールなし", () => {
    const h = makeHarness();
    expect(h.term("gg")).toEqual({ consume: true });
    expect(h.tui.scrollToTop).toHaveBeenCalledTimes(1);
    expect(h.term("g")).toEqual({ consume: true });
    expect(h.tui.scrollToTop).toHaveBeenCalledTimes(1);
  });

  it("G 末尾 / ctrl-u 半ページ", () => {
    const h = makeHarness();
    expect(h.term("G")).toEqual({ consume: true });
    expect(h.tui.scrollToBottom).toHaveBeenCalledTimes(1);
    expect(h.term("\x15")).toEqual({ consume: true }); // ctrl+u，vh=20 → half=10
    expect(h.tui.scrollBy).toHaveBeenLastCalledWith(-10);
  });

  it("重複排除ヒット：直接消費しスクロール/セマンティックナビゲーションは発火しない", () => {
    const h = makeHarness({ isDuplicateNav: () => true });
    expect(h.term("j")).toEqual({ consume: true });
    expect(h.tui.scrollBy).not.toHaveBeenCalled();
    expect(h.calls.semanticNav).not.toHaveBeenCalled();
  });

  it("app.tools.expand ヒット：ツール展開を発火して消費", () => {
    const h = makeHarness({ matchesExpand: (d) => d === "\x0f" });
    expect(h.term("\x0f")).toEqual({ consume: true });
    expect(h.calls.expand).toHaveBeenCalledTimes(1);
  });

  it("セマンティックナビゲーションヒットで即消費", () => {
    const semNav = vi.fn((d: string) => d === "/");
    const h = makeHarness({ trySemanticNav: semNav });
    expect(h.term("/")).toEqual({ consume: true });
    expect(semNav).toHaveBeenCalledWith("/", h.tui);
    expect(h.term("x")).toEqual({ consume: true }); // 未命中落入 other 分支仍消费
    expect(h.tui.scrollBy).not.toHaveBeenCalled();
  });

  it("非 INPUT 状態では検索処理分岐に入らない（NAV/INACTIVE ともに handleSearchInput を呼ばない）", () => {
    const h = makeHarness();
    for (const mode of [SearchMode.NAV, SearchMode.INACTIVE]) {
      h.state.searchMode = mode;
      h.term("a");
      h.input("b");
    }
    expect(h.calls.searchInput).not.toHaveBeenCalled();
  });

  it("複数文字のペーストブロック：チャネル2は単バイトを個別に消費、非 CSI の複数バイトも消費", () => {
    const h = makeHarness();
    expect(h.input("abc")).toEqual({ consume: true });
    expect(h.input("\x02\x05")).toEqual({ consume: true });
  });

  it("ヘルプ+ダイアログ共存：ヘルプは論理的に最前面 — esc でヘルプを閉じ、その他のキーは全て受け止めてパススルーしない", () => {
    const h = makeHarness();
    h.state.helpOpen = true;
    h.state.dialogOpen = true;
    // esc → ヘルプを閉じる（消費）、ダイアログには触れずリーディングも終了しない
    expect(h.term("\x1b")).toEqual({ consume: true });
    expect(h.state.helpOpen).toBe(false);
    expect(h.calls.handleEsc).not.toHaveBeenCalled();
    expect(h.calls.toggle).not.toHaveBeenCalled();
    // ヘルプは閉じたがダイアログはまだある：再度 esc をダイアログへパススルー（リーディングは終了しない）
    expect(h.term("\x1b")).toBeUndefined();
    expect(h.calls.toggle).not.toHaveBeenCalled();
    // 共存期間：j/enter などはヘルプ層で受け止め（見えないダイアログへは漏らさない）、toggle も同様に消費される
    h.state.helpOpen = true;
    expect(h.term("j")).toEqual({ consume: true });
    expect(h.term("\r")).toEqual({ consume: true });
    expect(h.term("\x1bo")).toEqual({ consume: true });
    expect(h.calls.toggle).not.toHaveBeenCalled();
  });

  it("ヘルプ+ダイアログ共存はチャネル1のみがキーを受け止める；チャネル2は全てパススルー（チャネル1の消費で担保）", () => {
    const h = makeHarness();
    h.state.helpOpen = true;
    h.state.dialogOpen = true;
    expect(h.input("\x1b")).toBeUndefined();
  });
});

describe("hasActiveSearch", () => {
  it("activeSearch 存在判定、例外時は false にフォールバック", () => {
    expect(hasActiveSearch({ activeSearch: { query: "x" } })).toBe(true);
    expect(hasActiveSearch({})).toBe(false);
    expect(hasActiveSearch(null)).toBe(false);
  });
});

describe("isForeignFocus（dialogOpen 判定本体、fake tui に focusedComponent を注入）", () => {
  const editor = { id: "reader-editor" };
  const help = { id: "help-overlay" };
  const searchComp = { id: "search-input" };
  const own = { editor, help, searchComponent: searchComp };

  it("フォーカスが空（undefined/null）→ false（判定不能時はどのキーもインターセプトしない）", () => {
    expect(isForeignFocus(undefined, own)).toBe(false);
    expect(isForeignFocus(null, own)).toBe(false);
  });

  it("フォーカスが reader エディタ → false（ベースの正常状態）", () => {
    expect(isForeignFocus(editor, own)).toBe(false);
  });

  it("三重除外：ヘルプ overlay / 検索入力コンポーネント → false", () => {
    expect(isForeignFocus(help, own)).toBe(false);
    expect(isForeignFocus(searchComp, own)).toBe(false);
  });

  it("フォーカスが外部コンポーネント（拡張ダイアログ/入力ボックスなどの奪取シーン）→ true", () => {
    expect(isForeignFocus({ id: "extension-selector" }, own)).toBe(true);
    // 連鎖ダイアログでコンポーネントを切り替えた後も依然として外部コンポーネント（select → input の同層切替）
    expect(isForeignFocus({ id: "extension-input" }, own)).toBe(true);
  });

  it("参照比較であり構造比較ではない：同形オブジェクトは不一致とする；免除フィールド未指定時も同様に有効", () => {
    expect(isForeignFocus({ id: "reader-editor" }, own)).toBe(true); // 構造は同じだが参照が異なる
    expect(isForeignFocus(help, {})).toBe(true); // 免除が未登録の場合は外部とみなす
    expect(isForeignFocus(searchComp, { editor })).toBe(true);
  });
});
