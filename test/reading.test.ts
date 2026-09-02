import { describe, expect, it, vi } from "vitest";
import {
  isForeignFocus,
  isLockedState,
  LockStateMachine,
  LockedEditor,
  matchesToggleKey,
  nextState,
  type LockState,
} from "../src/index.ts";

describe("lock state", () => {
  it("supports manual lock, override, and unlock transitions", () => {
    expect(nextState("IDLE", "toggle")).toBe("WATCH");
    expect(nextState("WATCH", "toggle")).toBe("OVERRIDE");
    expect(nextState("OVERRIDE", "toggle")).toBe("WATCH");
    expect(nextState("WATCH", "unlock")).toBe("IDLE");
    expect(nextState("IDLE", "lock")).toBe("WATCH");
  });

  it("keeps lifecycle transitions available without wiring them in", () => {
    expect(nextState("IDLE", "agent_start")).toBe("WATCH");
    expect(nextState("WATCH", "agent_settled")).toBe("IDLE");
    expect(nextState("OVERRIDE", "agent_start")).toBe("OVERRIDE");
    expect(nextState("OVERRIDE", "agent_settled")).toBe("IDLE");
  });

  it("exposes a UI-independent state controller", () => {
    const machine = new LockStateMachine();
    expect(machine.state).toBe("IDLE");
    expect(machine.locked).toBe(false);
    expect(machine.toggle()).toBe("WATCH");
    expect(machine.locked).toBe(true);
    expect(machine.toggle()).toBe("OVERRIDE");
    expect(machine.locked).toBe(false);
    expect(machine.unlock()).toBe("IDLE");
  });

  it("only WATCH is blocking", () => {
    const states: LockState[] = ["IDLE", "WATCH", "OVERRIDE"];
    expect(states.map(isLockedState)).toEqual([false, true, false]);
  });
});

describe("toggle key", () => {
  it("matches the default shortcut and does not treat ordinary text as a command", () => {
    expect(matchesToggleKey("\x1bo")).toBe(true);
    expect(matchesToggleKey("o")).toBe(false);
    expect(matchesToggleKey("\x1b")).toBe(false);
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
      },
    };

    const extension = (await import("../src/index.ts")).default;
    extension(pi);
    await handlers.get("session_start")?.({}, ctx);
    expect(componentFactory).toBeTypeOf("function");
    expect(editorText).toBe("draft prompt");

    await commands[0]?.handler("", ctx);
    expect(editorText).toBe("");
    expect(component.getText()).toBe("");

    terminalRoute?.("\x1bo");
    expect(editorText).toBe("draft prompt");
    expect(component.getText()).toBe("");
  });
});
