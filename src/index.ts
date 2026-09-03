/**
 * @j1nn0/pi-input-lock
 *
 * A small safety extension for Pi. The base editor is preserved while the
 * input surface is temporarily replaced by a passive status editor. Raw input
 * is routed through both TUI channels so a locked surface cannot accidentally
 * submit text or trigger an action.
 *
 * Copyright (c) 2026 inobit
 * Copyright (c) 2026 j1nn0
 * SPDX-License-Identifier: MIT
 */
import { CustomEditor, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { matchesKey, visibleWidth, type TUI } from "@earendil-works/pi-tui";

type EditorFactory = (tui: TUI, theme: any, keybindings: any) => any;

export function isEnabled(): boolean {
  try {
    return process.env.PI_INPUT_LOCK === "1";
  } catch {
    return false;
  }
}
export type LockState = "IDLE" | "WATCH" | "OVERRIDE";
export type LockEvent = "toggle" | "agent_start" | "agent_settled";

/**
 * Pure state transition used by the extension and by a future lifecycle hook.
 * WATCH is the only state that blocks input. OVERRIDE is an intentional,
 * temporary escape from WATCH and remains available for lifecycle integration.
 */
export function nextState(state: LockState, event: LockEvent): LockState {
  switch (event) {
    case "toggle":
      if (state === "WATCH") return "OVERRIDE";
      if (state === "OVERRIDE") return "WATCH";
      return "IDLE";
    case "agent_start":
      return state === "OVERRIDE" ? "OVERRIDE" : "WATCH";
    case "agent_settled":
      return "IDLE";
  }
}

export const transitionLockState = nextState;

export function isLockedState(state: LockState): boolean {
  return state === "WATCH";
}

/** State-only controller; UI side effects are deliberately not part of it. */
export class LockStateMachine {
  private currentState: LockState;

  constructor(initialState: LockState = "IDLE") {
    this.currentState = initialState;
  }

  get state(): LockState {
    return this.currentState;
  }

  get locked(): boolean {
    return isLockedState(this.currentState);
  }

  transition(event: LockEvent): LockState {
    this.currentState = nextState(this.currentState, event);
    return this.currentState;
  }

  toggle(): LockState {
    return this.transition("toggle");
  }
}

export interface OwnFocusRefs {
  editor?: unknown;
  help?: unknown;
  searchComponent?: unknown;
}

/** Compare references, never shapes, so a foreign interactive component wins. */
export function isForeignFocus(focus: unknown, own: OwnFocusRefs): boolean {
  if (!focus) return false;
  if (focus === own.editor) return false;
  if (focus === own.help) return false;
  if (focus === own.searchComponent) return false;
  return true;
}

export type RouteResult = { consume: true } | undefined;
export type InputRouteSource = "input" | "terminal";

export interface InputLockRouterIO {
  /** Optional aliases keep the seam convenient for small test harnesses. */
  isLocked?: () => boolean;
  lockState?: () => LockState;
  dialogOpen: () => boolean;
  getTui?: () => any;
  isDuplicateNav?: (data: string, source: InputRouteSource) => boolean;
  toggle: () => void;
  requestRender?: (tui: any) => void;
}
const DEFAULT_TOGGLE_KEY = "ctrl+alt+i";
let cachedToggleKeyRaw: string | undefined;
let hasToggleKeyCache = false;

function getBuiltin(name: string): any {
  try {
    return (globalThis as any).require?.(name) ?? (globalThis as any).process?.getBuiltinModule?.(name);
  } catch {
    return undefined;
  }
}

export function readConfigJson(): any {
  try {
    const fs = getBuiltin("fs");
    const path = getBuiltin("path");
    if (!fs || !path) return undefined;

    let baseDir = "";
    try {
      baseDir = typeof __dirname !== "undefined" ? __dirname : "";
    } catch {
      baseDir = "";
    }

    const candidates = [
      baseDir ? path.join(baseDir, "..", "config.json") : "",
      baseDir ? path.join(baseDir, "config.json") : "",
    ];
    for (const candidate of candidates) {
      if (candidate && fs.existsSync(candidate)) return JSON.parse(fs.readFileSync(candidate, "utf8"));
    }

    const os = getBuiltin("os");
    const home = os?.homedir?.() ?? (process as any).env?.HOME ?? "";
    const userConfig = path.join(home, ".pi", "agent", "extensions", "pi-input-lock", "config.json");
    if (fs.existsSync(userConfig)) return JSON.parse(fs.readFileSync(userConfig, "utf8"));
  } catch {
    // Configuration is optional. A malformed or unavailable file uses defaults.
  }
  return undefined;
}

function readToggleKeyRaw(): string | undefined {
  try {
    const value = readConfigJson()?.toggleKey;
    return typeof value === "string" && value.trim() ? value.trim() : undefined;
  } catch {
    return undefined;
  }
}

export function getToggleKeyRawCached(): string | undefined {
  if (!hasToggleKeyCache) {
    cachedToggleKeyRaw = readToggleKeyRaw();
    hasToggleKeyCache = true;
  }
  return cachedToggleKeyRaw;
}

export function getToggleKeyId(): string {
  const raw = getToggleKeyRawCached();
  return (raw ?? DEFAULT_TOGGLE_KEY).toLowerCase();
}

export function resetToggleKeyCache(): void {
  cachedToggleKeyRaw = undefined;
  hasToggleKeyCache = false;
}

export function matchesToggleKey(data: string): boolean {
  try {
    const keyId = getToggleKeyId();
    if (matchesKey(data, keyId as any)) return true;
    if (keyId === DEFAULT_TOGGLE_KEY && data === "\x1b[105;6u") return true;
    return false;
  } catch {
    return false;
  }
}
function isArrowSequence(data: string): boolean {
  return /^(?:\x1b\[|\x1bO)[0-9;?]*[A-D]$/.test(data);
}

function getRouterLocked(io: InputLockRouterIO): boolean {
  try {
    if (io.isLocked) return io.isLocked();
    if (io.lockState) return isLockedState(io.lockState());
  } catch {
    return false;
  }
  return false;
}

/**
 * Shared router for TUI inputListener and onTerminalInput.
 * The terminal channel owns the toggle action; the other channel defers it so
 * a single physical key cannot cause two state changes.
 */
export function createInputLockRouter(
  io: InputLockRouterIO,
  source: InputRouteSource,
): (data: string) => RouteResult {
  return (data: string): RouteResult => {
    let foreign = false;
    try {
      foreign = io.dialogOpen();
    } catch {
      return undefined;
    }

    const toggle = matchesToggleKey(data);
    if (foreign) {
      if (source === "terminal" && toggle) return { consume: true };
      return undefined;
    }

    if (source === "input" && toggle) return undefined;
    if (source === "terminal" && toggle) {
      try {
        io.toggle();
        io.requestRender?.(io.getTui?.());
      } catch {
        // A failed transition must not break the terminal input pipeline.
      }
      return { consume: true };
    }
    if (!getRouterLocked(io)) return undefined;
    try {
      if (io.isDuplicateNav?.(data, source)) return { consume: true };
    } catch {
      // Duplicate suppression is best effort; the lock itself remains strict.
    }

    // Let native arrow handling reach the focused component in either protocol.
    if (isArrowSequence(data)) return undefined;
    return { consume: true };
  };
}

export class BaseEditor extends CustomEditor {
  constructor(tui: TUI, theme: any, keybindings: any) {
    super(tui, theme, keybindings);
  }
}

export interface LockedEditorOptions {
  accent?: (text: string) => string;
  showHint?: boolean;
}

/** Passive editor shown while input is locked. */
export class LockedEditor extends CustomEditor {
  private readonly accent: (text: string) => string;
  private readonly showHint: boolean;

  constructor(tui: TUI, theme: any, keybindings: any, options: LockedEditorOptions = {}) {
    super(tui, theme, keybindings);
    this.accent = options.accent ?? ((text: string) => text);
    this.showHint = options.showHint ?? true;
  }

  override render(width: number): string[] {
    const text = this.showHint ? "🔒 WATCH · toggle to interact" : "🔒 WATCH";
    const label = this.accent(text);
    const labelWidth = visibleWidth(label);
    const left = Math.max(0, Math.floor((width - labelWidth) / 2));
    const line = " ".repeat(left) + label;
    const fill = " ".repeat(Math.max(0, width - visibleWidth(line)));
    const empty = " ".repeat(Math.max(0, width));
    return [empty, line + fill, empty];
  }

  override handleInput(_data: string): void {}
  override getText(): string { return ""; }
  override getExpandedText(): string { return ""; }
  override setText(_text: string): void {}
  override setPaddingX(_padding: number): void {}
  override setAutocompleteMaxVisible(_maxVisible: number): void {}
}

export default function (pi: ExtensionAPI) {
  if (!isEnabled()) return;
  let lockState: LockState = "IDLE";
  let currentCtx: ExtensionContext | undefined;
  let savedInput = "";
  let latestTui: TUI | undefined;
  let listenerInstalled = false;
  let offTerminalInput: (() => void) | undefined;
  let offInputListener: (() => void) | undefined;
  let savedEditorFactory: EditorFactory | undefined;
  let hasSavedEditorFactory = false;
  let currentEditorFactory: EditorFactory | undefined;
  let hasCurrentEditorFactory = false;
  let currentEditor: object | undefined;
  let currentLockedEditor: object | undefined;
  let lastNavData = "";
  let lastNavAt = 0;
  let lastNavSource: InputRouteSource | undefined;
  const statusKey = "pi-input-lock";

  const getTui = (): any => latestTui ?? (currentCtx as any)?.ui?.tui ?? (currentCtx as any)?.tui;

  const flash = (tui: any, message: string): void => {
    try {
      tui?.flash?.(message);
      return;
    } catch {}
    try {
      currentCtx?.ui?.notify?.(message, "info");
    } catch {}
  };

  const setLockStatus = (state: LockState): void => {
    try {
      const ui: any = currentCtx?.ui;
      if (state === "WATCH") {
        ui?.setStatus?.(statusKey, `🔒 WATCH · ${getActiveToggleLabel()} to interact`);
      } else {
        ui?.setStatus?.(statusKey, undefined);
      }
    } catch {}
  };

  const isDuplicateNav = (data: string, source: InputRouteSource): boolean => {
    const now = Date.now();
    if (source === "terminal" && data === lastNavData && lastNavSource === "input" && now - lastNavAt < 20) {
      return true;
    }
    lastNavData = data;
    lastNavAt = now;
    lastNavSource = source;
    return false;
  };

  const focusedComponent = (tui: any): unknown => {
    try {
      const focused = tui?.getFocusedComponent?.();
      return focused ?? tui?.focusedComponent;
    } catch {
      return undefined;
    }
  };

  const syncCurrentEditor = (): void => {
    const ui: any = currentCtx?.ui;
    if (!ui || typeof ui.getEditorComponent !== "function") return;
    let factory: EditorFactory | undefined;
    try {
      factory = ui.getEditorComponent() as EditorFactory | undefined;
    } catch {
      return;
    }
    if (!hasCurrentEditorFactory || factory !== currentEditorFactory) {
      const focused = focusedComponent(getTui());
      if (focused && typeof focused === "object") currentEditor = focused;
      currentEditorFactory = factory;
      hasCurrentEditorFactory = true;
    }
  };

  const dialogOpen = (): boolean => {
    try {
      syncCurrentEditor();
      const tui = getTui();
      const editor = currentLockedEditor ?? currentEditor;
      if (!editor) return false;
      return isForeignFocus(focusedComponent(tui), { editor });
    } catch {
      return false;
    }
  };

  const themeAccent = (ui: any, text: string): string => {
    try {
      const fg = ui?.theme?.fg;
      return typeof fg === "function" ? fg.call(ui.theme, "accent", text) : text;
    } catch {
      return text;
    }
  };


  const lockedEditorFactory = (ui: any) => (tui: TUI, theme: any, keybindings: any): LockedEditor => {
    latestTui = tui;
    const editor = new LockedEditor(tui, theme, keybindings, {
      accent: (text) => themeAccent(ui, text),
    });
    currentLockedEditor = editor;
    currentEditor = editor;
    return editor;
  };

  /** Borrow the editor only for WATCH and restore the exact captured surface. */
  const applyLockUI = (locked: boolean): boolean => {
    const ui: any = currentCtx?.ui;
    if (!ui || typeof ui.setEditorComponent !== "function") return false;

    if (locked) {
      if (
        typeof ui.getEditorComponent !== "function" ||
        typeof ui.getEditorText !== "function" ||
        typeof ui.setEditorText !== "function"
      ) {
        return false;
      }

      let text: string;
      let editorFactory: EditorFactory | undefined;
      try {
        text = String(ui.getEditorText() ?? "");
        editorFactory = ui.getEditorComponent() as EditorFactory | undefined;
      } catch {
        return false;
      }

      savedEditorFactory = editorFactory;
      hasSavedEditorFactory = true;
      const focused = focusedComponent(getTui());
      if (focused && typeof focused === "object") currentEditor = focused;

      try {
        const lockedFactory = lockedEditorFactory(ui);
        currentEditorFactory = lockedFactory;
        hasCurrentEditorFactory = true;
        ui.setEditorComponent(lockedFactory);
        ui.setEditorText("");
        savedInput = text;
        return true;
      } catch {
        currentLockedEditor = undefined;
        try {
          currentEditorFactory = editorFactory;
          hasCurrentEditorFactory = true;
          ui.setEditorComponent(editorFactory);
          ui.setEditorText(text);
        } catch {
          try {
            currentEditorFactory = undefined;
            hasCurrentEditorFactory = true;
            ui.setEditorComponent(undefined);
            ui.setEditorText(text);
          } catch {}
        }
        savedEditorFactory = undefined;
        hasSavedEditorFactory = false;
        return false;
      }
    }

    const text = savedInput;
    const editorFactory = hasSavedEditorFactory ? savedEditorFactory : undefined;
    let restoredFactory = editorFactory;
    const restore = (factoryToRestore: EditorFactory | undefined): void => {
      ui.setEditorComponent(factoryToRestore);
      if (typeof ui.setEditorText !== "function") throw new Error("editor text setter unavailable");
      ui.setEditorText(text);
    };

    try {
      restore(editorFactory);
    } catch {
      try {
        restore(undefined);
        restoredFactory = undefined;
      } catch {
        return false;
      }
    }

    savedInput = "";
    savedEditorFactory = undefined;
    hasSavedEditorFactory = false;
    currentLockedEditor = undefined;
    currentEditorFactory = restoredFactory;
    hasCurrentEditorFactory = true;
    const focused = focusedComponent(getTui());
    currentEditor = focused && typeof focused === "object" ? focused : undefined;
    return true;
  };

  const applyTransition = (event: LockEvent): boolean => {
    const next = nextState(lockState, event);
    if (next === lockState) {
      if (isLockedState(next) && !listenerInstalled && !installInputListener(getTui())) return false;
      setLockStatus(next);
      return true;
    }

    const wasLocked = isLockedState(lockState);
    const willBeLocked = isLockedState(next);
    if (wasLocked !== willBeLocked) {
      if (dialogOpen()) return false;
      if (!applyLockUI(willBeLocked)) return false;
    }

    if (willBeLocked) {
      if (!installInputListener(getTui())) {
        if (!wasLocked) applyLockUI(false);
        return false;
      }
    } else {
      disposeInputListener();
    }

    lockState = next;
    setLockStatus(lockState);
    return true;
  };

  const forceIdle = (): boolean => {
    const needsRestore = isLockedState(lockState) || currentLockedEditor !== undefined || hasSavedEditorFactory;
    if (needsRestore && dialogOpen()) return false;

    const restored = !needsRestore || applyLockUI(false);
    if (!restored && currentLockedEditor !== undefined) return false;

    disposeInputListener();
    lockState = "IDLE";
    setLockStatus("IDLE");
    if (!restored) {
      savedInput = "";
      savedEditorFactory = undefined;
      hasSavedEditorFactory = false;
    }
    return restored;
  };

  const toggle = (ctx?: ExtensionContext): boolean => {
    if (ctx) currentCtx = ctx;
    if (dialogOpen()) return false;
    return applyTransition("toggle");
  };


  const routerIO: InputLockRouterIO = {
    isLocked: () => isLockedState(lockState),
    dialogOpen,
    getTui,
    isDuplicateNav,
    toggle: () => { toggle(); },
    requestRender: (tui) => {
      try {
        tui?.requestRender?.();
      } catch {}
    },
  };
  const inputRoute = createInputLockRouter(routerIO, "input");
  const terminalRoute = createInputLockRouter(routerIO, "terminal");

  const disposeInputListener = (): void => {
    const disposer = offInputListener;
    offInputListener = undefined;
    listenerInstalled = false;
    try {
      disposer?.();
    } catch {}
  };

  const installInputListener = (tui: any): boolean => {
    if (listenerInstalled) return true;
    if (!tui || typeof tui.addInputListener !== "function") return false;
    try {
      const disposer = tui.addInputListener(inputRoute);
      offInputListener = typeof disposer === "function" ? disposer : undefined;
      listenerInstalled = true;
      return true;
    } catch {
      offInputListener = undefined;
      listenerInstalled = false;
      return false;
    }
  };

  const contextIsIdle = (ctx: ExtensionContext | undefined): boolean | undefined => {
    try {
      const check = (ctx as any)?.isIdle;
      return typeof check === "function" ? Boolean(check.call(ctx)) : undefined;
    } catch {
      return undefined;
    }
  };
  const refreshCtx = (ctx: ExtensionContext | undefined): void => {
    if (!ctx) return;
    currentCtx = ctx;
    try {
      const tui = (ctx as any)?.ui?.tui ?? (ctx as any)?.tui;
      if (tui) latestTui = tui;
    } catch {}
    if (contextIsIdle(ctx) === true && lockState !== "IDLE") forceIdle();
  };

  const installTerminalListener = (ctx: ExtensionContext): void => {
    try {
      offTerminalInput?.();
    } catch {}
    try {
      offTerminalInput = (ctx.ui as any).onTerminalInput?.((data: string) => terminalRoute(data));
    } catch {
      offTerminalInput = undefined;
    }
  };

  const handleAgentStart = async (_event: any, ctx: ExtensionContext): Promise<void> => {
    try {
      refreshCtx(ctx);
      if (contextIsIdle(ctx) !== false || !applyTransition("agent_start")) forceIdle();
    } catch {
      forceIdle();
    }
  };

  const handleAgentSettled = async (_event: any, ctx: ExtensionContext): Promise<void> => {
    try {
      refreshCtx(ctx);
      if (!applyTransition("agent_settled")) forceIdle();
    } catch {
      forceIdle();
    }
  };

  const handleSessionBoundary = async (_event: any, ctx: ExtensionContext): Promise<void> => {
    try {
      refreshCtx(ctx);
      forceIdle();
    } catch {
      try {
        forceIdle();
      } catch {}
    }
    disposeInputListener();
  };

  const handleSessionShutdown = async (_event: any, ctx: ExtensionContext): Promise<void> => {
    try {
      refreshCtx(ctx);
      forceIdle();
    } catch {
      try {
        forceIdle();
      } catch {}
    }
    disposeInputListener();
    try {
      offTerminalInput?.();
    } catch {}
    offTerminalInput = undefined;
  };

  const handleSession = async (_event: any, ctx: ExtensionContext): Promise<void> => {
    let restored = true;
    try {
      restored = forceIdle();
    } catch {
      restored = false;
    }
    disposeInputListener();
    refreshCtx(ctx);

    if (!restored && currentLockedEditor !== undefined && !dialogOpen()) {
      try {
        ctx.ui.setEditorComponent(undefined);
        currentLockedEditor = undefined;
        currentEditorFactory = undefined;
        hasCurrentEditorFactory = false;
      } catch {}
    }

    if (currentLockedEditor === undefined) {
      lockState = "IDLE";
      savedInput = "";
      savedEditorFactory = undefined;
      hasSavedEditorFactory = false;
      currentEditorFactory = undefined;
      hasCurrentEditorFactory = false;
      currentEditor = undefined;
      setLockStatus("IDLE");
    } else {
      setLockStatus(lockState);
    }
    installTerminalListener(ctx);
  };

  pi.on("session_start", handleSession as any);
  pi.on("session_info_changed" as any, async (_event: any, ctx: ExtensionContext) => refreshCtx(ctx));
  pi.on("session_before_switch" as any, handleSessionBoundary as any);
  pi.on("session_before_fork" as any, handleSessionBoundary as any);
  pi.on("session_before_compact" as any, async (_event: any, ctx: ExtensionContext) => refreshCtx(ctx));
  pi.on("session_compact" as any, async (_event: any, ctx: ExtensionContext) => refreshCtx(ctx));
  pi.on("session_before_tree" as any, async (_event: any, ctx: ExtensionContext) => refreshCtx(ctx));
  pi.on("session_tree" as any, async (_event: any, ctx: ExtensionContext) => refreshCtx(ctx));
  pi.on("session_shutdown" as any, handleSessionShutdown as any);
  pi.on("agent_start" as any, handleAgentStart as any);
  pi.on("agent_end" as any, async (_event: any, ctx: ExtensionContext) => refreshCtx(ctx));
  pi.on("agent_settled" as any, handleAgentSettled as any);

  const cmdHandler = async (_args: string, ctx: ExtensionContext): Promise<void> => {
    if (lockState === "IDLE") {
      ctx.ui.notify("Input lock is only available while an agent is running.", "info");
      return;
    }
    if (!toggle(ctx)) {
      flash(getTui(), "Input lock toggle is unavailable while another UI has focus");
      return;
    }
    const label = getActiveToggleLabel();
    ctx.ui.notify(lockState === "WATCH" ? `Input locked (${label})` : "Input unlocked", "info");
  };

  pi.registerCommand("input-lock", {
    description: "Toggle the Pi input safety lock",
    handler: cmdHandler,
  });
  pi.registerCommand("lock", {
    description: "Toggle the Pi input safety lock",
    handler: cmdHandler,
  });

  function getActiveToggleLabel(): string {
    try {
      return getToggleKeyRawCached() ?? "Ctrl+Alt+I";
    } catch {
      return "Ctrl+Alt+I";
    }
  }
}
