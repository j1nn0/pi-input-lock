import { describe, expect, it, vi } from "vitest";
import {
  createInputLockRouter,
  isForeignFocus,
  nextState,
  type InputLockRouterIO,
  type LockState,
} from "../src/index.ts";

function makeHarness(overrides: Partial<InputLockRouterIO> = {}) {
  const state = { locked: true, foreign: false };
  const calls = {
    toggle: vi.fn(),
    render: vi.fn(),
    expand: vi.fn(),
    duplicate: vi.fn((..._args: any[]) => false),
  };
  const tui: any = { requestRender: calls.render };
  const io: InputLockRouterIO = {
    isLocked: () => state.locked,
    dialogOpen: () => state.foreign,
    getTui: () => tui,
    isDuplicateNav: (data, source) => {
      calls.duplicate(data, source);
      return false;
    },
    toggle: () => {
      calls.toggle();
      state.locked = false;
    },
    expandTools: calls.expand,
    requestRender: (target) => target?.requestRender?.(),
    ...overrides,
  };
  return {
    state,
    calls,
    tui,
    input: createInputLockRouter(io, "input"),
    terminal: createInputLockRouter(io, "terminal"),
  };
}

describe("router with foreign focus", () => {
  it("passes every non-toggle key through", () => {
    const h = makeHarness();
    h.state.foreign = true;
    for (const data of ["\r", "text", "\x1b[B", "\x1bOB", "?", "\x1b"]) {
      expect(h.terminal(data)).toBeUndefined();
      expect(h.input(data)).toBeUndefined();
    }
    expect(h.calls.toggle).not.toHaveBeenCalled();
  });

  it("consumes the toggle without changing the active UI", () => {
    const h = makeHarness();
    h.state.foreign = true;
    expect(h.terminal("\x1b\x09")).toEqual({ consume: true });
    expect(h.input("\x1b\x09")).toBeUndefined();
    expect(h.calls.toggle).not.toHaveBeenCalled();
    expect(h.state.locked).toBe(true);
  });
});

describe("router with owned focus", () => {
  it("handles the toggle once through the terminal channel", () => {
    const h = makeHarness();
    expect(h.terminal("\x1b\x09")).toEqual({ consume: true });
    expect(h.input("\x1b\x09")).toBeUndefined();
    expect(h.calls.toggle).toHaveBeenCalledTimes(1);
    expect(h.calls.render).toHaveBeenCalledTimes(1);
  });

  it("blocks text, submit, paste, and non-arrow control input while locked", () => {
    const h = makeHarness();
    for (const data of ["a", "\r", "paste text", "\x02\x05", "\x1bz"]) {
      expect(h.input(data)).toEqual({ consume: true });
    }
  });


  it("passes CSI and SSU arrow sequences through", () => {
    const h = makeHarness();
    for (const data of ["\x1b[A", "\x1b[B", "\x1bOA", "\x1bOB", "\x1b[1;5C"]) {
      expect(h.input(data)).toBeUndefined();
      expect(h.terminal(data)).toBeUndefined();
    }
  });

  it("passes all input through when unlocked", () => {
    const h = makeHarness();
    h.state.locked = false;
    for (const data of ["a", "\r", "paste text", "\x1b[B"]) {
      expect(h.input(data)).toBeUndefined();
      expect(h.terminal(data)).toBeUndefined();
    }
  });

  it("consumes duplicate deliveries without invoking the action twice", () => {
    const duplicate = vi.fn(() => true);
    const h = makeHarness({ isDuplicateNav: duplicate });
    expect(h.input("x")).toEqual({ consume: true });
    expect(h.calls.toggle).not.toHaveBeenCalled();
    expect(duplicate).toHaveBeenCalledWith("x", "input");
  });
});


describe("tool expansion while locked", () => {
  const PRESS = "\x1b[111;1u";
  const REPEAT = "\x1b[111;1:2u";
  const RELEASE = "\x1b[111;1:3u";

  it("blocks expansion by default", () => {
    const h = makeHarness();

    expect(h.input(PRESS)).toEqual({ consume: true });
    expect(h.terminal(PRESS)).toEqual({ consume: true });
    expect(h.calls.expand).not.toHaveBeenCalled();
  });

  it("dispatches an injected expand action exactly once across both channels", () => {
    const matcher = vi.fn(() => true);
    const h = makeHarness({ matchesToolExpand: matcher });

    expect(h.input(PRESS)).toEqual({ consume: true });
    expect(h.calls.expand).not.toHaveBeenCalled();
    expect(h.terminal(PRESS)).toEqual({ consume: true });
    expect(h.calls.expand).toHaveBeenCalledTimes(1);

    for (const data of [REPEAT, REPEAT, RELEASE]) {
      expect(h.input(data)).toEqual({ consume: true });
      expect(h.terminal(data)).toEqual({ consume: true });
    }
    expect(h.calls.expand).toHaveBeenCalledTimes(1);
    expect(matcher).toHaveBeenCalledTimes(2);
  });

  it("does not dispatch for repeats or releases without a press", () => {
    const h = makeHarness({ matchesToolExpand: () => true });

    for (const data of [REPEAT, RELEASE]) {
      expect(h.input(data)).toEqual({ consume: true });
      expect(h.terminal(data)).toEqual({ consume: true });
    }
    expect(h.calls.expand).not.toHaveBeenCalled();
  });

  it("keeps ordinary text and submit input blocked", () => {
    const h = makeHarness({ matchesToolExpand: () => false });

    for (const data of ["text", "\r"]) {
      expect(h.input(data)).toEqual({ consume: true });
    }
    expect(h.calls.expand).not.toHaveBeenCalled();
  });

  it("leaves an expand key to a foreign UI", () => {
    const h = makeHarness({ matchesToolExpand: () => true });
    h.state.foreign = true;

    expect(h.terminal(PRESS)).toBeUndefined();
    expect(h.input(PRESS)).toBeUndefined();
    expect(h.calls.expand).not.toHaveBeenCalled();
  });

  it("uses the injected action match rather than hardcoded ctrl+o", () => {
    const remapped = makeHarness({
      matchesToolExpand: (data) => data === "\x0f",
    });
    expect(remapped.terminal("\x0f")).toEqual({ consume: true });
    expect(remapped.calls.expand).toHaveBeenCalledTimes(1);

    const rawCtrlO = makeHarness({ matchesToolExpand: () => false });
    expect(rawCtrlO.terminal("\x0f")).toEqual({ consume: true });
    expect(rawCtrlO.calls.expand).not.toHaveBeenCalled();
  });
});

describe("focus comparison", () => {
  it("treats only exact owned references as local", () => {
    const editor = {};
    const owned = { editor, help: {}, searchComponent: {} };
    expect(isForeignFocus(editor, owned)).toBe(false);
    expect(isForeignFocus({}, owned)).toBe(true);
    expect(isForeignFocus(undefined, owned)).toBe(false);
  });
});

// One physical toggle-key press toggles exactly once. Kitty repeat (event
// type 2) and release (event type 3) share the press codepoint/modifier but
// must never toggle, or WATCH would bounce straight back on key release.
const PRESS = "\x1b[105;7u";
const REPEAT = "\x1b[105;7:2u";
const RELEASE = "\x1b[105;7:3u";

function makeStateHarness(initial: LockState) {
  let state: LockState = initial;
  let foreign = false;
  const toggle = vi.fn(() => {
    state = nextState(state, "toggle");
  });
  const tui: any = { requestRender: vi.fn() };
  const io: InputLockRouterIO = {
    lockState: () => state,
    dialogOpen: () => foreign,
    getTui: () => tui,
    toggle,
    requestRender: (target) => target?.requestRender?.(),
  };
  return {
    get state(): LockState {
      return state;
    },
    get foreign(): boolean {
      return foreign;
    },
    setForeign: (value: boolean) => {
      foreign = value;
    },
    toggle,
    terminal: createInputLockRouter(io, "terminal"),
    input: createInputLockRouter(io, "input"),
  };
}

describe("press-only toggle (Kitty event types)", () => {
  it("toggles WATCH->OVERRIDE exactly once across press, repeat, and release", () => {
    const h = makeStateHarness("WATCH");
    expect(h.input(PRESS)).toBeUndefined();
    expect(h.toggle).not.toHaveBeenCalled();
    expect(h.terminal(PRESS)).toEqual({ consume: true });
    expect(h.state).toBe("OVERRIDE");
    expect(h.toggle).toHaveBeenCalledTimes(1);
    expect(h.terminal(REPEAT)).toBeUndefined();
    expect(h.state).toBe("OVERRIDE");
    expect(h.terminal(RELEASE)).toBeUndefined();
    expect(h.state).toBe("OVERRIDE");
    expect(h.toggle).toHaveBeenCalledTimes(1);
  });

  it("toggles OVERRIDE->WATCH exactly once across press, repeat, and release", () => {
    const h = makeStateHarness("OVERRIDE");
    expect(h.terminal(PRESS)).toEqual({ consume: true });
    expect(h.state).toBe("WATCH");
    expect(h.toggle).toHaveBeenCalledTimes(1);
    expect(h.terminal(REPEAT)).toEqual({ consume: true });
    expect(h.state).toBe("WATCH");
    expect(h.terminal(RELEASE)).toEqual({ consume: true });
    expect(h.state).toBe("WATCH");
    expect(h.toggle).toHaveBeenCalledTimes(1);
  });

  it("toggles exactly once for a long hold (press + repeats + release)", () => {
    const h = makeStateHarness("WATCH");
    h.terminal(PRESS);
    h.terminal(REPEAT);
    h.terminal(REPEAT);
    h.terminal(REPEAT);
    h.terminal(RELEASE);
    expect(h.toggle).toHaveBeenCalledTimes(1);
    expect(h.state).toBe("OVERRIDE");
  });

  it("leaves a foreign UI untouched for press, repeat, and release", () => {
    const h = makeStateHarness("WATCH");
    h.setForeign(true);
    expect(h.terminal(PRESS)).toEqual({ consume: true });
    expect(h.terminal(REPEAT)).toBeUndefined();
    expect(h.terminal(RELEASE)).toBeUndefined();
    expect(h.input(PRESS)).toBeUndefined();
    expect(h.toggle).not.toHaveBeenCalled();
    expect(h.state).toBe("WATCH");
    expect(h.foreign).toBe(true);
  });

  it("keeps IDLE a no-op for press, repeat, and release", () => {
    const h = makeStateHarness("IDLE");
    h.terminal(PRESS);
    h.terminal(REPEAT);
    h.terminal(RELEASE);
    expect(h.state).toBe("IDLE");
  });
});
