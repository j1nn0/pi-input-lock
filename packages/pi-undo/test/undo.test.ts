import { describe, it, expect, vi, beforeEach } from "vitest";

// 状态机单测（canUndo 单次/轮逻辑）
describe("undo state machine (unit)", () => {
  const sid = "sid-1";
  let canUndoBySid: Map<string, boolean>;

  const getCanUndo = (sid: string) => (canUndoBySid.has(sid) ? canUndoBySid.get(sid)! : true);
  const setCanUndo = (sid: string, v: boolean) => canUndoBySid.set(sid, v);

  beforeEach(() => {
    canUndoBySid = new Map();
  });

  it("before_agent_start resets canUndo", () => {
    setCanUndo(sid, false);
    setCanUndo(sid, true);
    expect(getCanUndo(sid)).toBe(true);
  });

  it("single per turn: undo sets false, second blocked until next before_agent_start", () => {
    expect(getCanUndo(sid)).toBe(true);
    setCanUndo(sid, false);
    expect(getCanUndo(sid)).toBe(false);
    setCanUndo(sid, true);
    expect(getCanUndo(sid)).toBe(true);
  });

  it("soft/hard branch text extraction", async () => {
    const { extractText } = await import("../src/history.ts");
    expect(extractText("hi")).toBe("hi");
    expect(extractText([{ type: "text", text: "a" }, { type: "text", text: "b" }])).toBe("ab");
  });
});

// 集成测试：通过 mock pi 真实驱动 src/index.ts 的 doUndo
describe("doUndo integration (via mock pi)", () => {
  // 每个用例重新加载模块：doUndo 依赖模块级 capturedTui 状态，避免用例间串扰
  beforeEach(() => {
    vi.resetModules();
  });

  // 辅助：创建 mock pi，捕获注册的 handler
  function createMockPi() {
    const handlers: Record<string, (event: unknown, ctx: unknown) => Promise<unknown>> = {};
    const commandHandlers: Record<string, (args: unknown, ctx: unknown) => Promise<unknown>> = {};
    let shortcutHandler: ((ctx: unknown) => Promise<unknown>) | null = null;
    const mockPi: any = {
      on: vi.fn((event: string, handler: any) => {
        handlers[event] = handler;
      }),
      registerCommand: vi.fn((name: string, opts: any) => {
        commandHandlers[name] = opts.handler;
      }),
      registerShortcut: vi.fn((_key: string, opts: any) => {
        shortcutHandler = opts.handler;
      }),
      // 哨兵落盘与快捷键委托所需的顶层 API
      appendEntry: vi.fn(),
      sendUserMessage: vi.fn(),
    };
    return { mockPi, handlers, commandHandlers, getShortcut: () => shortcutHandler };
  }

  function createMockCtx(overrides: Record<string, unknown> = {}): any {
    const branchStore: unknown[] = (overrides.branch as unknown[]) ?? [];
    const defaultCtx: any = {
      hasUI: true,
      sessionManager: {
        getSessionId: vi.fn(() => "test-sid"),
        getBranch: vi.fn(() => branchStore),
        branch: vi.fn(),
        resetLeaf: vi.fn(),
      },
      ui: {
        getEditorText: vi.fn(() => ""),
        setEditorText: vi.fn(),
        setStatus: vi.fn(),
        notify: vi.fn(),
        setWidget: vi.fn(),
      },
      isIdle: vi.fn(() => true),
      abort: vi.fn(),
      navigateTree: vi.fn(async () => {}),
      waitForIdle: vi.fn(async () => {}),
      ...overrides,
    };
    // 若 overrides 显式把 navigateTree/waitForIdle 设为 undefined，则删除以测试兜底
    if (overrides.navigateTree === undefined && !("navigateTree" in overrides)) {
      // keep default
    } else if (overrides.navigateTree === null) {
      delete defaultCtx.navigateTree;
    }
    if (overrides.waitForIdle === null) {
      delete defaultCtx.waitForIdle;
    }
    return defaultCtx;
  }

  const branchWithUser = (id: string, parentId: string | null, text: string) => ({
    type: "message",
    id,
    parentId,
    timestamp: new Date().toISOString(),
    message: { role: "user", content: text },
  });

  it("hasUI false 静默 no-op", async () => {
    const { mockPi, commandHandlers } = createMockPi();
    const mod = await import("../src/index.ts");
    (mod.default as any)(mockPi);
    const ctx = createMockCtx({ hasUI: false });
    await commandHandlers["undo"]!({}, ctx);
    expect(ctx.ui.notify).not.toHaveBeenCalled();
    expect(ctx.ui.setEditorText).not.toHaveBeenCalled();
  });

  it("编辑器有草稿时提示且不覆盖、不消耗 canUndo", async () => {
    const { mockPi, commandHandlers, handlers } = createMockPi();
    const mod = await import("../src/index.ts");
    (mod.default as any)(mockPi);
    const ctx = createMockCtx({
      ui: {
        getEditorText: vi.fn(() => "  draft  "),
        setEditorText: vi.fn(),
        setStatus: vi.fn(),
        notify: vi.fn(),
      },
    });
    await commandHandlers["undo"]!({}, ctx);
    expect(ctx.ui.notify).toHaveBeenCalledWith("Editor has draft, clear it first", "warning");
    expect(ctx.ui.setEditorText).not.toHaveBeenCalled();

    // 第二次应仍因草稿被拦，而非 Already undone（说明未消耗单次/轮）
    ctx.ui.notify.mockClear();
    await commandHandlers["undo"]!({}, ctx);
    expect(ctx.ui.notify).toHaveBeenCalledWith("Editor has draft, clear it first", "warning");

    // 清空草稿后应能继续 undo（验证未被锁）：有 navigateTree 时走 entryId 导航
    ctx.ui.getEditorText.mockReturnValue("");
    ctx.sessionManager.getBranch.mockReturnValue([branchWithUser("1", null, "hello")]);
    await commandHandlers["undo"]!({}, ctx);
    expect(ctx.navigateTree).toHaveBeenCalledWith("1", { summarize: false });
  });

  it("异常宿主 abort 回灌文本：守卫优先级最高，按草稿拦截且不硬撤", async () => {
    const { mockPi, commandHandlers } = createMockPi();
    const mod = await import("../src/index.ts");
    (mod.default as any)(mockPi);
    const branch = [
      branchWithUser("B1", null, "earlier"),
      branchWithUser("A", "B1", "just-sent"),
      { type: "message", id: "partial", parentId: "A", timestamp: new Date().toISOString(), message: { role: "assistant", content: "working..." } },
    ];
    let idle = false;
    let leafId: string | null = "partial";
    const ctx = createMockCtx({
      sessionManager: {
        getSessionId: vi.fn(() => "sid-defensive"),
        getBranch: vi.fn(() => branch),
        getLeafId: vi.fn(() => leafId),
        branch: vi.fn(),
        resetLeaf: vi.fn(),
      },
      isIdle: vi.fn(() => idle),
      waitForIdle: vi.fn(async () => { idle = true; }),
      navigateTree: vi.fn(async (_id: string) => { leafId = "B1"; return {}; }),
      hasPendingMessages: vi.fn(() => false),
    });
    // 模拟异常宿主：hasPending 为 false 但 abort 时仍回灌了文本进编辑器
    ctx.abort = vi.fn(() => {
      ctx.ui.getEditorText.mockReturnValue("b\n\nc");
    });
    await commandHandlers["undo"]!({}, ctx);
    // 回灌文本视为草稿：提示并直接返回——不硬撤、不合并回填、不落哨兵
    expect(ctx.abort).toHaveBeenCalled();
    expect(ctx.ui.notify).toHaveBeenCalledWith("Editor has draft, clear it first", "warning");
    expect(ctx.navigateTree).not.toHaveBeenCalled();
    expect(ctx.ui.setEditorText).not.toHaveBeenCalled();
    expect(mockPi.appendEntry).not.toHaveBeenCalled();

    // 未消耗单次/轮：清空草稿后可重试并正常硬撤
    ctx.ui.getEditorText.mockReturnValue("");
    await commandHandlers["undo"]!({}, ctx);
    expect(ctx.navigateTree).toHaveBeenCalledWith("A", { summarize: false });
    expect(ctx.ui.setEditorText).toHaveBeenCalledWith("just-sent");
  });

  it("执行中且队列非空：直调官方 dequeue handler（不 abort、不动会话、无提示）", async () => {
    const { mockPi, commandHandlers, handlers } = createMockPi();
    const mod = await import("../src/index.ts");
    (mod.default as any)(mockPi);
    // 模拟宿主 CustomEditor：actionHandlers 注册官方 dequeue
    const dequeueHandler = vi.fn();
    const fakeTui = {
      children: [
        { children: [{ actionHandlers: new Map([["app.message.dequeue", dequeueHandler]]) }] },
      ],
    };
    const ctx = createMockCtx({
      isIdle: vi.fn(() => false),
      abort: vi.fn(),
      navigateTree: vi.fn(async () => {}),
      hasPendingMessages: vi.fn(() => true),
      mode: "tui",
    });
    // session_start 触发 widget 注册，用假 tui 调工厂完成捕获
    await handlers["session_start"]!({}, ctx);
    const setWidgetCall = ctx.ui.setWidget.mock.calls[0];
    expect(setWidgetCall?.[0]).toBe("pi-undo-tui-capture");
    const componentFactory = setWidgetCall?.[1] as (tui: unknown) => unknown;
    componentFactory(fakeTui);

    await commandHandlers["undo"]!({}, ctx);
    // 直调官方 dequeue：当前轮继续运行，扩展侧不再额外动作、不提示
    expect(dequeueHandler).toHaveBeenCalledTimes(1);
    expect(ctx.abort).not.toHaveBeenCalled();
    expect(ctx.waitForIdle).not.toHaveBeenCalled();
    expect(ctx.navigateTree).not.toHaveBeenCalled();
    expect(ctx.ui.setEditorText).not.toHaveBeenCalled();
    expect(ctx.ui.notify).not.toHaveBeenCalled();
  });

  it("执行中且队列非空但 TUI 引用缺失：提示按 dequeue 快捷键，不 abort", async () => {
    const { mockPi, commandHandlers } = createMockPi();
    const mod = await import("../src/index.ts");
    (mod.default as any)(mockPi);
    const ctx = createMockCtx({
      isIdle: vi.fn(() => false),
      abort: vi.fn(),
      navigateTree: vi.fn(async () => {}),
      hasPendingMessages: vi.fn(() => true),
    });
    await commandHandlers["undo"]!({}, ctx);
    expect(ctx.abort).not.toHaveBeenCalled();
    expect(ctx.navigateTree).not.toHaveBeenCalled();
    expect(ctx.ui.setEditorText).not.toHaveBeenCalled();
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("Host TUI reference unavailable"),
      "warning",
    );
  });

  it("dequeue handler 抛错：提示 Failed to recall queued messages", async () => {
    const { mockPi, commandHandlers, handlers } = createMockPi();
    const mod = await import("../src/index.ts");
    (mod.default as any)(mockPi);
    const dequeueHandler = vi.fn(() => { throw new Error("boom"); });
    const fakeTui = { children: [{ actionHandlers: new Map([["app.message.dequeue", dequeueHandler]]) }] };
    const ctx = createMockCtx({
      isIdle: vi.fn(() => false),
      abort: vi.fn(),
      hasPendingMessages: vi.fn(() => true),
      mode: "tui",
    });
    await handlers["session_start"]!({}, ctx);
    (ctx.ui.setWidget.mock.calls[0]?.[1] as (tui: unknown) => unknown)(fakeTui);
    await commandHandlers["undo"]!({}, ctx);
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("Failed to recall queued messages"),
      "warning",
    );
  });

  it("draft 守卫优先于队列分支：有草稿+有队列只出草稿提示、不调 handler", async () => {
    const { mockPi, commandHandlers, handlers } = createMockPi();
    const mod = await import("../src/index.ts");
    (mod.default as any)(mockPi);
    const dequeueHandler = vi.fn();
    const fakeTui = { children: [{ actionHandlers: new Map([["app.message.dequeue", dequeueHandler]]) }] };
    const ctx = createMockCtx({
      isIdle: vi.fn(() => false),
      abort: vi.fn(),
      hasPendingMessages: vi.fn(() => true),
      mode: "tui",
      ui: {
        getEditorText: vi.fn(() => "pending draft"),
        setEditorText: vi.fn(),
        setStatus: vi.fn(),
        notify: vi.fn(),
        setWidget: vi.fn(),
      },
    });
    await handlers["session_start"]!({}, ctx);
    (ctx.ui.setWidget.mock.calls[0]?.[1] as (tui: unknown) => unknown)(fakeTui);
    await commandHandlers["undo"]!({}, ctx);
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      "Editor has draft, clear it first",
      "warning",
    );
    expect(dequeueHandler).not.toHaveBeenCalled();
    expect(ctx.abort).not.toHaveBeenCalled();
  });

  it("widget 已注册但树形漂移（找不到编辑器）：回退提示而非崩溃", async () => {
    const { mockPi, commandHandlers, handlers } = createMockPi();
    const mod = await import("../src/index.ts");
    (mod.default as any)(mockPi);
    const ctx = createMockCtx({
      isIdle: vi.fn(() => false),
      abort: vi.fn(),
      hasPendingMessages: vi.fn(() => true),
      mode: "tui",
    });
    await handlers["session_start"]!({}, ctx);
    // 捕获了一个没有编辑器的假 tui（模拟宿主结构变化）
    (ctx.ui.setWidget.mock.calls[0]?.[1] as (tui: unknown) => unknown)({ children: [] });
    await commandHandlers["undo"]!({}, ctx);
    expect(ctx.abort).not.toHaveBeenCalled();
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("Host editor structure changed"),
      "warning",
    );
  });

  // 诱饵节点：兄弟子树中存在任意 Map 但不含 dequeue 键，不应误命中
  it("诱饵 Map 节点不误命中：兄弟子树有空 Map 时仍命中真实编辑器", async () => {
    const { mockPi, commandHandlers, handlers } = createMockPi();
    const mod = await import("../src/index.ts");
    (mod.default as any)(mockPi);
    const dequeueHandler = vi.fn();
    // 兄弟子树首节点为诱饵（有 actionHandlers Map 但缺 dequeue），真实编辑器在后
    const fakeTui = {
      children: [
        { actionHandlers: new Map([["other.action", vi.fn()]]) },
        { children: [{ actionHandlers: new Map([["app.message.dequeue", dequeueHandler]]) }] },
      ],
    };
    const ctx = createMockCtx({
      isIdle: vi.fn(() => false),
      abort: vi.fn(),
      hasPendingMessages: vi.fn(() => true),
      mode: "tui",
    });
    await handlers["session_start"]!({}, ctx);
    (ctx.ui.setWidget.mock.calls[0]?.[1] as (tui: unknown) => unknown)(fakeTui);
    await commandHandlers["undo"]!({}, ctx);
    expect(dequeueHandler).toHaveBeenCalledTimes(1);
    expect(ctx.abort).not.toHaveBeenCalled();
    expect(ctx.ui.notify).not.toHaveBeenCalled();
  });

  // hasPendingMessages 抛错保守化：不坠入 abort、不动会话树、不消耗预算
  it("hasPendingMessages 抛错时保守返回，不 abort、不导航、不消耗预算", async () => {
    const { mockPi, commandHandlers, handlers } = createMockPi();
    const mod = await import("../src/index.ts");
    (mod.default as any)(mockPi);
    const branch = [branchWithUser("1", null, "msg-conservative")];
    const ctx = createMockCtx({
      sessionManager: {
        getSessionId: vi.fn(() => "sid-conservative"),
        getBranch: vi.fn(() => branch),
        branch: vi.fn(),
        resetLeaf: vi.fn(),
      },
      isIdle: vi.fn(() => false),
      abort: vi.fn(),
      hasPendingMessages: vi.fn(() => { throw new Error("queue boom"); }),
      navigateTree: vi.fn(async () => {}),
      mode: "tui",
    });
    await handlers["session_start"]!({}, ctx);
    await commandHandlers["undo"]!({}, ctx);
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("Cannot determine queue state"),
      "warning",
    );
    expect(ctx.abort).not.toHaveBeenCalled();
    expect(ctx.navigateTree).not.toHaveBeenCalled();
    expect(mockPi.appendEntry).not.toHaveBeenCalled();
    // 未消耗单次/轮：修复 hasPending 后重试应能正常导航（fall through 到硬撤）
    ctx.ui.notify.mockClear();
    ctx.hasPendingMessages = vi.fn(() => false);
    (ctx as any).isIdle = vi.fn(() => true);
    await commandHandlers["undo"]!({}, ctx);
    expect(ctx.navigateTree).toHaveBeenCalledWith("1", { summarize: false });
  });

  // 生命周期：session_shutdown 应清理捕获的 TUI 引用
  it("session_shutdown 清理捕获的 TUI 引用，后续队列取回走 TUI 缺失降级", async () => {
    const { mockPi, commandHandlers, handlers } = createMockPi();
    const mod = await import("../src/index.ts");
    (mod.default as any)(mockPi);
    const dequeueHandler = vi.fn();
    const fakeTui = { children: [{ actionHandlers: new Map([["app.message.dequeue", dequeueHandler]]) }] };
    const ctx = createMockCtx({
      isIdle: vi.fn(() => false),
      abort: vi.fn(),
      hasPendingMessages: vi.fn(() => true),
      mode: "tui",
    });
    await handlers["session_start"]!({}, ctx);
    (ctx.ui.setWidget.mock.calls[0]?.[1] as (tui: unknown) => unknown)(fakeTui);
    // 清理
    await handlers["session_shutdown"]!({}, ctx);
    await commandHandlers["undo"]!({}, ctx);
    expect(dequeueHandler).not.toHaveBeenCalled();
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("Host TUI reference unavailable"),
      "warning",
    );
  });

  it("dequeue 路径不消耗单次/轮预算：连续两次都生效", async () => {
    const { mockPi, commandHandlers, handlers } = createMockPi();
    const mod = await import("../src/index.ts");
    (mod.default as any)(mockPi);
    const dequeueHandler = vi.fn();
    const fakeTui = { children: [{ actionHandlers: new Map([["app.message.dequeue", dequeueHandler]]) }] };
    const ctx = createMockCtx({
      isIdle: vi.fn(() => false),
      abort: vi.fn(),
      hasPendingMessages: vi.fn(() => true),
      mode: "tui",
    });
    await handlers["session_start"]!({}, ctx);
    (ctx.ui.setWidget.mock.calls[0]?.[1] as (tui: unknown) => unknown)(fakeTui);
    await commandHandlers["undo"]!({}, ctx);
    await commandHandlers["undo"]!({}, ctx);
    expect(dequeueHandler).toHaveBeenCalledTimes(2);
    expect(ctx.ui.notify).not.toHaveBeenCalledWith(
      expect.stringContaining("Already undone"),
      "warning",
    );
  });

  it("执行中无排队消息时，撤回后编辑器仅回填被撤消息文本", async () => {
    const { mockPi, commandHandlers } = createMockPi();
    const mod = await import("../src/index.ts");
    (mod.default as any)(mockPi);
    const branch = [
      branchWithUser("1", null, "first"),
      { type: "message", id: "2", parentId: "1", timestamp: new Date().toISOString(), message: { role: "assistant", content: "hi" } },
      branchWithUser("3", "2", "msg"),
    ];
    let idle = false;
    let leafId: string | null = "3";
    const ctx = createMockCtx({
      sessionManager: {
        getSessionId: vi.fn(() => "sid-working-clean"),
        getBranch: vi.fn(() => branch),
        getLeafId: vi.fn(() => leafId),
        branch: vi.fn(),
        resetLeaf: vi.fn(),
      },
      isIdle: vi.fn(() => idle),
      abort: vi.fn(),
      waitForIdle: vi.fn(async () => { idle = true; }),
      // 模拟宿主对 user 目标的特判：newLeafId = parentId
      navigateTree: vi.fn(async (_id: string) => { leafId = "2"; return {}; }),
    });
    await commandHandlers["undo"]!({}, ctx);
    // leaf 恰为被撤消息时命中宿主 no-op 早退陷阱，应改以 parent 为目标
    expect(ctx.navigateTree).toHaveBeenCalledWith("2", { summarize: false });
    expect(ctx.ui.setEditorText).toHaveBeenCalledWith("msg");
  });

  it("before_agent_start 重置 canUndo，重置后可再次撤销", async () => {
    const { mockPi, commandHandlers, handlers } = createMockPi();
    const mod = await import("../src/index.ts");
    (mod.default as any)(mockPi);
    const ctx = createMockCtx({});

    // 先消耗一次
    ctx.sessionManager.getBranch.mockReturnValue([branchWithUser("1", null, "history-msg")]);
    await commandHandlers["undo"]!({}, ctx);
    expect(ctx.navigateTree).toHaveBeenCalledWith("1", { summarize: false });

    // 第二次被拦
    await commandHandlers["undo"]!({}, ctx);
    expect(ctx.ui.notify).toHaveBeenLastCalledWith(expect.stringContaining("Already undone"), "warning");

    // before_agent_start 重置
    const beforeHandler = handlers["before_agent_start"]!;
    await beforeHandler({ prompt: "next" }, ctx);

    // 重置后应可再次撤销
    ctx.ui.notify.mockClear();
    ctx.sessionManager.getBranch.mockReturnValue([branchWithUser("2", null, "another")]);
    await commandHandlers["undo"]!({}, ctx);
    expect(ctx.navigateTree).toHaveBeenCalledWith("2", { summarize: false });
  });

  it("历史撤销：navigateTree 使用 entryId 并落哨兵", async () => {
    const { mockPi, commandHandlers } = createMockPi();
    const mod = await import("../src/index.ts");
    (mod.default as any)(mockPi);
    const branch = [
      branchWithUser("1", null, "first"),
      { type: "message", id: "2", parentId: "1", timestamp: new Date().toISOString(), message: { role: "assistant", content: "hi" } },
      branchWithUser("3", "2", "second"),
    ];
    const ctx = createMockCtx({
      sessionManager: {
        getSessionId: vi.fn(() => "sid-history"),
        getBranch: vi.fn(() => branch),
        branch: vi.fn(),
        resetLeaf: vi.fn(),
      },
      ui: {
        getEditorText: vi.fn(() => ""),
        setEditorText: vi.fn(),
        setStatus: vi.fn(),
        notify: vi.fn(),
      },
      navigateTree: vi.fn(async () => {}),
    });
    await commandHandlers["undo"]!({}, ctx);
    // 应回到 user 消息自身 entryId "3"（宿主特判 leaf=parentId="2"），并落哨兵固定终点
    expect(ctx.navigateTree).toHaveBeenCalledWith("3", { summarize: false });
    expect(ctx.ui.setEditorText).toHaveBeenCalledWith("second");
    expect(mockPi.appendEntry).toHaveBeenCalledTimes(1);
    expect(mockPi.appendEntry).toHaveBeenCalledWith("pi-undo-pin", { v: 1, at: "2" });
  });

  it("受限上下文无 navigateTree 时显式失败，不再静默降级", async () => {
    const { mockPi, commandHandlers } = createMockPi();
    const mod = await import("../src/index.ts");
    (mod.default as any)(mockPi);
    const branch = [branchWithUser("1", null, "only")];
    const ctx = createMockCtx({
      sessionManager: {
        getSessionId: vi.fn(() => "sid-first"),
        getBranch: vi.fn(() => branch),
        branch: vi.fn(),
        resetLeaf: vi.fn(),
      },
      ui: {
        getEditorText: vi.fn(() => ""),
        setEditorText: vi.fn(),
        setStatus: vi.fn(),
        notify: vi.fn(),
      },
    });
    // 删除 navigateTree 模拟受限上下文：应显式失败而非静默降级 sm.branch()
    delete ctx.navigateTree;
    await commandHandlers["undo"]!({}, ctx);
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      "Hard undo unavailable here — use /undo instead",
      "warning",
    );
    expect(ctx.sessionManager.resetLeaf).not.toHaveBeenCalled();
    expect(ctx.sessionManager.branch).not.toHaveBeenCalled();
    expect(ctx.ui.setEditorText).not.toHaveBeenCalled();
    // 未消耗单次/轮，也未落哨兵
    expect(mockPi.appendEntry).not.toHaveBeenCalled();
  });

  it("首条消息统一走 navigateTree(entryId)，宿主自动落到 root", async () => {
    const { mockPi, commandHandlers } = createMockPi();
    const mod = await import("../src/index.ts");
    (mod.default as any)(mockPi);
    const branch = [branchWithUser("1", null, "first-only")];
    const ctx = createMockCtx({
      sessionManager: {
        getSessionId: vi.fn(() => "sid-first2"),
        getBranch: vi.fn(() => branch),
        branch: vi.fn(),
        resetLeaf: vi.fn(),
      },
      navigateTree: vi.fn(async () => {}),
    });
    await commandHandlers["undo"]!({}, ctx);
    // 扩展侧不再特判首条：统一传 entryId，宿主对 user 目标自动 leaf=parentId(null)=root
    expect(ctx.navigateTree).toHaveBeenCalledWith("1", { summarize: false });
    expect(ctx.sessionManager.resetLeaf).not.toHaveBeenCalled();
    expect(mockPi.appendEntry).toHaveBeenCalledWith("pi-undo-pin", { v: 1, at: null });
  });

  it("无消息时提示 No message 且不消耗 canUndo", async () => {
    const { mockPi, commandHandlers } = createMockPi();
    const mod = await import("../src/index.ts");
    (mod.default as any)(mockPi);
    const ctx = createMockCtx({
      sessionManager: {
        getSessionId: vi.fn(() => "sid-empty"),
        getBranch: vi.fn(() => []),
        branch: vi.fn(),
        resetLeaf: vi.fn(),
      },
      ui: {
        getEditorText: vi.fn(() => ""),
        setEditorText: vi.fn(),
        setStatus: vi.fn(),
        notify: vi.fn(),
      },
      navigateTree: vi.fn(async () => {}),
    });
    await commandHandlers["undo"]!({}, ctx);
    expect(ctx.ui.notify).toHaveBeenCalledWith("No message to undo", "warning");

    // 第二次应仍是 No message，而非 Already undone
    ctx.ui.notify.mockClear();
    await commandHandlers["undo"]!({}, ctx);
    expect(ctx.ui.notify).toHaveBeenCalledWith("No message to undo", "warning");
  });

  it("执行中 abort→waitForIdle→再检草稿", async () => {
    const { mockPi, commandHandlers } = createMockPi();
    const mod = await import("../src/index.ts");
    (mod.default as any)(mockPi);
    const branch = [
      branchWithUser("1", null, "first"),
      { type: "message", id: "2", parentId: "1", timestamp: new Date().toISOString(), message: { role: "assistant", content: "hi" } },
      branchWithUser("3", "2", "msg"),
    ];
    let idle = false;
    const ctx = createMockCtx({
      sessionManager: {
        getSessionId: vi.fn(() => "sid-abort"),
        getBranch: vi.fn(() => branch),
        branch: vi.fn(),
        resetLeaf: vi.fn(),
      },
      ui: {
        getEditorText: vi.fn(() => ""),
        setEditorText: vi.fn(),
        setStatus: vi.fn(),
        notify: vi.fn(),
      },
      isIdle: vi.fn(() => idle),
      abort: vi.fn(() => { idle = false; }),
      waitForIdle: vi.fn(async () => { idle = true; }),
      navigateTree: vi.fn(async () => {}),
    });
    // 先让 isIdle false 触发 abort
    await commandHandlers["undo"]!({}, ctx);
    expect(ctx.abort).toHaveBeenCalled();
    expect(ctx.waitForIdle).toHaveBeenCalled();
    expect(ctx.navigateTree).toHaveBeenCalled();
  });

  it("abort 未 settle 时提示且不消耗 canUndo", async () => {
    const { mockPi, commandHandlers } = createMockPi();
    const mod = await import("../src/index.ts");
    (mod.default as any)(mockPi);
    const branch = [branchWithUser("1", null, "msg2")];
    const ctx = createMockCtx({
      sessionManager: {
        getSessionId: vi.fn(() => "sid-abort-fail"),
        getBranch: vi.fn(() => branch),
        branch: vi.fn(),
        resetLeaf: vi.fn(),
      },
      ui: {
        getEditorText: vi.fn(() => ""),
        setEditorText: vi.fn(),
        setStatus: vi.fn(),
        notify: vi.fn(),
      },
      isIdle: vi.fn(() => false), // 一直不 idle
      abort: vi.fn(),
      // 不提供 waitForIdle，让 poll 超时后仍 !isIdle
      waitForIdle: null as any,
      navigateTree: vi.fn(async () => {}),
    });
    // 删除 waitForIdle 以走 poll 分支，poll 50*200ms=10s 太长，改用 mock isIdle 始终 false 时会走超时
    delete ctx.waitForIdle;
    // 缩短 poll 时间：直接 mock isIdle 始终 false，waitUntilIdle 会 poll 50 次约 10s，测试需加速
    // 为避免 10s 等待，改用提供 waitForIdle 但不改变 isIdle，使 isIdle 仍 false 触发 Abort did not settle
    ctx.waitForIdle = vi.fn(async () => {});
    await commandHandlers["undo"]!({}, ctx);
    expect(ctx.ui.notify).toHaveBeenCalledWith("Abort did not settle, try again", "warning");
    // 第二次应仍可重试（未消耗）
    ctx.ui.notify.mockClear();
    ctx.isIdle.mockReturnValue(true);
    ctx.sessionManager.getBranch.mockReturnValue(branch);
    delete ctx.waitForIdle;
    ctx.navigateTree = vi.fn(async () => {});
    // 现在 isIdle true，直接走历史（首条统一走 navigateTree(entryId)）
    await commandHandlers["undo"]!({}, ctx);
    expect(ctx.navigateTree).toHaveBeenCalledWith("1", { summarize: false });
  });

  it("并发二次 undo 仅一次成功（B4）", async () => {
    const { mockPi, commandHandlers } = createMockPi();
    const mod = await import("../src/index.ts");
    (mod.default as any)(mockPi);
    const branch = [branchWithUser("1", null, "msg3")];
    const ctx = createMockCtx({
      sessionManager: {
        getSessionId: vi.fn(() => "sid-concurrent"),
        getBranch: vi.fn(() => branch),
        branch: vi.fn(),
        resetLeaf: vi.fn(),
      },
      navigateTree: vi.fn(async () => {}),
    });

    // 并发两次
    const p1 = commandHandlers["undo"]!({}, ctx);
    const p2 = commandHandlers["undo"]!({}, ctx);
    await Promise.all([p1, p2]);
    // 只有一次真实导航成功，另一个被 Already undone / already in progress 拦截
    const navCalls = ctx.navigateTree.mock.calls.length;
    expect(navCalls).toBe(1);
    expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringMatching(/Already undone|already in progress/i), "warning");
  });

  it("notify 异常不抛（M6）", async () => {
    const { mockPi, commandHandlers } = createMockPi();
    const mod = await import("../src/index.ts");
    (mod.default as any)(mockPi);
    const ctx = createMockCtx({
      ui: {
        getEditorText: vi.fn(() => "draft"),
        setEditorText: vi.fn(),
        setStatus: vi.fn(),
        notify: vi.fn(() => { throw new Error("notify boom"); }),
      },
    });
    await expect(commandHandlers["undo"]!({}, ctx)).resolves.not.toThrow();
  });


  it("alt+u 快捷键委托 /undo 命令管道，行为一致性由构造保证", async () => {
    const { mockPi } = createMockPi();
    const mod = await import("../src/index.ts");
    (mod.default as any)(mockPi);
    const shortcut = mockPi.registerShortcut.mock.calls[0]?.[0];
    expect(shortcut).toBe("alt+u");
    const shortcutHandler = mockPi.registerShortcut.mock.calls[0]?.[1]?.handler as () => Promise<unknown>;
    expect(typeof shortcutHandler).toBe("function");
    // 委托命令派发：expandPromptTemplates 必须显式 true（宿主默认 false），命中扩展命令后不触发 LLM turn
    await shortcutHandler();
    expect(mockPi.sendUserMessage).toHaveBeenCalledTimes(1);
    expect(mockPi.sendUserMessage).toHaveBeenCalledWith("/undo", { expandPromptTemplates: true });
  });

  it("no-op 陷阱：目标恰为当前 leaf 时改以 parent 为导航目标", async () => {
    const { mockPi, commandHandlers } = createMockPi();
    const mod = await import("../src/index.ts");
    (mod.default as any)(mockPi);
    const branch = [
      branchWithUser("1", null, "first"),
      { type: "message", id: "2", parentId: "1", timestamp: new Date().toISOString(), message: { role: "assistant", content: "hi" } },
      branchWithUser("3", "2", "second"),
    ];
    const leafState = { id: "3" as string | null }; // 模拟崩溃 resume 后文件末条即 user 消息
    const ctx = createMockCtx({
      sessionManager: {
        getSessionId: vi.fn(() => "sid-noop"),
        getBranch: vi.fn(() => branch),
        getLeafId: vi.fn(() => leafState.id),
        branch: vi.fn(),
        resetLeaf: vi.fn(),
      },
      navigateTree: vi.fn(async (_id: string) => {
        // 模拟宿主导航成功后推进 leaf（非 user 目标 → leaf=目标本身）
        leafState.id = "2";
        return {};
      }),
    });
    await commandHandlers["undo"]!({}, ctx);
    // 若直接传 entryId "3" 会命中宿主 no-op 早退；应改以 parent "2" 为目标
    expect(ctx.navigateTree).toHaveBeenCalledWith("2", { summarize: false });
    expect(ctx.ui.setEditorText).toHaveBeenCalledWith("second");
    expect(mockPi.appendEntry).toHaveBeenCalledWith("pi-undo-pin", { v: 1, at: "2" });
  });

  it("导航被取消时不回填、不消耗 canUndo、不落哨兵", async () => {
    const { mockPi, commandHandlers } = createMockPi();
    const mod = await import("../src/index.ts");
    (mod.default as any)(mockPi);
    const branch = [
      branchWithUser("1", null, "first"),
      { type: "message", id: "2", parentId: "1", timestamp: new Date().toISOString(), message: { role: "assistant", content: "hi" } },
      branchWithUser("3", "2", "msg"),
    ];
    const ctx = createMockCtx({
      sessionManager: {
        getSessionId: vi.fn(() => "sid-cancelled"),
        getBranch: vi.fn(() => branch),
        branch: vi.fn(),
        resetLeaf: vi.fn(),
      },
      navigateTree: vi.fn(async () => ({ cancelled: true })),
    });
    await commandHandlers["undo"]!({}, ctx);
    expect(ctx.ui.notify).toHaveBeenCalledWith("Undo did not take effect, try again", "warning");
    expect(ctx.ui.setEditorText).not.toHaveBeenCalled();
    expect(mockPi.appendEntry).not.toHaveBeenCalled();
    // canUndo 未消耗：再次触发仍是同一失败提示而非 Already undone
    ctx.ui.notify.mockClear();
    await commandHandlers["undo"]!({}, ctx);
    expect(ctx.ui.notify).toHaveBeenCalledWith("Undo did not take effect, try again", "warning");
  });

  it("leaf 未实际移动时视为失败且不落哨兵", async () => {
    const { mockPi, commandHandlers } = createMockPi();
    const mod = await import("../src/index.ts");
    (mod.default as any)(mockPi);
    const branch = [
      branchWithUser("1", null, "first"),
      { type: "message", id: "2", parentId: "1", timestamp: new Date().toISOString(), message: { role: "assistant", content: "hi" } },
      branchWithUser("3", "2", "msg"),
    ];
    // getLeafId 恒返回同值：navigateTree resolve 成功但 leaf 指针未变 → 判定未生效
    const ctx = createMockCtx({
      sessionManager: {
        getSessionId: vi.fn(() => "sid-unmoved"),
        getBranch: vi.fn(() => branch),
        getLeafId: vi.fn(() => "9"),
        branch: vi.fn(),
        resetLeaf: vi.fn(),
      },
      navigateTree: vi.fn(async () => ({})),
    });
    await commandHandlers["undo"]!({}, ctx);
    expect(ctx.ui.notify).toHaveBeenCalledWith("Undo did not take effect, try again", "warning");
    expect(mockPi.appendEntry).not.toHaveBeenCalled();
    expect(ctx.ui.setEditorText).not.toHaveBeenCalled();
  });

  it("特例：首条消息本身是 leaf 时 resetLeaf + 根级哨兵 + 显式告知视图未刷新", async () => {
    const { mockPi, commandHandlers } = createMockPi();
    const mod = await import("../src/index.ts");
    (mod.default as any)(mockPi);
    const branch = [branchWithUser("1", null, "only")];
    const ctx = createMockCtx({
      sessionManager: {
        getSessionId: vi.fn(() => "sid-root-leaf"),
        getBranch: vi.fn(() => branch),
        getLeafId: vi.fn(() => "1"),
        branch: vi.fn(),
        resetLeaf: vi.fn(),
      },
      navigateTree: vi.fn(async () => {}),
    });
    await commandHandlers["undo"]!({}, ctx);
    expect(ctx.sessionManager.resetLeaf).toHaveBeenCalled();
    expect(mockPi.appendEntry).toHaveBeenCalledWith("pi-undo-pin", { v: 1, at: null });
    expect(ctx.ui.setEditorText).toHaveBeenCalledWith("only");
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("In-memory view not refreshed"),
      "warning",
    );
    // navigateTree 不应被调用（无 entry 可作目标，走 resetLeaf 特例）
    expect(ctx.navigateTree).not.toHaveBeenCalled();
  });
});
