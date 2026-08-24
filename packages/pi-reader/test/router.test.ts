import { describe, it, expect, vi } from "vitest";
import {
  createReadingKeyRouter,
  hasActiveSearch,
  isForeignFocus,
  SearchMode,
  type ReadingRouterIO,
} from "../src/index.ts";

/**
 * 双渠道共用路由单测：依赖注入 fake tui 与可控状态。
 * 注意：不构造带 extensionSelector 的假对象——真实运行时该私有字段恒不可达，
 * 弹窗探测走 focusedComponent 引用比对，fake 只需提供可切换的 dialogOpen()。
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

describe("router: 外部弹窗夺焦期间（dialogOpen=true）", () => {
  it("渠道 1：Enter/j/CSI Down/SSU Down/?/esc 全量透传（返回 undefined）", () => {
    const h = makeHarness();
    h.state.dialogOpen = true;
    for (const d of ["\r", "j", "k", "\x1b[B", "\x1bOB", "?", "\x1b"]) {
      expect(h.term(d)).toBeUndefined();
    }
    // 未产生任何阅读副作用
    expect(h.calls.toggle).not.toHaveBeenCalled();
    expect(h.calls.handleEsc).not.toHaveBeenCalled();
    expect(h.calls.showHelp).not.toHaveBeenCalled();
    expect(h.tui.scrollBy).not.toHaveBeenCalled();
  });

  it("渠道 1：toggle 键被消费屏蔽，但不翻转 isReading、不触发任何 UI 切换（防 Bug B）", () => {
    const h = makeHarness();
    h.state.dialogOpen = true;
    // VITEST 下 toggle 固定 alt+o
    expect(h.term("\x1bo")).toEqual({ consume: true });
    expect(h.calls.toggle).not.toHaveBeenCalled();
    expect(h.state.isReading).toBe(true);
    // Kitty 协议序列同样屏蔽
    expect(h.term("\u001b[111;3u")).toEqual({ consume: true });
    expect(h.calls.toggle).not.toHaveBeenCalled();
  });

  it("渠道 2：toggle 键也全量透传（让渡渠道 1，不本地消费）", () => {
    const h = makeHarness();
    h.state.dialogOpen = true;
    expect(h.input("\x1bo")).toBeUndefined();
    expect(h.calls.toggle).not.toHaveBeenCalled();
  });

  it("渠道 2：SEARCH_INPUT 态下字符同样透传给弹窗（守卫优先于搜索态）", () => {
    const h = makeHarness();
    h.state.dialogOpen = true;
    h.state.searchMode = SearchMode.INPUT;
    for (const d of ["a", "\r", "\x1bOB"]) {
      expect(h.input(d)).toBeUndefined();
    }
    expect(h.calls.searchInput).not.toHaveBeenCalled();
  });
});

describe("router: 无弹窗正常路径（回归）", () => {
  it("渠道 1：toggle 正常切换且消费", () => {
    const h = makeHarness();
    expect(h.term("\x1bo")).toEqual({ consume: true });
    expect(h.calls.toggle).toHaveBeenCalledTimes(1);
    expect(h.state.isReading).toBe(false);
  });

  it("渠道 2：toggle 让渡渠道 1（返回 undefined，不重复切换）", () => {
    const h = makeHarness();
    expect(h.input("\x1bo")).toBeUndefined();
    expect(h.calls.toggle).not.toHaveBeenCalled();
  });

  it("READING 下 j/k 行级滚动 + count 前缀生效", () => {
    const h = makeHarness({ countPeek: () => 5 });
    expect(h.term("j")).toEqual({ consume: true });
    expect(h.tui.scrollBy).toHaveBeenLastCalledWith(5);
    expect(h.input("k")).toEqual({ consume: true });
    expect(h.tui.scrollBy).toHaveBeenLastCalledWith(-5);
  });

  it("§3.3：application cursor keys 的 SSU 方向键序列透传（\\x1bO 前缀）", () => {
    const h = makeHarness();
    // Down/Up 在 application cursor keys 模式为 \x1bOB/\x1bOA，应透传给焦点组件而非被吞
    expect(h.term("\x1bOB")).toBeUndefined();
    expect(h.term("\x1bOA")).toBeUndefined();
    // CSI 序列照旧透传
    expect(h.term("\x1b[B")).toBeUndefined();
    // 多字节非 CSI/SSU 序列仍消费，避免泄漏进核心
    expect(h.term("\x1bz")).toEqual({ consume: true });
  });

  it("编辑态（isReading=false）：导航键不消费、不滚动", () => {
    const h = makeHarness();
    h.state.isReading = false;
    expect(h.term("j")).toBeUndefined(); // 渠道 1 非阅读态只关心 toggle
    expect(h.input("j")).toBeUndefined(); // 渠道 2 非阅读态透传
    expect(h.tui.scrollBy).not.toHaveBeenCalled();
  });

  it("?：渠道 2 让渡，渠道 1 打开帮助并消费；helpOpen 时两渠道早退", () => {
    const h = makeHarness();
    expect(h.input("?")).toBeUndefined();
    expect(h.calls.showHelp).not.toHaveBeenCalled();
    expect(h.term("?")).toEqual({ consume: true });
    expect(h.calls.showHelp).toHaveBeenCalledTimes(1);
    h.state.helpOpen = true;
    expect(h.term("?")).toBeUndefined();
    expect(h.input("?")).toBeUndefined();
  });

  it("esc 二义：无搜索时经 handleEsc 走退出；i 在 NAV 态先清搜索留在 READING", () => {
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

  it("SEARCH_INPUT：两渠道全量交给 handleSearchInput；未消费则透传", () => {
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

  it("gg 同批连发直达顶部；单个 g 等待双击仅消费不滚动", () => {
    const h = makeHarness();
    expect(h.term("gg")).toEqual({ consume: true });
    expect(h.tui.scrollToTop).toHaveBeenCalledTimes(1);
    expect(h.term("g")).toEqual({ consume: true });
    expect(h.tui.scrollToTop).toHaveBeenCalledTimes(1);
  });

  it("G 底部 / ctrl-u 半页", () => {
    const h = makeHarness();
    expect(h.term("G")).toEqual({ consume: true });
    expect(h.tui.scrollToBottom).toHaveBeenCalledTimes(1);
    expect(h.term("\x15")).toEqual({ consume: true }); // ctrl+u，vh=20 → half=10
    expect(h.tui.scrollBy).toHaveBeenLastCalledWith(-10);
  });

  it("去重命中：直接消费且不再触发滚动/语义导航", () => {
    const h = makeHarness({ isDuplicateNav: () => true });
    expect(h.term("j")).toEqual({ consume: true });
    expect(h.tui.scrollBy).not.toHaveBeenCalled();
    expect(h.calls.semanticNav).not.toHaveBeenCalled();
  });

  it("app.tools.expand 命中：触发工具展开并消费", () => {
    const h = makeHarness({ matchesExpand: (d) => d === "\x0f" });
    expect(h.term("\x0f")).toEqual({ consume: true });
    expect(h.calls.expand).toHaveBeenCalledTimes(1);
  });

  it("语义导航命中即消费", () => {
    const semNav = vi.fn((d: string) => d === "/");
    const h = makeHarness({ trySemanticNav: semNav });
    expect(h.term("/")).toEqual({ consume: true });
    expect(semNav).toHaveBeenCalledWith("/", h.tui);
    expect(h.term("x")).toEqual({ consume: true }); // 未命中落入 other 分支仍消费
    expect(h.tui.scrollBy).not.toHaveBeenCalled();
  });

  it("非 INPUT 态不进入搜索处理分支（NAV/INACTIVE 均不调 handleSearchInput）", () => {
    const h = makeHarness();
    for (const mode of [SearchMode.NAV, SearchMode.INACTIVE]) {
      h.state.searchMode = mode;
      h.term("a");
      h.input("b");
    }
    expect(h.calls.searchInput).not.toHaveBeenCalled();
  });

  it("多字符粘贴块：渠道 2 单字节逐个消费，非 CSI 多字节消费", () => {
    const h = makeHarness();
    expect(h.input("abc")).toEqual({ consume: true });
    expect(h.input("\x02\x05")).toEqual({ consume: true });
  });

  it("帮助+弹窗并存：帮助逻辑上也在最上——esc 关帮助，其余键全部承接不透传", () => {
    const h = makeHarness();
    h.state.helpOpen = true;
    h.state.dialogOpen = true;
    // esc → 关帮助（消费），不触碰弹窗、不退阅读
    expect(h.term("\x1b")).toEqual({ consume: true });
    expect(h.state.helpOpen).toBe(false);
    expect(h.calls.handleEsc).not.toHaveBeenCalled();
    expect(h.calls.toggle).not.toHaveBeenCalled();
    // 帮助已关、弹窗仍在：再按 esc 透传给弹窗（不退阅读）
    expect(h.term("\x1b")).toBeUndefined();
    expect(h.calls.toggle).not.toHaveBeenCalled();
    // 并存期间：j/enter 等被帮助层承接（不下漏到看不见的弹窗），toggle 同样被吞
    h.state.helpOpen = true;
    expect(h.term("j")).toEqual({ consume: true });
    expect(h.term("\r")).toEqual({ consume: true });
    expect(h.term("\x1bo")).toEqual({ consume: true });
    expect(h.calls.toggle).not.toHaveBeenCalled();
  });

  it("帮助+弹窗并存仅限渠道 1 承接按键；渠道 2 全量透传（由渠道 1 消费兜底）", () => {
    const h = makeHarness();
    h.state.helpOpen = true;
    h.state.dialogOpen = true;
    expect(h.input("\x1b")).toBeUndefined();
  });
});

describe("hasActiveSearch", () => {
  it("activeSearch 存在判定，异常降级 false", () => {
    expect(hasActiveSearch({ activeSearch: { query: "x" } })).toBe(true);
    expect(hasActiveSearch({})).toBe(false);
    expect(hasActiveSearch(null)).toBe(false);
  });
});

describe("isForeignFocus（dialogOpen 判定本体，fake tui 注入 focusedComponent）", () => {
  const editor = { id: "reader-editor" };
  const help = { id: "help-overlay" };
  const searchComp = { id: "search-input" };
  const own = { editor, help, searchComponent: searchComp };

  it("焦点为空（undefined/null）→ false（无法判定时不拦截任何键）", () => {
    expect(isForeignFocus(undefined, own)).toBe(false);
    expect(isForeignFocus(null, own)).toBe(false);
  });

  it("焦点是 reader 编辑器 → false（基层正常态）", () => {
    expect(isForeignFocus(editor, own)).toBe(false);
  });

  it("三重豁免：帮助 overlay / 搜索输入组件 → false", () => {
    expect(isForeignFocus(help, own)).toBe(false);
    expect(isForeignFocus(searchComp, own)).toBe(false);
  });

  it("焦点是外部组件（扩展弹窗/输入框等夺焦场景）→ true", () => {
    expect(isForeignFocus({ id: "extension-selector" }, own)).toBe(true);
    // 链式弹窗换组件后仍是外部组件（select → input 同层切换）
    expect(isForeignFocus({ id: "extension-input" }, own)).toBe(true);
  });

  it("引用比对而非结构比对：同形对象不相等；豁免字段缺省时同样生效", () => {
    expect(isForeignFocus({ id: "reader-editor" }, own)).toBe(true); // 结构相同但引用不同
    expect(isForeignFocus(help, {})).toBe(true); // 未登记豁免则视为外部
    expect(isForeignFocus(searchComp, { editor })).toBe(true);
  });
});
