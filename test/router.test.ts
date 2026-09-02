import { describe, expect, it, vi } from "vitest";
import {
  createInputLockRouter,
  isForeignFocus,
  type InputLockRouterIO,
} from "../src/index.ts";

function makeHarness(overrides: Partial<InputLockRouterIO> = {}) {
  const state = { locked: true, foreign: false };
  const calls = { toggle: vi.fn(), render: vi.fn(), duplicate: vi.fn((..._args: any[]) => false) };
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
    expect(h.terminal("\x1bo")).toEqual({ consume: true });
    expect(h.input("\x1bo")).toBeUndefined();
    expect(h.calls.toggle).not.toHaveBeenCalled();
    expect(h.state.locked).toBe(true);
  });
});

describe("router with owned focus", () => {
  it("handles the toggle once through the terminal channel", () => {
    const h = makeHarness();
    expect(h.terminal("\x1bo")).toEqual({ consume: true });
    expect(h.input("\x1bo")).toBeUndefined();
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

describe("focus comparison", () => {
  it("treats only exact owned references as local", () => {
    const editor = {};
    const owned = { editor, help: {}, searchComponent: {} };
    expect(isForeignFocus(editor, owned)).toBe(false);
    expect(isForeignFocus({}, owned)).toBe(true);
    expect(isForeignFocus(undefined, owned)).toBe(false);
  });
});
