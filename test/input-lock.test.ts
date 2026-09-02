import { describe, expect, it, vi } from "vitest";
import {
  isForeignFocus,
  isEnabled,
  isLockedState,
  LockStateMachine,
  LockedEditor,
  matchesToggleKey,
  nextState,
  type LockState,
} from "../src/index.ts";

describe("lock state", () => {
  it("supports manual lock, override, and unlock transitions", () => {
    expect(nextState("IDLE", "toggle")).toBe("IDLE");
    expect(nextState("WATCH", "toggle")).toBe("OVERRIDE");
    expect(nextState("OVERRIDE", "toggle")).toBe("WATCH");
  });

  it("keeps lifecycle transitions available without wiring them in", () => {
    expect(nextState("IDLE", "agent_start")).toBe("WATCH");
    expect(nextState("WATCH", "agent_settled")).toBe("IDLE");
    expect(nextState("OVERRIDE", "agent_start")).toBe("OVERRIDE");
    expect(nextState("OVERRIDE", "agent_settled")).toBe("IDLE");
    expect(nextState("IDLE", "toggle")).toBe("IDLE");
  });

  it("exposes a UI-independent state controller", () => {
    const machine = new LockStateMachine();
    expect(machine.state).toBe("IDLE");
    expect(machine.locked).toBe(false);
    expect(machine.toggle()).toBe("IDLE");
    expect(machine.locked).toBe(false);
    machine.transition("agent_start");
    expect(machine.state).toBe("WATCH");
    expect(machine.locked).toBe(true);
    expect(machine.toggle()).toBe("OVERRIDE");
    expect(machine.locked).toBe(false);
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
  it("matches the default shortcut and does not treat ordinary text as a command", () => {
    expect(matchesToggleKey("\x1b\x09")).toBe(true);
    expect(matchesToggleKey("\x1b[105;6u")).toBe(true);
    expect(matchesToggleKey("\x1b[105;7u")).toBe(true);
    expect(matchesToggleKey("o")).toBe(false);
    expect(matchesToggleKey("\x1b")).toBe(false);
    expect(matchesToggleKey("\x1bo")).toBe(false);
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
  it("renders a centered passive status and ignores input", () => {
    const tui: any = {};
    const theme: any = { borderColor: (text: string) => text, selectList: {} };
    const editor = new LockedEditor(tui, theme, {});
    const lines = editor.render(60);
    const label = "🔒 WATCH · toggle to interact";
    expect(lines).toHaveLength(3);
    expect(lines[1]).toContain(label);
    expect(lines[1]!).toContain(label);
    expect(editor.getText()).toBe("");
    expect(() => editor.handleInput("draft\r")).not.toThrow();
  });
});

describe("extension preservation", () => {
  it("restores the captured editor text after a toggle cycle", async () => {
    const handlers = new Map<string, Function>();
    const commands: Array<{ handler: Function }> = [];
    const pi: any = {
      on: (name: string, handler: Function) => handlers.set(name, handler),
      registerCommand: (_name: string, options: { handler: Function }) => commands.push(options),
    };

    let component: any;
    let componentFactory: any;
    let editorText = "draft prompt";
    let idle = true;
    let terminalRoute: ((data: string) => unknown) | undefined;
    const tui: any = {
      addInputListener: vi.fn(),
      getFocusedComponent: () => component,
      requestRender: vi.fn(),
    };
    const theme: any = { borderColor: (text: string) => text, selectList: {} };
    const keybindings: any = {};
    const ctx: any = {
      ui: {
        tui,
        theme,
        getEditorText: () => editorText,
        setEditorText: (text: string) => { editorText = text; },
        setEditorComponent: (factory: any) => {
          componentFactory = factory;
          component = factory(tui, theme, keybindings);
        },
        onTerminalInput: (handler: (data: string) => unknown) => {
          terminalRoute = handler;
          return () => { terminalRoute = undefined; };
        },
        notify: vi.fn(),
        setStatus: vi.fn(),
      },
      isIdle: () => idle,
    };

    const previousLock = process.env.PI_INPUT_LOCK;
    process.env.PI_INPUT_LOCK = "1";
    const extension = (await import("../src/index.ts")).default;
    extension(pi);
    await handlers.get("session_start")?.({}, ctx);
    expect(componentFactory).toBeTypeOf("function");
    expect(editorText).toBe("draft prompt");

    await commands[0]?.handler("", ctx);
    expect(editorText).toBe("draft prompt");
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      "Input lock is only available while an agent is running.",
      "info",
    );
    vi.mocked(ctx.ui.notify).mockClear();
    vi.mocked(ctx.ui.setStatus).mockClear();

    idle = false;
    await handlers.get("agent_start")?.({}, ctx);
    expect(editorText).toBe("");
    expect(component.getText()).toBe("");
    expect(ctx.ui.setStatus).toHaveBeenLastCalledWith(
      "pi-input-lock",
      expect.stringContaining("🔒 WATCH"),
    );

    await handlers.get("agent_start")?.({}, ctx);
    expect(component.getText()).toBe("");

    terminalRoute?.("\x1b\x09");
    expect(editorText).toBe("draft prompt");
    terminalRoute?.("\x1b\x09");
    expect(editorText).toBe("");

    idle = true;
    await handlers.get("agent_settled")?.({}, ctx);
    expect(editorText).toBe("draft prompt");
    expect(ctx.ui.setStatus).toHaveBeenLastCalledWith("pi-input-lock", undefined);
    if (previousLock === undefined) delete process.env.PI_INPUT_LOCK;
    else process.env.PI_INPUT_LOCK = previousLock;
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

  it("does not register runtime hooks when disabled", async () => {
    const extension = (await import("../src/index.ts")).default;
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
