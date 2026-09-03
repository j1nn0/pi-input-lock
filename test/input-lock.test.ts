import { describe, expect, it, vi } from "vitest";
import { visibleWidth } from "@earendil-works/pi-tui";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  getActiveToggleLabel,
  getToggleKeyId,
  isEnabled,
  isForeignFocus,
  isLockedState,
  LockStateMachine,
  LockedEditor,
  matchesToggleKey,
  nextState,
  resetToggleKeyCache,
  type LockState,
} from "../src/index.ts";
import extension from "../src/index.ts";

type EditorFactory = (tui: any, theme: any, keybindings: any) => any;

type Harness = ReturnType<typeof makeHarness>;

function makeHarness(initialFactory?: EditorFactory, initialComponent?: any, initialText = "draft prompt") {
  const handlers = new Map<string, Function>();
  const commands: Array<{ handler: Function }> = [];
  const defaultEditor = { name: "pi-default-editor", getText: () => "" };
  let component = initialComponent ?? defaultEditor;
  let componentFactory = initialFactory;
  let editorText = initialText;
  let idle = true;
  let focused: any;
  let failFactory: EditorFactory | undefined;
  let terminalRoute: ((data: string) => unknown) | undefined;
  const activeInputHandlers = new Set<Function>();
  const inputDisposers: Array<ReturnType<typeof vi.fn>> = [];
  const terminalDisposers: Array<ReturnType<typeof vi.fn>> = [];

  const theme: any = { borderColor: (text: string) => text, selectList: {} };
  const keybindings: any = {};
  const tui: any = {
    addInputListener: vi.fn((handler: Function) => {
      activeInputHandlers.add(handler);
      let active = true;
      const disposer = vi.fn(() => {
        if (active) {
          active = false;
          activeInputHandlers.delete(handler);
        }
      });
      inputDisposers.push(disposer);
      return disposer;
    }),
    getFocusedComponent: () => focused ?? component,
    requestRender: vi.fn(),
  };

  const setEditorComponent = vi.fn((factory: EditorFactory | undefined) => {
    if (factory !== undefined && factory === failFactory) throw new Error("factory restore failed");
    componentFactory = factory;
    if (factory === undefined) {
      component = defaultEditor;
    } else {
      component = factory(tui, theme, keybindings);
    }
    focused = undefined;
  });

  const ui: any = {
    tui,
    theme,
    getEditorText: () => editorText,
    setEditorText: (text: string) => {
      editorText = text;
    },
    getEditorComponent: () => componentFactory,
    setEditorComponent,
    onTerminalInput: (handler: (data: string) => unknown) => {
      terminalRoute = handler;
      const disposer = vi.fn(() => {
        if (terminalRoute === handler) terminalRoute = undefined;
      });
      terminalDisposers.push(disposer);
      return disposer;
    },
    notify: vi.fn(),
    setStatus: vi.fn(),
  };
  const ctx: any = {
    ui,
    isIdle: () => idle,
  };
  const pi: any = {
    on: (name: string, handler: Function) => handlers.set(name, handler),
    registerCommand: (_name: string, options: { handler: Function }) => commands.push(options),
  };

  return {
    handlers,
    commands,
    ctx,
    pi,
    ui,
    tui,
    defaultEditor,
    setEditorComponent,
    inputDisposers,
    terminalDisposers,
    activeInputHandlers,
    get component() {
      return component;
    },
    get componentFactory() {
      return componentFactory;
    },
    get editorText() {
      return editorText;
    },
    get idle() {
      return idle;
    },
    set idle(value: boolean) {
      idle = value;
    },
    set failFactory(value: EditorFactory | undefined) {
      failFactory = value;
    },
    focus(value: any) {
      focused = value;
    },
    clearFocus() {
      focused = undefined;
    },
    setText(value: string) {
      editorText = value;
    },
    mount(factory: EditorFactory | undefined, value?: any) {
      setEditorComponent(factory);
      if (value !== undefined) component = value;
    },
    terminal(data: string) {
      return terminalRoute?.(data);
    },
    input(data: string) {
      return [...activeInputHandlers].map((handler) => handler(data));
    },
  };
}

async function withEnabled<T>(run: () => Promise<T> | T): Promise<T> {
  const previous = process.env.PI_INPUT_LOCK;
  process.env.PI_INPUT_LOCK = "1";
  try {
    return await run();
  } finally {
    if (previous === undefined) delete process.env.PI_INPUT_LOCK;
    else process.env.PI_INPUT_LOCK = previous;
  }
}

async function startExtension(harness: Harness): Promise<void> {
  extension(harness.pi);
  await harness.handlers.get("session_start")?.({}, harness.ctx);
}

async function agentStart(harness: Harness): Promise<void> {
  await harness.handlers.get("agent_start")?.({}, harness.ctx);
}

async function agentSettled(harness: Harness): Promise<void> {
  await harness.handlers.get("agent_settled")?.({}, harness.ctx);
}

describe("lock state", () => {
  it("starts idle and supports manual override transitions", () => {
    expect(nextState("IDLE", "toggle")).toBe("IDLE");
    expect(nextState("WATCH", "toggle")).toBe("OVERRIDE");
    expect(nextState("OVERRIDE", "toggle")).toBe("WATCH");
  });

  it("supports agent lifecycle transitions", () => {
    expect(nextState("IDLE", "agent_start")).toBe("WATCH");
    expect(nextState("WATCH", "agent_settled")).toBe("IDLE");
    expect(nextState("OVERRIDE", "agent_start")).toBe("OVERRIDE");
    expect(nextState("OVERRIDE", "agent_settled")).toBe("IDLE");
    expect(nextState("WATCH", "agent_settled")).toBe("IDLE");
  });

  it("keeps duplicate lifecycle events idempotent", () => {
    expect(nextState("WATCH", "agent_start")).toBe("WATCH");
    expect(nextState("IDLE", "agent_settled")).toBe("IDLE");
    expect(nextState("OVERRIDE", "agent_start")).toBe("OVERRIDE");
  });

  it("exposes a UI-independent state controller", () => {
    const machine = new LockStateMachine();
    expect(machine.state).toBe("IDLE");
    expect(machine.locked).toBe(false);
    expect(machine.toggle()).toBe("IDLE");
    machine.transition("agent_start");
    expect(machine.state).toBe("WATCH");
    expect(machine.locked).toBe(true);
    expect(machine.toggle()).toBe("OVERRIDE");
    expect(machine.toggle()).toBe("WATCH");
    machine.transition("agent_settled");
    expect(machine.state).toBe("IDLE");
  });

  it("only WATCH is blocking", () => {
    const states: LockState[] = ["IDLE", "WATCH", "OVERRIDE"];
    expect(states.map(isLockedState)).toEqual([false, true, false]);
  });
});

describe("toggle key", () => {
  it("matches the configured default forms and rejects ordinary text", () => {
    expect(matchesToggleKey("\x1b\x09")).toBe(true);
    expect(matchesToggleKey("\x1b[105;6u")).toBe(true);
    expect(matchesToggleKey("\x1b[105;7u")).toBe(true);
    expect(matchesToggleKey("o")).toBe(false);
    expect(matchesToggleKey("\x1b")).toBe(false);
    expect(matchesToggleKey("\x1bo")).toBe(false);
  });

  it("is press-only: Kitty repeat and release never toggle", () => {
    expect(matchesToggleKey("\x1b[105;7u")).toBe(true);
    expect(matchesToggleKey("\x1b[105;7:2u")).toBe(false);
    expect(matchesToggleKey("\x1b[105;7:3u")).toBe(false);
    expect(matchesToggleKey("\x1b\x09")).toBe(true);
    expect(matchesToggleKey("\x1b[105;6u")).toBe(true);
    // The legacy fallback is exact-equality (press-only by construction).
    expect(matchesToggleKey("\x1b[105;6:2u")).toBe(false);
    expect(matchesToggleKey("\x1b[105;6:3u")).toBe(false);
  });

  it("applies press-only filtering before matching so any configured key obeys it", () => {
    const previousHome = process.env.HOME;
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-input-lock-test-"));
    try {
      const dir = path.join(tmp, ".pi", "agent", "extensions", "pi-input-lock");
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify({ toggleKey: "ctrl+x" }));
      process.env.HOME = tmp;
      resetToggleKeyCache();
      expect(getToggleKeyId()).toBe("ctrl+x");
      expect(matchesToggleKey("\x1b[120;5u")).toBe(true);
      expect(matchesToggleKey("\x1b[120;5:2u")).toBe(false);
      expect(matchesToggleKey("\x1b[120;5:3u")).toBe(false);
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      resetToggleKeyCache();
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe("foreign focus", () => {
  const editor = { name: "editor" };
  const overlay = { name: "overlay" };
  const input = { name: "input" };

  it("fails open for no focus and exempts owned references", () => {
    const own = { editor, help: overlay, searchComponent: input };
    expect(isForeignFocus(undefined, own)).toBe(false);
    expect(isForeignFocus(null, own)).toBe(false);
    expect(isForeignFocus(editor, own)).toBe(false);
    expect(isForeignFocus(overlay, own)).toBe(false);
    expect(isForeignFocus(input, own)).toBe(false);
  });

  it("uses identity comparison for foreign components", () => {
    expect(isForeignFocus({ name: "editor" }, { editor })).toBe(true);
    expect(isForeignFocus({ name: "dialog" }, { editor })).toBe(true);
  });
});

describe("locked editor", () => {
  const theme: any = { borderColor: (text: string) => text, selectList: {} };

  it("renders a centered passive status with the active shortcut and ignores input", () => {
    const tui: any = {};
    const editor = new LockedEditor(tui, theme, {});
    const lines = editor.render(60);
    const label = "🔒 WATCH · Ctrl + Alt + I to interact";
    const row = lines.find((line) => line.includes(label));

    expect(lines).toHaveLength(3);
    expect(row).toBe(" ".repeat(Math.floor((60 - visibleWidth(label)) / 2)) + label);
    expect(row?.startsWith(" ")).toBe(true);
    expect(row?.endsWith(" ")).toBe(false);
    expect(lines).not.toContain(" ".repeat(60));
    expect(editor.getText()).toBe("");
    expect(() => editor.handleInput("draft\r")).not.toThrow();
  });

  it("can omit the interaction hint", () => {
    const editor = new LockedEditor({} as any, theme, {}, { showHint: false });
    const lines = editor.render(60);

    expect(lines).toHaveLength(3);
    expect(lines.some((line) => line.includes("🔒 WATCH"))).toBe(true);
    expect(lines.every((line) => !line.includes("to interact"))).toBe(true);
  });

  it("handles widths smaller than the prompt", () => {
    const editor = new LockedEditor({} as any, theme, {});

    expect(() => editor.render(10)).not.toThrow();
    expect(editor.render(10)).toHaveLength(3);
  });

  it("uses the configured shortcut in the prompt", () => {
    const previousHome = process.env.HOME;
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-input-lock-test-"));
    try {
      const dir = path.join(tmp, ".pi", "agent", "extensions", "pi-input-lock");
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify({ toggleKey: "ctrl+x" }));
      process.env.HOME = tmp;
      resetToggleKeyCache();

      const editor = new LockedEditor({} as any, theme, {});
      expect(getActiveToggleLabel()).toBe("Ctrl + X");
      expect(editor.render(60).some((line) => line.includes("🔒 WATCH · Ctrl + X to interact"))).toBe(true);
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      resetToggleKeyCache();
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe("editor borrowing", () => {
  it("does not claim a custom editor at session start and restores its identity and draft", async () => {
    await withEnabled(async () => {
      const customFactory: EditorFactory = vi.fn(() => ({ name: "custom-editor", getText: () => "" }));
      const customEditor = { name: "custom-editor", getText: () => "" };
      const harness = makeHarness(customFactory, customEditor);

      await startExtension(harness);
      expect(harness.setEditorComponent).not.toHaveBeenCalled();
      expect(harness.componentFactory).toBe(customFactory);
      expect(harness.editorText).toBe("draft prompt");

      harness.idle = false;
      await agentStart(harness);
      expect(harness.editorText).toBe("");
      expect(harness.component).toBeInstanceOf(LockedEditor);
      expect(harness.activeInputHandlers.size).toBe(1);
      expect(harness.ui.setStatus).toHaveBeenLastCalledWith(
        "pi-input-lock",
        expect.stringContaining("🔒 WATCH"),
      );

      harness.idle = true;
      await agentSettled(harness);
      expect(harness.componentFactory).toBe(customFactory);
      expect(harness.editorText).toBe("draft prompt");
      expect(harness.activeInputHandlers.size).toBe(0);
      expect(harness.ui.setStatus).toHaveBeenLastCalledWith("pi-input-lock", undefined);
    });
  });


  it("keeps an unborrowed WATCH untouched through toggle and settlement", async () => {
    await withEnabled(async () => {
      const factoryA: EditorFactory = vi.fn(() => ({ name: "editor-a", getText: () => "" }));
      const editorA = { name: "editor-a", getText: () => "" };
      const harness = makeHarness(factoryA, editorA, "unborrowed draft");
      await startExtension(harness);

      // Establish the real editor reference before a foreign component takes focus.
      harness.terminal("focus-probe");
      const dialog = { name: "ask-user" };
      harness.focus(dialog);
      harness.idle = false;
      await agentStart(harness);

      expect(harness.componentFactory).toBe(factoryA);
      expect(harness.component).toBe(editorA);
      expect(harness.editorText).toBe("unborrowed draft");
      expect(harness.activeInputHandlers.size).toBe(1);
      expect(harness.setEditorComponent).not.toHaveBeenCalled();

      harness.clearFocus();
      harness.terminal("\x1b\x09");
      expect(harness.componentFactory).toBe(factoryA);
      expect(harness.editorText).toBe("unborrowed draft");
      expect(harness.setEditorComponent.mock.calls.some(([factory]) => factory === undefined)).toBe(false);
      expect(harness.activeInputHandlers.size).toBe(0);

      harness.idle = true;
      await agentSettled(harness);
      expect(harness.componentFactory).toBe(factoryA);
      expect(harness.editorText).toBe("unborrowed draft");
      expect(harness.setEditorComponent.mock.calls.some(([factory]) => factory === undefined)).toBe(false);
      expect(harness.ui.setStatus).toHaveBeenLastCalledWith("pi-input-lock", undefined);
    });
  });

  it("settles an unborrowed WATCH while foreign focus remains without creating pending restore", async () => {
    await withEnabled(async () => {
      const factoryA: EditorFactory = vi.fn(() => ({ name: "editor-a", getText: () => "" }));
      const editorA = { name: "editor-a", getText: () => "" };
      const harness = makeHarness(factoryA, editorA, "unborrowed draft");
      await startExtension(harness);
      harness.terminal("focus-probe");
      harness.focus({ name: "ask-user" });
      harness.idle = false;
      await agentStart(harness);
      harness.idle = true;

      await agentSettled(harness);
      expect(harness.componentFactory).toBe(factoryA);
      expect(harness.editorText).toBe("unborrowed draft");
      expect(harness.activeInputHandlers.size).toBe(0);
      expect(harness.ui.setStatus).toHaveBeenLastCalledWith("pi-input-lock", undefined);

      harness.clearFocus();
      harness.terminal("safe-key");
      expect(harness.componentFactory).toBe(factoryA);
      expect(harness.editorText).toBe("unborrowed draft");
      expect(harness.setEditorComponent.mock.calls.some(([factory]) => factory === undefined)).toBe(false);
    });
  });

  it("round-trips the Pi default editor through undefined", async () => {
    await withEnabled(async () => {
      const harness = makeHarness(undefined, undefined, "default draft");
      const defaultEditor = harness.defaultEditor;
      await startExtension(harness);
      expect(harness.componentFactory).toBeUndefined();
      expect(harness.component).toBe(defaultEditor);

      harness.idle = false;
      await agentStart(harness);
      harness.idle = true;
      await agentSettled(harness);
      expect(harness.componentFactory).toBeUndefined();
      expect(harness.component).toBe(defaultEditor);
      expect(harness.editorText).toBe("default draft");
    });
  });

  it("restores the current editor on override and recaptures a replacement editor", async () => {
    await withEnabled(async () => {
      const factoryA: EditorFactory = vi.fn(() => ({ name: "editor-a", getText: () => "" }));
      const factoryB: EditorFactory = vi.fn(() => ({ name: "editor-b", getText: () => "" }));
      const harness = makeHarness(factoryA, { name: "editor-a", getText: () => "" }, "draft-a");
      await startExtension(harness);
      harness.idle = false;
      await agentStart(harness);

      harness.terminal("\x1b\x09");
      expect(harness.componentFactory).toBe(factoryA);
      expect(harness.editorText).toBe("draft-a");
      expect(harness.activeInputHandlers.size).toBe(0);

      harness.mount(factoryB, { name: "editor-b", getText: () => "" });
      harness.setText("draft-b");
      harness.terminal("\x1b\x09");
      expect(harness.activeInputHandlers.size).toBe(1);

      harness.terminal("\x1b\x09");
      expect(harness.componentFactory).toBe(factoryB);
      expect(harness.editorText).toBe("draft-b");
      expect(harness.activeInputHandlers.size).toBe(0);
    });
  });

  it("blocks input while watched and passes it after override", async () => {
    await withEnabled(async () => {
      const factory: EditorFactory = () => ({ name: "editor", getText: () => "" });
      const editor = { name: "editor", getText: () => "" };
      const harness = makeHarness(factory, editor, "blocked draft");
      await startExtension(harness);
      harness.idle = false;
      await agentStart(harness);

      const lockedResults = harness.input("submit\r");
      expect(lockedResults).toEqual([{ consume: true }]);
      expect(harness.editorText).toBe("");

      harness.terminal("\x1b\x09");
      expect(harness.activeInputHandlers.size).toBe(0);
      expect(harness.editorText).toBe("blocked draft");
    });
  });

  it("installs and disposes one input listener across repeated sessions", async () => {
    await withEnabled(async () => {
      const factory: EditorFactory = () => ({ name: "editor", getText: () => "" });
      const harness = makeHarness(factory, { name: "editor", getText: () => "" });
      await startExtension(harness);

      harness.idle = false;
      await agentStart(harness);
      await agentStart(harness);
      expect(harness.tui.addInputListener).toHaveBeenCalledTimes(1);
      expect(harness.activeInputHandlers.size).toBe(1);

      harness.idle = true;
      await agentSettled(harness);
      expect(harness.activeInputHandlers.size).toBe(0);
      expect(harness.inputDisposers[0]).toHaveBeenCalledTimes(1);

      await harness.handlers.get("session_start")?.({}, harness.ctx);
      await harness.handlers.get("session_start")?.({}, harness.ctx);
      expect(harness.activeInputHandlers.size).toBe(0);
      expect(harness.componentFactory).toBe(factory);

      harness.idle = false;
      await agentStart(harness);
      expect(harness.tui.addInputListener).toHaveBeenCalledTimes(2);
      expect(harness.activeInputHandlers.size).toBe(1);
    });
  });

  it("falls back to the default editor if exact restoration throws", async () => {
    await withEnabled(async () => {
      const customFactory: EditorFactory = () => ({ name: "unrestorable", getText: () => "" });
      const harness = makeHarness(customFactory, { name: "unrestorable", getText: () => "" }, "safe draft");
      harness.failFactory = customFactory;
      await startExtension(harness);
      harness.idle = false;
      await agentStart(harness);
      harness.idle = true;
      await agentSettled(harness);

      expect(harness.componentFactory).toBeUndefined();
      expect(harness.component).toBe(harness.defaultEditor);
      expect(harness.component).not.toBeInstanceOf(LockedEditor);
      expect(harness.editorText).toBe("safe draft");
      expect(harness.activeInputHandlers.size).toBe(0);
      expect(harness.ui.setStatus).toHaveBeenLastCalledWith("pi-input-lock", undefined);
    });
  });

  it("finalizes lifecycle state while deferring a foreign-focus editor swap", async () => {
    await withEnabled(async () => {
      const factory: EditorFactory = vi.fn(() => ({ name: "editor", getText: () => "" }));
      const harness = makeHarness(factory, { name: "editor", getText: () => "" }, "deferred draft");
      await startExtension(harness);
      harness.idle = false;
      await agentStart(harness);
      const locked = harness.component;
      const dialog = { name: "ask-user" };
      harness.focus(dialog);
      harness.idle = true;

      await agentSettled(harness);
      expect(harness.component).toBe(locked);
      expect(harness.activeInputHandlers.size).toBe(0);
      expect(harness.ui.setStatus).toHaveBeenLastCalledWith("pi-input-lock", undefined);

      // A toggle remains a no-op while the foreign UI owns focus.
      harness.terminal("\x1b\x09");
      expect(harness.component).toBe(locked);
      expect(harness.componentFactory).not.toBe(factory);

      // The first key after focus returns drains the deferred restore. It must
      // not turn the already-settled IDLE state into OVERRIDE.
      harness.clearFocus();
      harness.terminal("\x1b\x09");
      expect(harness.component).not.toBe(locked);
      expect(harness.componentFactory).toBe(factory);
      expect(harness.editorText).toBe("deferred draft");
      expect(harness.activeInputHandlers.size).toBe(0);

      // A repeated lifecycle event is idempotent and is not the restore trigger.
      await agentSettled(harness);
      expect(harness.componentFactory).toBe(factory);
      expect(harness.editorText).toBe("deferred draft");
      expect(harness.ui.setStatus).toHaveBeenLastCalledWith("pi-input-lock", undefined);
    });
  });
});

describe("press-only toggle lifecycle", () => {
  const PRESS = "\x1b[105;7u";
  const REPEAT = "\x1b[105;7:2u";
  const RELEASE = "\x1b[105;7:3u";

  it("holds OVERRIDE across the release that follows a press", async () => {
    await withEnabled(async () => {
      const factoryA: EditorFactory = vi.fn(() => ({ name: "editor-a", getText: () => "" }));
      const harness = makeHarness(factoryA, { name: "editor-a", getText: () => "" }, "held draft");
      await startExtension(harness);
      harness.idle = false;
      await agentStart(harness);
      expect(harness.component).toBeInstanceOf(LockedEditor);

      harness.terminal(PRESS);
      expect(harness.componentFactory).toBe(factoryA);
      expect(harness.editorText).toBe("held draft");
      expect(harness.activeInputHandlers.size).toBe(0);
      const callsAfterPress = harness.setEditorComponent.mock.calls.length;

      // Repeat and release must not toggle back to WATCH: no editor swap,
      // no listener reinstall, draft and override UI stay put.
      harness.terminal(REPEAT);
      harness.terminal(REPEAT);
      harness.terminal(RELEASE);
      expect(harness.setEditorComponent.mock.calls.length).toBe(callsAfterPress);
      expect(harness.componentFactory).toBe(factoryA);
      expect(harness.editorText).toBe("held draft");
      expect(harness.activeInputHandlers.size).toBe(0);
    });
  });

  it("keeps IDLE a no-op for press, repeat, and release", async () => {
    await withEnabled(async () => {
      const factoryA: EditorFactory = vi.fn(() => ({ name: "editor-a", getText: () => "" }));
      const harness = makeHarness(factoryA, { name: "editor-a", getText: () => "" }, "idle draft");
      await startExtension(harness);

      harness.terminal(PRESS);
      harness.terminal(REPEAT);
      harness.terminal(RELEASE);
      expect(harness.componentFactory).toBe(factoryA);
      expect(harness.component).not.toBeInstanceOf(LockedEditor);
      expect(harness.editorText).toBe("idle draft");
      expect(harness.activeInputHandlers.size).toBe(0);
    });
  });
});

describe("runtime activation", () => {
  it("is disabled unless PI_INPUT_LOCK is explicitly enabled", () => {
    const previous = process.env.PI_INPUT_LOCK;
    try {
      delete process.env.PI_INPUT_LOCK;
      expect(isEnabled()).toBe(false);
      process.env.PI_INPUT_LOCK = "1";
      expect(isEnabled()).toBe(true);
    } finally {
      if (previous === undefined) delete process.env.PI_INPUT_LOCK;
      else process.env.PI_INPUT_LOCK = previous;
    }
  });

  it("does not register runtime hooks when disabled", () => {
    const pi: any = { on: vi.fn(), registerCommand: vi.fn() };
    const previous = process.env.PI_INPUT_LOCK;
    try {
      delete process.env.PI_INPUT_LOCK;
      extension(pi);
    } finally {
      if (previous === undefined) delete process.env.PI_INPUT_LOCK;
      else process.env.PI_INPUT_LOCK = previous;
    }
    expect(pi.on).not.toHaveBeenCalled();
    expect(pi.registerCommand).not.toHaveBeenCalled();
  });
});
