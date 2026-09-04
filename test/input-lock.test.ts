import { describe, expect, it, vi } from "vitest";
import { CURSOR_MARKER, visibleWidth } from "@earendil-works/pi-tui";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  getActiveToggleLabel,
  getAllowToolExpandInWatchCached,
  getToggleKeyId,
  getUnlockPolicyCached,
  isEnabled,
  isForeignFocus,
  isLockedState,
  LockStateMachine,
  LockedEditor,
  matchesToggleKey,
  nextState,
  nextStateWithPolicy,
  resetInputLockConfigCache,
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
  let toolsExpanded = false;
  const getToolsExpanded = vi.fn(() => toolsExpanded);
  const setToolsExpanded = vi.fn((value: boolean) => {
    toolsExpanded = value;
  });
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
    getToolsExpanded,
    setToolsExpanded,
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
    keybindings,
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
    get toolsExpanded() {
      return toolsExpanded;
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


async function withHomeConfigFiles<T>(
  files: { canonical?: Record<string, unknown> | string; legacy?: Record<string, unknown> | string },
  run: () => Promise<T> | T,
): Promise<T> {
  const previousHome = process.env.HOME;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-input-lock-test-"));
  try {
    if (files.canonical !== undefined) {
      const dir = path.join(tmp, ".pi", "agent");
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(
        path.join(dir, "pi-input-lock.json"),
        typeof files.canonical === "string" ? files.canonical : JSON.stringify(files.canonical),
      );
    }
    if (files.legacy !== undefined) {
      const dir = path.join(tmp, ".pi", "agent", "extensions", "pi-input-lock");
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, "config.json"), typeof files.legacy === "string" ? files.legacy : JSON.stringify(files.legacy));
    }
    process.env.HOME = tmp;
    resetInputLockConfigCache();
    return await run();
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    resetInputLockConfigCache();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

async function withHomeConfig<T>(
  config: Record<string, unknown> | string | undefined,
  run: () => Promise<T> | T,
): Promise<T> {
  return withHomeConfigFiles(config === undefined ? {} : { legacy: config }, run);
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


  it("preserves every v0.1.5 transition under the default policy", () => {
    const cases = [
      ["IDLE", "toggle", "IDLE"],
      ["WATCH", "toggle", "OVERRIDE"],
      ["OVERRIDE", "toggle", "WATCH"],
      ["IDLE", "agent_start", "WATCH"],
      ["OVERRIDE", "agent_start", "OVERRIDE"],
      ["WATCH", "agent_settled", "IDLE"],
    ] as const;

    for (const [state, event, expected] of cases) {
      expect(nextStateWithPolicy(state, event, "agent-settled", false)).toBe(expected);
    }
  });

  it("applies the manual unlock policy matrix", () => {
    const cases = [
      ["IDLE", "agent_start", true, "WATCH"],
      ["WATCH", "agent_start", true, "WATCH"],
      ["OVERRIDE", "agent_start", true, "OVERRIDE"],
      ["IDLE", "agent_settled", false, "IDLE"],
      ["WATCH", "agent_settled", false, "WATCH"],
      ["OVERRIDE", "agent_settled", false, "IDLE"],
      ["WATCH", "toggle", true, "OVERRIDE"],
      ["WATCH", "toggle", false, "IDLE"],
      ["OVERRIDE", "toggle", true, "WATCH"],
      ["IDLE", "toggle", true, "IDLE"],
      ["IDLE", "toggle", false, "WATCH"],
    ] as const;

    for (const [state, event, agentActive, expected] of cases) {
      expect(nextStateWithPolicy(state, event, "manual", agentActive)).toBe(expected);
    }
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


describe("configuration", () => {
  it("uses the default policy and disables tool expansion without a config", async () => {
    await withHomeConfig(undefined, () => {
      expect(getAllowToolExpandInWatchCached()).toBe(false);
      expect(getUnlockPolicyCached()).toBe("agent-settled");
    });
  });

  it("merges a partial config with the defaults", async () => {
    await withHomeConfig({ allowToolExpandInWatch: true }, () => {
      expect(getAllowToolExpandInWatchCached()).toBe(true);
      expect(getUnlockPolicyCached()).toBe("agent-settled");
      expect(getToggleKeyId()).toBe("ctrl+alt+i");
    });
  });

  it("normalizes non-boolean tool expansion values to false", async () => {
    await withHomeConfig({ allowToolExpandInWatch: "true" }, () => {
      expect(getAllowToolExpandInWatchCached()).toBe(false);
    });
  });

  it("accepts manual and agent-settled policies and defaults invalid values", async () => {
    await withHomeConfig({ unlockPolicy: "manual" }, () => {
      expect(getUnlockPolicyCached()).toBe("manual");
    });
    await withHomeConfig({ unlockPolicy: "agent-settled" }, () => {
      expect(getUnlockPolicyCached()).toBe("agent-settled");
    });
    await withHomeConfig({ unlockPolicy: "invalid" }, () => {
      expect(getUnlockPolicyCached()).toBe("agent-settled");
    });
  });

  it("uses defaults for malformed configuration", async () => {
    await withHomeConfig("{", () => {
      expect(getAllowToolExpandInWatchCached()).toBe(false);
      expect(getUnlockPolicyCached()).toBe("agent-settled");
    });
  });
});

describe("user config paths", () => {
  it("loads the canonical user config", async () => {
    await withHomeConfigFiles(
      { canonical: { toggleKey: "ctrl+q", allowToolExpandInWatch: true, unlockPolicy: "manual" } },
      () => {
        expect(getToggleKeyId()).toBe("ctrl+q");
        expect(getAllowToolExpandInWatchCached()).toBe(true);
        expect(getUnlockPolicyCached()).toBe("manual");
      },
    );
  });

  it("loads the legacy fallback when only it exists", async () => {
    await withHomeConfigFiles(
      { legacy: { toggleKey: "ctrl+x", allowToolExpandInWatch: true, unlockPolicy: "manual" } },
      () => {
        expect(getToggleKeyId()).toBe("ctrl+x");
        expect(getAllowToolExpandInWatchCached()).toBe(true);
        expect(getUnlockPolicyCached()).toBe("manual");
      },
    );
  });

  it("prefers the canonical config over legacy without merging", async () => {
    await withHomeConfigFiles(
      {
        canonical: { toggleKey: "ctrl+x" },
        legacy: { toggleKey: "ctrl+y", allowToolExpandInWatch: true, unlockPolicy: "manual" },
      },
      () => {
        expect(getToggleKeyId()).toBe("ctrl+x");
        expect(getAllowToolExpandInWatchCached()).toBe(false);
        expect(getUnlockPolicyCached()).toBe("agent-settled");
      },
    );
  });

  it("uses defaults for a malformed canonical config", async () => {
    await withHomeConfigFiles({ canonical: "{" }, () => {
      expect(getToggleKeyId()).toBe("ctrl+alt+i");
      expect(getAllowToolExpandInWatchCached()).toBe(false);
      expect(getUnlockPolicyCached()).toBe("agent-settled");
    });
  });

  it("does not fall back to legacy when the canonical config is malformed", async () => {
    await withHomeConfigFiles(
      {
        canonical: "{",
        legacy: { toggleKey: "ctrl+x", allowToolExpandInWatch: true, unlockPolicy: "manual" },
      },
      () => {
        expect(getToggleKeyId()).toBe("ctrl+alt+i");
        expect(getAllowToolExpandInWatchCached()).toBe(false);
        expect(getUnlockPolicyCached()).toBe("agent-settled");
      },
    );
  });

  it("loads a combined config from the canonical path", async () => {
    await withHomeConfigFiles(
      {
        canonical: { toggleKey: "ctrl+x", allowToolExpandInWatch: true, unlockPolicy: "manual" },
      },
      () => {
        expect(getToggleKeyId()).toBe("ctrl+x");
        expect(getAllowToolExpandInWatchCached()).toBe(true);
        expect(getUnlockPolicyCached()).toBe("manual");
      },
    );
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
    // The cursor anchor leads the stable centered row while focused and armed.
    expect(row?.startsWith(CURSOR_MARKER)).toBe(true);
    expect(row?.includes(CURSOR_MARKER)).toBe(true);
    const stripped = (row as string).slice(CURSOR_MARKER.length);
    expect(stripped).toBe(" ".repeat(Math.floor((60 - visibleWidth(label)) / 2)) + label);
    expect(stripped.startsWith(" ")).toBe(true);
    expect(stripped.endsWith(" ")).toBe(false);
    expect(lines).not.toContain(" ".repeat(60));
    expect(lines.every((line) => line.split(CURSOR_MARKER).length - 1 <= 1)).toBe(true);
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

  it("can gate the cursor anchor off and on again", () => {
    const editor = new LockedEditor({} as any, theme, {});

    editor.setMarkerEnabled(false);
    expect(editor.render(60).some((line) => line.includes(CURSOR_MARKER))).toBe(false);

    editor.setMarkerEnabled(true);
    const enabled = editor.render(60);
    expect(enabled.some((line) => line.includes(CURSOR_MARKER))).toBe(true);
    expect(enabled[1]?.startsWith(CURSOR_MARKER)).toBe(true);
  });

  it("emits no anchor while the TUI has focused something else", () => {
    const editor = new LockedEditor({} as any, theme, {});

    // The real TUI flips this field when focus moves (Focusable contract).
    (editor as any).focused = false;
    expect(editor.render(60).some((line) => line.includes(CURSOR_MARKER))).toBe(false);

    (editor as any).focused = true;
    expect(editor.render(60)[1]?.startsWith(CURSOR_MARKER)).toBe(true);
  });

  it("keeps the anchor at the start of the single row when the hint is hidden", () => {
    const editor = new LockedEditor({} as any, theme, {}, { showHint: false });
    const lines = editor.render(60);
    const row = lines.find((line) => line.includes("🔒 WATCH"));

    expect(row).toBeDefined();
    expect(lines.indexOf(row as string)).toBe(1);
    expect(row?.startsWith(CURSOR_MARKER)).toBe(true);
    expect(row?.slice(CURSOR_MARKER.length).trim()).toBe("🔒 WATCH");

    editor.setMarkerEnabled(false);
    expect(
      editor.render(60).some((line) => line.includes(CURSOR_MARKER)),
    ).toBe(false);
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

  it("arms the lock anchor while the lock owns focus and disarms it for a foreign dialog", async () => {
    await withEnabled(async () => {
      const factory: EditorFactory = () => ({ name: "editor", getText: () => "" });
      const harness = makeHarness(factory, { name: "editor", getText: () => "" });
      await startExtension(harness);

      harness.idle = false;
      await agentStart(harness);
      const locked = harness.component as LockedEditor;
      expect(locked).toBeInstanceOf(LockedEditor);

      // Own focus: a routing pass leaves the anchor armed.
      harness.clearFocus();
      harness.terminal("focus-probe");
      expect(locked.render(60)[1]?.startsWith(CURSOR_MARKER)).toBe(true);

      // Foreign focus: the gate follows on the next routing pass.
      harness.focus({ name: "ask-user" });
      harness.terminal("foreign-probe");
      expect(locked.render(60).some((line) => line.includes(CURSOR_MARKER))).toBe(false);

      // Foreign UI gone: the anchor is armed again.
      harness.clearFocus();
      harness.terminal("focus-probe");
      expect(locked.render(60)[1]?.startsWith(CURSOR_MARKER)).toBe(true);
    });
  });
});


describe("manual unlock policy", () => {
  it("keeps settled WATCH until an inactive toggle restores the editor and draft", async () => {
    await withHomeConfig({ unlockPolicy: "manual" }, async () => {
      await withEnabled(async () => {
        const customFactory: EditorFactory = vi.fn(() => ({ name: "custom-editor", getText: () => "" }));
        const customEditor = { name: "custom-editor", getText: () => "" };
        const harness = makeHarness(customFactory, customEditor, "manual draft");

        await startExtension(harness);
        expect(harness.component).toBe(customEditor);

        harness.idle = false;
        await agentStart(harness);
        expect(harness.component).toBeInstanceOf(LockedEditor);
        expect(harness.editorText).toBe("");
        expect(harness.activeInputHandlers.size).toBe(1);

        harness.idle = true;
        await agentSettled(harness);
        expect(harness.component).toBeInstanceOf(LockedEditor);
        expect(harness.componentFactory).not.toBe(customFactory);
        expect(harness.editorText).toBe("");
        expect(harness.activeInputHandlers.size).toBe(1);
        expect(harness.ui.setStatus).toHaveBeenLastCalledWith(
          "pi-input-lock",
          expect.stringContaining("🔒 WATCH"),
        );

        harness.terminal("\x1b\x09");
        expect(harness.componentFactory).toBe(customFactory);
        expect(harness.component).not.toBeInstanceOf(LockedEditor);
        expect(harness.editorText).toBe("manual draft");
        expect(harness.activeInputHandlers.size).toBe(0);
      });
    });
  });

  it("allows an inactive IDLE toggle to enter WATCH", async () => {
    await withHomeConfig({ unlockPolicy: "manual" }, async () => {
      await withEnabled(async () => {
        const customFactory: EditorFactory = () => ({ name: "custom-editor", getText: () => "" });
        const customEditor = { name: "custom-editor", getText: () => "" };
        const harness = makeHarness(customFactory, customEditor, "idle manual draft");

        await startExtension(harness);
        expect(harness.component).toBe(customEditor);
        harness.terminal("\x1b\x09");

        expect(harness.component).toBeInstanceOf(LockedEditor);
        expect(harness.editorText).toBe("");
        expect(harness.activeInputHandlers.size).toBe(1);
      });
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


describe("tool expansion wiring", () => {
  it("uses the configured action matcher and display-only fallback", async () => {
    await withHomeConfig({ allowToolExpandInWatch: true }, async () => {
      await withEnabled(async () => {
        const factory: EditorFactory = () => ({ name: "editor", getText: () => "" });
        const harness = makeHarness(factory, { name: "editor", getText: () => "" }, "tool draft");
        harness.keybindings.matches = vi.fn(
          (data: string, action: string) => action === "app.tools.expand" && data === "\x0f",
        );

        await startExtension(harness);
        harness.idle = false;
        await agentStart(harness);

        expect(harness.terminal("\x0f")).toEqual({ consume: true });
        expect(harness.input("\x0f")).toEqual([{ consume: true }]);
        expect(harness.ui.setToolsExpanded).toHaveBeenCalledTimes(1);
        expect(harness.ui.setToolsExpanded).toHaveBeenCalledWith(true);
        expect(harness.toolsExpanded).toBe(true);
        expect(harness.editorText).toBe("");

        harness.terminal("\x1b[111;1:2u");
        harness.terminal("\x1b[111;1:3u");
        expect(harness.ui.setToolsExpanded).toHaveBeenCalledTimes(1);
      });
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


describe("command status", () => {
  it("reports default status without changing the lock surface", async () => {
    await withHomeConfigFiles({ canonical: {} }, async () => {
      await withEnabled(async () => {
        const harness = makeHarness();
        await startExtension(harness);
        const component = harness.component;
        const componentFactory = harness.componentFactory;
        const editorText = harness.editorText;

        await harness.commands[0]!.handler("status", harness.ctx);

        expect(harness.ui.notify).toHaveBeenCalledTimes(1);
        expect(harness.ui.notify).toHaveBeenCalledWith(expect.stringContaining("State: IDLE"), "info");
        expect(harness.ui.notify).toHaveBeenCalledWith(expect.stringContaining("Agent: inactive"), "info");
        expect(harness.ui.notify).toHaveBeenCalledWith(expect.stringContaining("Unlock policy: agent-settled"), "info");
        expect(harness.ui.notify).toHaveBeenCalledWith(expect.stringContaining("Tool expand: disabled"), "info");
        expect(harness.ui.notify).toHaveBeenCalledWith(expect.stringContaining("Toggle: Ctrl + Alt + I"), "info");
        expect(harness.component).toBe(component);
        expect(harness.componentFactory).toBe(componentFactory);
        expect(harness.editorText).toBe(editorText);
        expect(harness.activeInputHandlers.size).toBe(0);
      });
    });
  });

  it("reports active WATCH status without changing the lock surface", async () => {
    await withEnabled(async () => {
      const factory: EditorFactory = () => ({ name: "editor", getText: () => "" });
      const harness = makeHarness(factory, { name: "editor", getText: () => "" });
      await startExtension(harness);
      harness.idle = false;
      await agentStart(harness);
      const component = harness.component;
      const componentFactory = harness.componentFactory;
      const editorText = harness.editorText;
      const activeHandlers = harness.activeInputHandlers.size;

      await harness.commands[0]!.handler("status", harness.ctx);

      expect(harness.ui.notify).toHaveBeenCalledWith(expect.stringContaining("State: WATCH"), "info");
      expect(harness.ui.notify).toHaveBeenCalledWith(expect.stringContaining("Agent: active"), "info");
      expect(harness.component).toBe(component);
      expect(harness.componentFactory).toBe(componentFactory);
      expect(harness.editorText).toBe(editorText);
      expect(harness.activeInputHandlers.size).toBe(activeHandlers);
    });
  });

  it("reports custom policy, tool expansion, and toggle settings through /lock", async () => {
    await withHomeConfigFiles(
      { canonical: { toggleKey: "ctrl+x", allowToolExpandInWatch: true, unlockPolicy: "manual" } },
      async () => {
        await withEnabled(async () => {
          const harness = makeHarness();
          await startExtension(harness);
          expect(harness.commands[1]!.handler).toBe(harness.commands[0]!.handler);

          await harness.commands[1]!.handler("status", harness.ctx);

          expect(harness.ui.notify).toHaveBeenCalledTimes(1);
          expect(harness.ui.notify).toHaveBeenCalledWith(expect.stringContaining("Unlock policy: manual"), "info");
          expect(harness.ui.notify).toHaveBeenCalledWith(expect.stringContaining("Tool expand: enabled"), "info");
          expect(harness.ui.notify).toHaveBeenCalledWith(expect.stringContaining("Toggle: Ctrl + X"), "info");
        });
      },
    );
  });

  it("reports unknown agent activity when the context has no idle check", async () => {
    await withEnabled(async () => {
      const harness = makeHarness();
      await startExtension(harness);
      const statusContext = { ...harness.ctx, isIdle: undefined };

      await harness.commands[0]!.handler("status", statusContext);

      expect(harness.ui.notify).toHaveBeenCalledWith(expect.stringContaining("Agent: unknown"), "info");
      expect(harness.activeInputHandlers.size).toBe(0);
    });
  });

  it("keeps non-status arguments on the existing toggle path", async () => {
    await withEnabled(async () => {
      const factory: EditorFactory = () => ({ name: "editor", getText: () => "" });
      const harness = makeHarness(factory, { name: "editor", getText: () => "" });
      await startExtension(harness);
      const handler = harness.commands[0]!.handler;
      const initialComponent = harness.component;
      const initialComponentFactory = harness.componentFactory;
      const initialEditorText = harness.editorText;

      await handler("", harness.ctx);

      expect(harness.ui.notify).toHaveBeenCalledWith("Input lock is only available while an agent is running.", "info");
      expect(harness.component).toBe(initialComponent);
      expect(harness.componentFactory).toBe(initialComponentFactory);
      expect(harness.editorText).toBe(initialEditorText);
      expect(harness.activeInputHandlers.size).toBe(0);

      harness.idle = false;
      await agentStart(harness);
      harness.ui.notify.mockClear();

      await handler("", harness.ctx);
      expect(harness.component).not.toBeInstanceOf(LockedEditor);
      expect(harness.activeInputHandlers.size).toBe(0);

      await handler("status", harness.ctx);
      expect(harness.ui.notify).toHaveBeenLastCalledWith(expect.stringContaining("State: OVERRIDE"), "info");

      await handler("bogus", harness.ctx);
      expect(harness.component).toBeInstanceOf(LockedEditor);
      expect(harness.activeInputHandlers.size).toBe(1);
    });
  });
});
