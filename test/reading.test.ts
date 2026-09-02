import { describe, it, expect, vi } from "vitest";
import {
  GgSequence,
  BracketSequence,
  CountBuffer,
  halfPage,
  pageStep,
  parseReadingKey,
  getAnchorOffset,
  computeTargetScrollTop,
  isRowVisible,
  findPromptRows,
  findToolRows,
  findAnswerRows,
  findParagraphBounds,
  getViewportState,
  captureAnchor,
  computeRestoreRow,
  ScrollRestoreMonitor,
  isAutoExpandToolsEnabled,
  __resetNavConfigCacheForTest,
} from "../src/index.ts";

describe("pi-input-lock: ビューポートステップ", () => {
  it("half = floor(vh/2)（TuiAltScreen と一致）", () => {
    expect(halfPage(20)).toBe(10);
    expect(halfPage(17)).toBe(8);
    expect(halfPage(1)).toBe(1);
    expect(halfPage(0)).toBe(1);
  });
  it("page = vh-1（OVERLAP=1、TuiAltScreen と一致）", () => {
    expect(pageStep(20)).toBe(19);
    expect(pageStep(17)).toBe(16);
    expect(pageStep(1)).toBe(1);
  });
});

describe("pi-input-lock: parseReadingKey キー分類", () => {
  it("toggle=alt+o（デフォルト、従来/Kitty）", () => {
    expect(parseReadingKey("\x1bo")).toBe("toggle");
    expect(parseReadingKey("\u001b[111;3u")).toBe("toggle");
  });
  it("半ページ ctrl-u/d", () => {
    expect(parseReadingKey("\x15")).toBe("halfUp");
    expect(parseReadingKey("\u001b[117;5u")).toBe("halfUp");
    expect(parseReadingKey("\x04")).toBe("halfDown");
    expect(parseReadingKey("\u001b[100;5u")).toBe("halfDown");
  });
  it("全ページ ctrl-f/b", () => {
    expect(parseReadingKey("\x06")).toBe("pageDown");
    expect(parseReadingKey("\u001b[102;5u")).toBe("pageDown");
    expect(parseReadingKey("\x02")).toBe("pageUp");
    expect(parseReadingKey("\u001b[98;5u")).toBe("pageUp");
  });
  it("行単位 ctrl-p/n, j/k", () => {
    expect(parseReadingKey("\x10")).toBe("lineUp");
    expect(parseReadingKey("\u001b[112;5u")).toBe("lineUp");
    expect(parseReadingKey("k")).toBe("lineUp");
    expect(parseReadingKey("\x0e")).toBe("lineDown");
    expect(parseReadingKey("j")).toBe("lineDown");
  });
  it("先頭/末尾 G と g（同バッチ連発 gg を含む）", () => {
    expect(parseReadingKey("G")).toBe("bottom");
    expect(parseReadingKey("g")).toBe("top");
    expect(parseReadingKey("gg")).toBe("top"); // 端末の同ブロックで到達した gg もダブルクリックとみなす
  });
  it("終了 esc/i/ctrl+c", () => {
    expect(parseReadingKey("\u001b")).toBe("exit");
    expect(parseReadingKey("i")).toBe("exit");
    expect(parseReadingKey("\x03")).toBe("exit");
  });
  it("? ヘルプ", () => {
    expect(parseReadingKey("?")).toBe("help");
  });
  it("その他印字可能/制御は other", () => {
    expect(parseReadingKey("a")).toBe("other");
    expect(parseReadingKey(" ")).toBe("other");
    expect(parseReadingKey("\x7f")).toBe("other");
  });
});

describe("pi-input-lock: gg 500ms ダブルクリック", () => {
  it("単一 g は発火せず、500ms 以内の二重 g で発火", () => {
    vi.useFakeTimers();
    const gg = new GgSequence(500);
    const t = 1000;
    expect(gg.press(t)).toBe(false);      // 初回 g
    expect(gg.press(t + 300)).toBe(true); // 500ms 以内の2回目 → gg
    vi.useRealTimers();
  });
  it("500ms 超過でリセット、再ダブルクリックが必要", () => {
    vi.useFakeTimers();
    const gg = new GgSequence(500);
    const t = 1000;
    expect(gg.press(t)).toBe(false);
    expect(gg.press(t + 600)).toBe(false); // ウィンドウ外、単なる新しい初回押下として扱う
    expect(gg.press(t + 700)).toBe(true);  // すぐに再押下 → ダブルクリック
    vi.useRealTimers();
  });
  it("reset クリア", () => {
    vi.useFakeTimers();
    const gg = new GgSequence(500);
    expect(gg.press(1000)).toBe(false);
    gg.reset();
    expect(gg.press(1200)).toBe(false); // reset 後はヒットが継続しない
    vi.useRealTimers();
  });
});

describe("pi-input-lock: CountBuffer", () => {
  it("1-9 蓄積、0 の先行は無視", () => {
    vi.useFakeTimers();
    const cb = new CountBuffer(800);
    expect(cb.push("0")).toBe(false);
    expect(cb.hasValue()).toBe(false);
    expect(cb.push("1")).toBe(true);
    expect(cb.push("2")).toBe(true);
    expect(cb.peek()).toBe(12);
    expect(cb.consume()).toBe(12);
    expect(cb.hasValue()).toBe(false);
    vi.useRealTimers();
  });
  it("0 は既存 buffer がある場合のみ追加", () => {
    const cb = new CountBuffer(800);
    cb.push("1");
    expect(cb.push("0")).toBe(true);
    expect(cb.consume()).toBe(10);
  });
  it("800ms タイムアウトでクリア", () => {
    vi.useFakeTimers();
    const cb = new CountBuffer(800);
    cb.push("5");
    vi.advanceTimersByTime(900);
    expect(cb.hasValue()).toBe(false);
    expect(cb.consume()).toBe(undefined);
    vi.useRealTimers();
  });
  it("consume 後にリセット", () => {
    const cb = new CountBuffer(800);
    cb.push("3");
    expect(cb.consume()).toBe(3);
    expect(cb.peek()).toBe(undefined);
  });
});

describe("pi-input-lock: BracketSequence", () => {
  it("[q ]q ヒット", () => {
    vi.useFakeTimers();
    const bs = new BracketSequence(500);
    expect(bs.push("[")).toBe("pending");
    expect(bs.push("q")).toBe("prevQ");
    expect(bs.push("]")).toBe("pending");
    expect(bs.push("q")).toBe("nextQ");
    vi.useRealTimers();
  });
  it("[a ]a [t ]t", () => {
    const bs = new BracketSequence(500);
    expect(bs.push("[")).toBe("pending");
    expect(bs.push("a")).toBe("prevA");
    expect(bs.push("]")).toBe("pending");
    expect(bs.push("t")).toBe("nextT");
  });
  it("タイムアウトでクリア", () => {
    vi.useFakeTimers();
    const bs = new BracketSequence(500);
    expect(bs.push("[")).toBe("pending");
    vi.advanceTimersByTime(600);
    expect(bs.push("q")).toBe(null);
    vi.useRealTimers();
  });
  it("非 q/a/t は pending をクリア", () => {
    const bs = new BracketSequence(500);
    expect(bs.push("[")).toBe("pending");
    expect(bs.push("x")).toBe(null);
    expect(bs.push("q")).toBe(null);
  });
});

describe("pi-input-lock: getAnchorOffset", () => {
  it("pinTop=1", () => { expect(getAnchorOffset(20, "pinTop")).toBe(1); });
  it("third=floor(vh/3)", () => { expect(getAnchorOffset(20, "third")).toBe(6); expect(getAnchorOffset(17, "third")).toBe(5); });
  it("center=floor(vh/2)", () => { expect(getAnchorOffset(20, "center")).toBe(10); });
  it("number clamp", () => {
    expect(getAnchorOffset(20, 5)).toBe(5);
    expect(getAnchorOffset(20, 100)).toBe(19);
    expect(getAnchorOffset(20, -3)).toBe(0);
  });
});

describe("pi-input-lock: isRowVisible", () => {
  it("可視範囲", () => {
    expect(isRowVisible(5, 0, 20)).toBe(true);
    expect(isRowVisible(17, 0, 20)).toBe(true); // 20-1-2 =17 可见
    expect(isRowVisible(18, 0, 20)).toBe(false); // 贴底 2 行不可见
    expect(isRowVisible(0, 0, 20)).toBe(true);
    expect(isRowVisible(25, 10, 20)).toBe(true);
  });
});

describe("pi-input-lock: computeTargetScrollTop", () => {
  it("可視 + keep => null", () => {
    expect(computeTargetScrollTop(5, 0, 20, 100, "pinTop", "keep")).toBe(null);
  });
  it("可視 + reanchor => スクロール", () => {
    expect(computeTargetScrollTop(5, 0, 20, 100, "pinTop", "reanchor")).toBe(4);
  });
  it("非可視 => offset を計算", () => {
    // target 30, scrollTop 0, vh20, pinTop1 => 29
    expect(computeTargetScrollTop(30, 0, 20, 100, "pinTop", "keep")).toBe(29);
    expect(computeTargetScrollTop(30, 0, 20, 100, "third", "keep")).toBe(24);
  });
  it("maxTop に clamp", () => {
    expect(computeTargetScrollTop(200, 0, 20, 50, "pinTop", "keep")).toBe(50);
    expect(computeTargetScrollTop(5, 0, 20, 50, 100, "reanchor")).toBe(0);
    expect(computeTargetScrollTop(5, 0, 20, 100, 100, "keep")).toBe(null);
  });
});

describe("pi-input-lock: findPromptRows", () => {
  it("OSC133;A をスキャン", () => {
    const lines = ["a", "\x1b]133;A\x07prompt", "b", "\x1b]133;A\x1b\\prompt2", "c"];
    expect(findPromptRows(lines)).toEqual([1, 3]);
  });
  it("空配列", () => { expect(findPromptRows([])).toEqual([]); });
});

describe("pi-input-lock: findToolRows", () => {
  it("ヒューリスティックなツールヘッダ", () => {
    const lines = ["\x1b[31m▌ bash · ls\x1b[0m", "normal", "⎿ result", "  read file", "● tool"];
    const rows = findToolRows(lines);
    expect(rows).toContain(0);
    expect(rows).toContain(2);
    expect(rows).toContain(4);
  });
});

describe("pi-input-lock: findAnswerRows", () => {
  it("prompt 直後の最初の非空", () => {
    const lines = ["\x1b]133;A\x07", "", "  answer line", "other", "\x1b]133;A\x07", "next answer"];
    expect(findAnswerRows(lines)).toEqual([2, 5]);
  });
});

describe("pi-input-lock: findParagraphBounds", () => {
  it("} で次の段落先頭を検索", () => {
    const lines = ["para1 line1", "para1 line2", "", "para2 line1", "para2 line2", "", "para3 line1"];
    expect(findParagraphBounds(lines, 0, 1)).toBe(3);
    expect(findParagraphBounds(lines, 3, 1)).toBe(6);
    expect(findParagraphBounds(lines, 6, 1)).toBe(null);
  });
  it("{ で前の段落先頭を検索", () => {
    const lines = ["para1 line1", "para1 line2", "", "para2 line1", "para2 line2", "", "para3 line1"];
    expect(findParagraphBounds(lines, 6, -1)).toBe(3);
    expect(findParagraphBounds(lines, 3, -1)).toBe(0);
    expect(findParagraphBounds(lines, 0, -1)).toBe(null);
  });
  it("連続空行をマージ", () => {
    const lines = ["a", "", "", "b", "", "c"];
    expect(findParagraphBounds(lines, 0, 1)).toBe(3);
    expect(findParagraphBounds(lines, 3, 1)).toBe(5);
  });
  it("区切り線 ─ を境界とみなす", () => {
    const lines = ["para1", "───", "para2", "", "para3"];
    expect(findParagraphBounds(lines, 0, 1)).toBe(2);
    expect(findParagraphBounds(lines, 2, 1)).toBe(4);
    expect(findParagraphBounds(lines, 4, -1)).toBe(2);
  });
});

describe("pi-input-lock: getViewportState", () => {
  it("フォールバックで 20 を返す", () => {
    const vs = getViewportState(null);
    expect(vs.vh).toBe(20);
    expect(vs.scrollTop).toBe(0);
  });
  it("tui から読み取り", () => {
    const tui: any = {
      currentLayout: { primaryScrollView: { viewportHeight: 30, scrollTop: 10 } },
      getPrimaryScrollView: () => ({ viewportHeight: 30, scrollTop: 10 }),
    };
    const vs = getViewportState(tui);
    expect(vs.vh).toBe(30);
    expect(vs.scrollTop).toBe(10);
  });
});

// ---------- スクロールアンカー（plan §4/§5） ----------

const PROMPT = "\x1b]133;A\x07";

/** 転写行を構築：prefixRows 行のヘッダ、その後各セグメントは prompt 行で開始、segments[i]-1 行の本文 */
function buildLines(segments: number[], prefixRows = 2): string[] {
  const lines: string[] = [];
  for (let i = 0; i < prefixRows; i++) lines.push(`head${i}`);
  for (let s = 0; s < segments.length; s++) {
    lines.push(`${PROMPT}q${s}`);
    const len = segments[s] ?? 0;
    for (let r = 1; r < len; r++) lines.push(`${s}-${r}`);
  }
  return lines;
}

describe("pi-input-lock: captureAnchor", () => {
  // A: prompt 行号 [2, 10, 30]，总 42 行
  const linesA = buildLines([8, 20, 12]);
  it("prompt 番号 + セグメント内オフセット + 総数を記録", () => {
    expect(captureAnchor(linesA, 12)).toEqual({ k: 1, d: 2, count: 3 });
    expect(captureAnchor(linesA, 35)).toEqual({ k: 2, d: 5, count: 3 });
  });
  it("顶行位于首个 prompt 之前 → k=-1", () => {
    expect(captureAnchor(linesA, 1)).toEqual({ k: -1, d: 1, count: 3 });
  });
  it("空行数组 / 无 prompt / 非法 scrollTop → null", () => {
    expect(captureAnchor([], 0)).toBe(null);
    expect(captureAnchor(null, 0)).toBe(null);
    expect(captureAnchor(["a", "b"], 0)).toBe(null);
    expect(captureAnchor(linesA, -1)).toBe(null);
  });
});

describe("pi-input-lock: computeRestoreRow（統一 clamp モデル）", () => {
  const linesA = buildLines([8, 20, 12]); // prompt [2,10,30]，42 行
  it("往返一致：同构文档精确还原", () => {
    const anchor = captureAnchor(linesA, 12)!;
    expect(computeRestoreRow(linesA, anchor, 20)).toBe(12);
  });
  it("段收缩 → d 截断到所在段内（退到收拢块）", () => {
    // B: prompt [2,10,15]、27 行；元 k=1,d=8 は収縮後のセグメント（rows 10..14）を超える
    const linesB = buildLines([8, 5, 12]);
    const anchor = captureAnchor(linesA, 18)!; // k=1, d=8
    expect(computeRestoreRow(linesB, anchor, 5)).toBe(14); // 段尾；vh=5 使 maxTop=22 不干扰
  });
  it("下方不够 → 贴底 clamp（目标仍在最后一屏内）", () => {
    const linesB = buildLines([8, 5, 12]); // 27 行，vh=20 → maxTop=7
    const anchor = captureAnchor(linesA, 35)!; // k=2, d=5 → 理想目标 20 > maxTop
    expect(computeRestoreRow(linesB, anchor, 20)).toBe(7);
  });
  it("不足一屏 → 从顶渲染（maxTop=0）", () => {
    const tiny = buildLines([3, 3, 3]); // 11 行 < vh=20
    const anchor = captureAnchor(linesA, 31)!; // k=2, d=1
    expect(computeRestoreRow(tiny, anchor, 20)).toBe(0);
  });
  it("k=-1 头部区域恢复", () => {
    // 十分に大きなドキュメントで「1画面に満たない」分岐の干渉を避ける：32 行、vh=20 → maxTop=12
    const anchor = captureAnchor(linesA, 1)!; // k=-1, d=1
    expect(computeRestoreRow(buildLines([10, 10, 10]), anchor, 20)).toBe(1);
  });
  it("prompt 总数变化 → O(1) 校验放弃", () => {
    const fewer = buildLines([8, 20]); // 2 个 prompt ≠ 3
    const anchor = captureAnchor(linesA, 12)!;
    expect(computeRestoreRow(fewer, anchor, 20)).toBe(null);
    expect(computeRestoreRow([], anchor, 20)).toBe(null);
  });
});

describe("pi-input-lock: ScrollRestoreMonitor", () => {
  it("帧换代 + 高度连续两个新帧相同 → 触发一次恢复", () => {
    vi.useFakeTimers();
    let frame: object = {};
    let height = 100;
    let fired = 0;
    const m = new ScrollRestoreMonitor({
      generation: 1,
      getGeneration: () => 1,
      getFrame: () => frame,
      getContentHeight: () => height,
      onRestore: () => { fired += 1; },
    });
    m.start();
    vi.advanceTimersByTime(16); // tick1：帧未变 → 等
    expect(fired).toBe(0);
    frame = {}; height = 500;
    vi.advanceTimersByTime(16); // tick2：新帧，采样 500
    expect(fired).toBe(0);
    vi.advanceTimersByTime(16); // tick3：帧未变 → 等
    expect(fired).toBe(0);
    frame = {};
    vi.advanceTimersByTime(16); // tick4：新帧且高度仍 500 → 稳定触发
    expect(fired).toBe(1);
    vi.advanceTimersByTime(200);
    expect(fired).toBe(1); // 至多一次
    m.stop();
    vi.useRealTimers();
  });
  it("generation 变化 → 立即放弃", () => {
    vi.useFakeTimers();
    let gen = 1;
    let fired = 0;
    const m = new ScrollRestoreMonitor({
      generation: 1,
      getGeneration: () => gen,
      getFrame: () => ({}),
      getContentHeight: () => 50,
      onRestore: () => { fired += 1; },
    });
    m.start();
    gen = 2;
    for (let i = 0; i < 5; i++) {
      gen = 2 + i;
      vi.advanceTimersByTime(16);
    }
    expect(fired).toBe(0);
    vi.useRealTimers();
  });
  it("高度持续变化不触发，超限后放弃", () => {
    vi.useFakeTimers();
    let frame: object = {};
    let height = 0;
    let fired = 0;
    const m = new ScrollRestoreMonitor({
      generation: 1,
      getGeneration: () => 1,
      getFrame: () => frame,
      getContentHeight: () => height,
      onRestore: () => { fired += 1; },
    });
    m.start();
    for (let i = 0; i < 25; i++) {
      frame = {}; // 每次换代
      height += 10; // 高度持续不同
      vi.advanceTimersByTime(16);
    }
    expect(fired).toBe(0); // 超 20 tick 上限后已停止
    m.stop();
    vi.useRealTimers();
  });
  it("stop() 中止后不再触发", () => {
    vi.useFakeTimers();
    let frame: object = {};
    let fired = 0;
    const m = new ScrollRestoreMonitor({
      generation: 1,
      getGeneration: () => 1,
      getFrame: () => frame,
      getContentHeight: () => 42,
      onRestore: () => { fired += 1; },
    });
    m.start();
    frame = {};
    vi.advanceTimersByTime(16); // 采样 42
    frame = {};
    m.stop(); // 在稳定判定前中止
    vi.advanceTimersByTime(500);
    expect(fired).toBe(0);
    vi.useRealTimers();
  });
});

describe("pi-input-lock: isAutoExpandToolsEnabled（デフォルト値フォールバック）", () => {
  it("VITEST 空配置下默认 false（工具状态保持不动，位置天然无损）", () => {
    __resetNavConfigCacheForTest();
    expect(isAutoExpandToolsEnabled()).toBe(false);
  });
});

describe("pi-input-lock: 要件 B 前置切り詰めセマンティクス（parse 層でテスト可能な部分）", () => {
  it("?/esc/i/ctrl+c 被前置分类，永远不会落入 expand 槽位", () => {
    expect(parseReadingKey("?")).toBe("help");
    expect(parseReadingKey("\u001b")).toBe("exit");
    expect(parseReadingKey("i")).toBe("exit");
    expect(parseReadingKey("\x03")).toBe("exit");
  });
  it("ctrl+o（\\x0f，核心默认 expand 键）分类为 other，可到达 expand 分支", () => {
    // VITEST 下默认 toggleKey 为 alt+o，ctrl+o 不是 toggle，落入 other 后由 expand 分支处理
    expect(parseReadingKey("\x0f")).toBe("other");
  });
});
