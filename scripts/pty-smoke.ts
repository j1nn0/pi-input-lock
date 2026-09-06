import { createServer, type ServerResponse } from "node:http";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

type ProcessResult = {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
};

type ProcessOptions = {
  cwd: string;
  env: NodeJS.ProcessEnv;
  timeoutMs?: number;
};

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
};

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PI_VERSION = "0.85.1";
const SCRIPT_COMMAND = "script";
const PTY_ROWS = 40;
const PTY_COLS = 120;
const MAX_TRANSCRIPT_BYTES = 300_000;
const DIAGNOSTIC_TRANSCRIPT_BYTES = 12_000;

const TIMEOUTS = {
  version: 15_000,
  pack: 30_000,
  boot: 20_000,
  command: 8_000,
  request: 12_000,
  watch: 12_000,
  response: 12_000,
  settle: 15_000,
  quit: 10_000,
};

const PROCESS_TIMEOUT_GRACE_MS = 500;
const PROCESS_KILL_GRACE_MS = 500;
const PROCESS_OUTPUT_TAIL_BYTES = 2_000;

const INHERITED_ENV_KEYS = [
  "PATH",
  "HOME",
  "TMPDIR",
  "TERM",
  "LANG",
  "LANGUAGE",
  "LC_ALL",
  "LC_CTYPE",
  "LC_COLLATE",
  "LC_MESSAGES",
  "LC_MONETARY",
  "LC_NUMERIC",
  "LC_TIME",
] as const;

const PTY_ENV_KEYS = [
  ...INHERITED_ENV_KEYS,
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "XDG_CACHE_HOME",
  "XDG_STATE_HOME",
  "PI_CODING_AGENT_DIR",
  "PI_CODING_AGENT_SESSION_DIR",
  "PI_OFFLINE",
  "PI_SKIP_VERSION_CHECK",
  "PI_TELEMETRY",
  "PI_TRUE_COLOR",
] as const;

const EXPECTED_PACK_FILES = [
  "CHANGELOG.md",
  "LICENSE",
  "README.ja.md",
  "README.md",
  "index.ts",
  "package.json",
  "pi-input-lock.schema.json",
  "src/index.ts",
];

function deferred<T>(): Deferred<T> {
  let resolvePromise!: (value: T) => void;
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve;
  });
  return { promise, resolve: resolvePromise };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function processTree(rootPid: number): Promise<number[]> {
  if (process.platform === "win32") return [rootPid];
  const entries = await readdir("/proc").catch(() => [] as string[]);
  const children = new Map<number, number[]>();
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue;
    const pid = Number(entry);
    try {
      const stat = await readFile(`/proc/${pid}/stat`, "utf8");
      const match = /^(\d+) \((.*)\) \S+ (\d+)/.exec(stat);
      if (!match) continue;
      const parentPid = Number(match[3]);
      const list = children.get(parentPid) ?? [];
      list.push(pid);
      children.set(parentPid, list);
    } catch {
      // Processes can disappear while /proc is being scanned.
    }
  }
  const result: number[] = [rootPid];
  for (let index = 0; index < result.length; index++) {
    const parentPid = result[index];
    if (parentPid === undefined) break;
    result.push(...(children.get(parentPid) ?? []));
  }
  return result;
}

async function processesWithCommandMarker(marker: string): Promise<number[]> {
  if (process.platform === "win32") return [];
  const entries = await readdir("/proc").catch(() => [] as string[]);
  const matches: number[] = [];
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue;
    const pid = Number(entry);
    if (pid === process.pid) continue;
    try {
      const commandLine = await readFile(`/proc/${pid}/cmdline`, "utf8");
      if (commandLine.includes(marker)) matches.push(pid);
    } catch {
      // Processes can disappear while /proc is being scanned.
    }
  }
  return matches;
}

function signalPid(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(pid, signal);
  } catch {
    // The process may have exited between the scan and the signal.
  }
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function cleanInheritedEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of INHERITED_ENV_KEYS) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  return env;
}

function runProcess(command: string, args: string[], options: ProcessOptions): Promise<ProcessResult> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const commandLine = [command, ...args].map(shellQuote).join(" ");
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timedOut = false;
    let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    let fallbackTimer: ReturnType<typeof setTimeout> | undefined;

    const tail = (value: string): string => {
      if (value.length === 0) return "<empty>";
      return value.length > PROCESS_OUTPUT_TAIL_BYTES ? `...${value.slice(-PROCESS_OUTPUT_TAIL_BYTES)}` : value;
    };
    const timeoutError = (code: number | null, signal: NodeJS.Signals | null): Error =>
      new Error(
        [
          `process timed out: command=${commandLine} timeout=${String(options.timeoutMs)}ms`,
          `exit code=${String(code)} signal=${String(signal)}`,
          `stdout tail: ${tail(stdout)}`,
          `stderr tail: ${tail(stderr)}`,
        ].join("\n"),
      );
    const clearTimers = (): void => {
      if (timeoutTimer) clearTimeout(timeoutTimer);
      if (killTimer) clearTimeout(killTimer);
      if (fallbackTimer) clearTimeout(fallbackTimer);
    };
    const settle = (code: number | null, signal: NodeJS.Signals | null): void => {
      if (settled) return;
      settled = true;
      clearTimers();
      if (timedOut) {
        reject(timeoutError(code, signal));
      } else {
        resolvePromise({ code, signal, stdout, stderr });
      }
    };
    const forceKill = (): void => {
      if (settled) return;
      try {
        child.kill("SIGKILL");
      } catch {
        // The child may have exited between the timeout stages.
      }
      fallbackTimer = setTimeout(() => {
        if (settled) return;
        settled = true;
        clearTimers();
        reject(timeoutError(child.exitCode, child.signalCode ?? "SIGKILL"));
      }, PROCESS_KILL_GRACE_MS);
    };

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.once("error", (error) => {
      if (settled) return;
      if (timedOut) {
        settle(child.exitCode, child.signalCode);
      } else {
        settled = true;
        clearTimers();
        reject(error);
      }
    });
    child.once("close", (code, signal) => settle(code, signal));

    if (options.timeoutMs !== undefined && !settled) {
      timeoutTimer = setTimeout(() => {
        if (settled) return;
        timedOut = true;
        try {
          child.kill("SIGTERM");
        } catch {
          // The child may have exited before the timeout signal.
        }
        killTimer = setTimeout(forceKill, PROCESS_TIMEOUT_GRACE_MS);
      }, options.timeoutMs);
    }
  });
}

function normalizeAnsi(value: string): string {
  return value
    .replace(/\x1b\][\s\S]*?(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b_[\s\S]*?(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\x1b[()][0-2A-Z]/g, "")
    .replace(/\x1b[=>]/g, "")
    .replace(/[\x08\x0f\x0e]/g, "")
    .replaceAll("\r", "\n");
}

function describeExpected(expected: RegExp | string): string {
  return expected instanceof RegExp ? expected.toString() : JSON.stringify(expected);
}

class SmokeFailure extends Error {
  readonly stage: string;
  readonly expected: string;

  constructor(stage: string, expected: string, message: string) {
    super(`${stage}: expected ${expected}\n${message}`);
    this.name = "SmokeFailure";
    this.stage = stage;
    this.expected = expected;
  }
}

class MockCompletionServer {
  private readonly server = createServer((request, response) => {
    void this.handle(request, response);
  });
  private readonly firstRequestDeferred = deferred<void>();
  private readonly releaseDeferred = deferred<void>();
  private readonly activeResponses = new Set<ServerResponse>();
  private started = false;
  private released = false;
  private firstRequestSeen = false;
  private _requestCount = 0;
  private _port = 0;

  get port(): number {
    return this._port;
  }

  get requestCount(): number {
    return this._requestCount;
  }

  get hasHeldResponse(): boolean {
    return this.activeResponses.size > 0 && !this.released;
  }

  get releaseRequested(): boolean {
    return this.released;
  }

  async start(): Promise<void> {
    if (this.started) return;
    await new Promise<void>((resolvePromise, reject) => {
      const onError = (error: Error) => {
        this.server.off("listening", onListening);
        reject(error);
      };
      const onListening = () => {
        this.server.off("error", onError);
        const address = this.server.address();
        if (!address || typeof address === "string") {
          reject(new Error("mock server did not expose a TCP address"));
          return;
        }
        this._port = address.port;
        this.started = true;
        resolvePromise();
      };
      this.server.once("error", onError);
      this.server.once("listening", onListening);
      this.server.listen(0, "127.0.0.1");
    });
  }

  async waitForFirstRequest(timeoutMs: number): Promise<void> {
    await Promise.race([this.firstRequestDeferred.promise, sleep(timeoutMs).then(() => "timeout" as const)]).then(
      (result) => {
        if (result === "timeout") {
          throw new Error(`mock completion request was not received within ${timeoutMs}ms`);
        }
      },
    );
  }

  release(): void {
    if (this.released) return;
    this.released = true;
    this.releaseDeferred.resolve();
  }

  async close(): Promise<void> {
    this.release();
    for (const response of this.activeResponses) {
      response.destroy();
    }
    if (!this.started) return;
    await new Promise<void>((resolvePromise) => {
      this.server.close(() => resolvePromise());
    });
  }

  private async handle(request: import("node:http").IncomingMessage, response: ServerResponse): Promise<void> {
    if (request.method !== "POST" || request.url !== "/v1/chat/completions") {
      response.statusCode = 404;
      response.end();
      return;
    }

    this._requestCount++;

    try {
      for await (const _chunk of request) {
        // Consume the request body. The smoke server intentionally ignores tools.
      }
    } catch {
      return;
    }

    response.statusCode = 200;
    response.setHeader("Content-Type", "text/event-stream");
    response.setHeader("Cache-Control", "no-cache");
    response.setHeader("Connection", "keep-alive");
    response.flushHeaders();
    this.activeResponses.add(response);
    response.once("close", () => this.activeResponses.delete(response));
    if (!this.firstRequestSeen) {
      this.firstRequestSeen = true;
      this.firstRequestDeferred.resolve();
    }

    await this.releaseDeferred.promise;
    if (response.destroyed) return;

    const chunk = {
      id: "pi-input-lock-smoke",
      object: "chat.completion.chunk",
      created: 1,
      model: "mock-model",
      choices: [
        {
          index: 0,
          delta: { role: "assistant", content: "deterministic smoke response" },
          finish_reason: null,
        },
      ],
    };
    const finished = {
      id: "pi-input-lock-smoke",
      object: "chat.completion.chunk",
      created: 1,
      model: "mock-model",
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
    };
    response.write(`data: ${JSON.stringify(chunk)}\n\n`);
    response.write(`data: ${JSON.stringify(finished)}\n\n`);
    response.end("data: [DONE]\n\n");
  }
}

class PtySession {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly processMarker: string;
  private readonly rawChunks: string[] = [];
  private rawLength = 0;
  private _normalized = "";
  private _stderr = "";
  private exitPromise: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  private exitResolve!: (result: { code: number | null; signal: NodeJS.Signals | null }) => void;
  private exited = false;
  private _exitCode: number | null = null;
  private _signal: NodeJS.Signals | null = null;

  constructor(command: string, env: NodeJS.ProcessEnv, processMarker: string) {
    this.processMarker = processMarker;
    this.child = spawn(SCRIPT_COMMAND, ["-qec", command, "/dev/null"], {
      cwd: ROOT,
      env,
      detached: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.exitPromise = new Promise((resolvePromise) => {
      this.exitResolve = resolvePromise;
    });
    this.child.stdout.setEncoding("utf8");
    this.child.stderr.setEncoding("utf8");
    this.child.stdout.on("data", (chunk: string) => this.appendOutput(chunk));
    this.child.stderr.on("data", (chunk: string) => {
      this._stderr += chunk;
      if (this._stderr.length > DIAGNOSTIC_TRANSCRIPT_BYTES) {
        this._stderr = this._stderr.slice(-DIAGNOSTIC_TRANSCRIPT_BYTES);
      }
    });
    this.child.once("error", (error) => {
      this._stderr += `\npty process error: ${error.message}`;
      this.markExit(null, null);
    });
    this.child.once("close", (code, signal) => this.markExit(code, signal));
  }

  get normalized(): string {
    return this._normalized;
  }

  get stderr(): string {
    return this._stderr;
  }

  get exitCode(): number | null {
    return this._exitCode;
  }

  get signal(): NodeJS.Signals | null {
    return this._signal;
  }

  get alive(): boolean {
    return !this.exited;
  }

  mark(): number {
    return this._normalized.length;
  }

  write(value: string | Uint8Array): void {
    if (!this.alive || !this.child.stdin.writable) {
      throw new Error("PTY stdin is not writable");
    }
    this.child.stdin.write(value);
  }

  async waitForText(
    stage: string,
    expected: RegExp | string,
    baseline: number,
    timeoutMs: number,
  ): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    const matcher = expected instanceof RegExp ? new RegExp(expected.source, expected.flags.replace("g", "")) : expected;
    while (Date.now() < deadline) {
      if (!this.alive) {
        throw new SmokeFailure(stage, describeExpected(expected), this.diagnostics());
      }
      const recent = this._normalized.slice(Math.max(0, baseline - 96));
      const matched = typeof matcher === "string" ? recent.includes(matcher) : matcher.test(recent);
      if (matched) return;
      await sleep(25);
    }
    throw new SmokeFailure(stage, describeExpected(expected), this.diagnostics());
  }

  async waitForIdleStatus(stage: string, timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    const expected = /Enabled:\s*yes[\s\S]{0,300}State:\s*IDLE[\s\S]{0,300}Agent:\s*inactive/;
    while (Date.now() < deadline) {
      if (!this.alive) {
        throw new SmokeFailure(stage, describeExpected(expected), this.diagnostics());
      }
      const baseline = this.mark();
      this.write("/input-lock status\r");
      try {
        await this.waitForText(stage, expected, baseline, Math.min(1_000, deadline - Date.now()));
        return;
      } catch (error) {
        if (!(error instanceof SmokeFailure)) throw error;
      }
      await sleep(100);
    }
    throw new SmokeFailure(stage, describeExpected(expected), this.diagnostics());
  }

  async waitForExit(timeoutMs: number): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
    if (this.exited) return { code: this._exitCode, signal: this._signal };
    const timeout = sleep(timeoutMs).then(() => "timeout" as const);
    const result = await Promise.race([this.exitPromise, timeout]);
    if (result === "timeout") {
      throw new SmokeFailure("quit", "PTY exits cleanly", this.diagnostics());
    }
    return result;
  }

  async terminate(): Promise<void> {
    const pid = this.child.pid;
    const discoverTargets = async (): Promise<number[]> => {
      const targets = new Set<number>();
      if (!this.exited && pid !== undefined) {
        for (const target of await processTree(pid)) targets.add(target);
      }
      for (const target of await processesWithCommandMarker(this.processMarker)) targets.add(target);
      targets.delete(process.pid);
      return [...targets].sort((left, right) => right - left);
    };

    for (const [signal, delayMs] of [
      ["SIGINT", 250],
      ["SIGTERM", 500],
      ["SIGKILL", 1_000],
    ] as const) {
      const targets = await discoverTargets();
      if (targets.length === 0) return;
      for (const target of targets) signalPid(target, signal);
      await sleep(delayMs);
      if ((await discoverTargets()).length === 0) return;
    }
  }

  diagnostics(): string {
    const transcript = this._normalized.slice(-DIAGNOSTIC_TRANSCRIPT_BYTES);
    const exitState = this.alive ? "alive" : `exited code=${String(this._exitCode)} signal=${String(this._signal)}`;
    return [
      `pty exit state: ${exitState}`,
      `mock requests: ${mockServerForDiagnostics?.requestCount ?? "unknown"}`,
      "last normalized transcript:",
      transcript || "<empty>",
      this._stderr ? `pty stderr tail:\n${this._stderr}` : "",
    ]
      .filter(Boolean)
      .join("\n");
  }

  private appendOutput(chunk: string): void {
    this.rawChunks.push(chunk);
    this.rawLength += chunk.length;
    while (this.rawLength > MAX_TRANSCRIPT_BYTES && this.rawChunks.length > 1) {
      const removed = this.rawChunks.shift() ?? "";
      this.rawLength -= removed.length;
    }
    this._normalized = normalizeAnsi(this.rawChunks.join(""));
  }

  private markExit(code: number | null, signal: NodeJS.Signals | null): void {
    if (this.exited) return;
    this.exited = true;
    this._exitCode = code;
    this._signal = signal;
    this.exitResolve({ code, signal });
  }

}

let mockServerForDiagnostics: MockCompletionServer | undefined;
let activePty: PtySession | undefined;
let interrupted = false;

function failure(stage: string, expected: RegExp | string, message: string): SmokeFailure {
  const diagnostics = activePty?.diagnostics() ?? "pty was not started";
  return new SmokeFailure(stage, describeExpected(expected), `${message}\n${diagnostics}`);
}

function assertAlive(stage: string): void {
  if (!activePty?.alive) {
    throw failure(stage, "Pi process remains alive", "Pi exited unexpectedly");
  }
}

function assertNotInterrupted(stage: string): void {
  if (interrupted) {
    throw failure(stage, "smoke run continues", "received SIGINT or SIGTERM");
  }
}

async function findFiles(root: string, prefix = ""): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const relativePath = prefix ? join(prefix, entry.name) : entry.name;
    const fullPath = join(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await findFiles(fullPath, relativePath)));
    } else if (entry.isFile()) {
      files.push(relativePath);
    }
  }
  return files;
}

async function makeSmokeEnvironment(root: string): Promise<{
  env: NodeJS.ProcessEnv;
  homeDir: string;
  xdgDir: string;
  agentDir: string;
  sessionDir: string;
}> {
  const homeDir = join(root, "home");
  const xdgDir = join(root, "xdg");
  const xdgConfigDir = join(xdgDir, "config");
  const xdgDataDir = join(xdgDir, "data");
  const xdgCacheDir = join(xdgDir, "cache");
  const xdgStateDir = join(xdgDir, "state");
  const tmpDir = join(root, "tmp");
  const agentDir = join(root, "agent");
  const sessionDir = join(root, "sessions");
  await Promise.all(
    [homeDir, xdgConfigDir, xdgDataDir, xdgCacheDir, xdgStateDir, tmpDir, agentDir, sessionDir].map((directory) =>
      mkdir(directory, { recursive: true }),
    ),
  );

  const env = {
    ...cleanInheritedEnvironment(),
    HOME: homeDir,
    TMPDIR: tmpDir,
    XDG_CONFIG_HOME: xdgConfigDir,
    XDG_DATA_HOME: xdgDataDir,
    XDG_CACHE_HOME: xdgCacheDir,
    XDG_STATE_HOME: xdgStateDir,
    PI_CODING_AGENT_DIR: agentDir,
    PI_CODING_AGENT_SESSION_DIR: sessionDir,
    PI_OFFLINE: "1",
    PI_SKIP_VERSION_CHECK: "1",
    PI_TELEMETRY: "0",
    PI_TRUE_COLOR: "0",
    TERM: "xterm-256color",
  };
  return { env, homeDir, xdgDir, agentDir, sessionDir };
}

async function writeMockConfiguration(agentDir: string, candidateDir: string, port: number): Promise<void> {
  const models = {
    providers: {
      mock: {
        baseUrl: `http://127.0.0.1:${port}/v1`,
        api: "openai-completions",
        apiKey: "dummy-local-smoke-key",
        compat: {
          supportsDeveloperRole: false,
          supportsReasoningEffort: false,
          supportsUsageInStreaming: false,
        },
        models: [
          {
            id: "mock-model",
            name: "Mock Model",
            reasoning: false,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 32_768,
            maxTokens: 1_024,
          },
        ],
      },
    },
  };
  const settings = {
    packages: [candidateDir],
    defaultProjectTrust: "always",
    defaultProvider: "mock",
    defaultModel: "mock-model",
    defaultThinkingLevel: "off",
    defaultTools: [],
    enableInstallTelemetry: false,
  };
  await writeFile(join(agentDir, "models.json"), `${JSON.stringify(models, null, 2)}\n`);
  await writeFile(join(agentDir, "settings.json"), `${JSON.stringify(settings, null, 2)}\n`);
}

function buildPtyCommand(candidateIndex: string, env: NodeJS.ProcessEnv): string {
  const envAssignments = PTY_ENV_KEYS.map((key) => `${key}=${shellQuote(env[key] ?? "")}`);
  const args = [
    "pnpm",
    "exec",
    "pi",
    "-e",
    candidateIndex,
    "-ne",
    "--offline",
    "--model",
    "mock/mock-model",
    "--thinking",
    "off",
    "--no-session",
  ].map(shellQuote);
  return [`stty rows ${PTY_ROWS} cols ${PTY_COLS} && exec env -i`, ...envAssignments, ...args].join(" ");
}

async function checkVersion(env: NodeJS.ProcessEnv): Promise<void> {
  const result = await runProcess("pnpm", ["exec", "pi", "--version"], {
    cwd: ROOT,
    env,
    timeoutMs: TIMEOUTS.version,
  });
  const version = result.stdout.trim();
  if (result.code !== 0 || version !== PI_VERSION) {
    throw new SmokeFailure(
      "version",
      PI_VERSION,
      `pnpm exec pi --version returned ${JSON.stringify(version)} (code=${String(result.code)} signal=${String(result.signal)})`,
    );
  }
  console.log(`PTY smoke: pi ${version}`);
}

async function readPackageVersion(packagePath: string, label: string): Promise<string> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(packagePath, "utf8")) as unknown;
  } catch {
    throw new SmokeFailure("environment", `${label} version`, `could not read the ${label} package version`);
  }
  if (typeof parsed !== "object" || parsed === null || typeof (parsed as { version?: unknown }).version !== "string") {
    throw new SmokeFailure("environment", `${label} version`, `the ${label} package has no valid version`);
  }
  return (parsed as { version: string }).version;
}

async function readCommandVersion(command: string, args: string[], label: string): Promise<string> {
  let result: ProcessResult;
  try {
    result = await runProcess(command, args, {
      cwd: ROOT,
      env: cleanInheritedEnvironment(),
      timeoutMs: TIMEOUTS.version,
    });
  } catch (error) {
    const detail = error instanceof Error ? `: ${error.message}` : "";
    throw new SmokeFailure("environment", `${label} version`, `could not run the ${label} version command${detail}`);
  }
  const lines = `${result.stdout}\n${result.stderr}`
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const version = lines.at(-1);
  if (result.code !== 0 || version === undefined) {
    throw new SmokeFailure("environment", `${label} version`, `${label} version command failed`);
  }
  return version;
}

async function logSafeEnvironment(candidateDir: string): Promise<void> {
  const pnpmVersion = await readCommandVersion("pnpm", ["--version"], "pnpm");
  const scriptVersion = await readCommandVersion(SCRIPT_COMMAND, ["--version"], "script");
  if (!/script/i.test(scriptVersion) || !/util-linux/i.test(scriptVersion)) {
    throw new SmokeFailure("environment", "script from util-linux", "the PTY implementation is not util-linux script");
  }

  const piAiVersion = await readPackageVersion(
    join(ROOT, "node_modules", "@earendil-works", "pi-ai", "package.json"),
    "pi-ai",
  );
  const piCodingAgentVersion = await readPackageVersion(
    join(ROOT, "node_modules", "@earendil-works", "pi-coding-agent", "package.json"),
    "pi-coding-agent",
  );
  const piTuiVersion = await readPackageVersion(
    join(ROOT, "node_modules", "@earendil-works", "pi-tui", "package.json"),
    "pi-tui",
  );
  const candidateVersion = await readPackageVersion(join(candidateDir, "package.json"), "pi-input-lock candidate");

  console.log(`OS/platform: ${process.platform}/${process.arch}`);
  console.log(`Node version: ${process.version}`);
  console.log(`pnpm version: ${pnpmVersion}`);
  console.log(`pi-ai version: ${piAiVersion}`);
  console.log(`pi-coding-agent version: ${piCodingAgentVersion}`);
  console.log(`pi-tui version: ${piTuiVersion}`);
  console.log(`pi-input-lock candidate version: ${candidateVersion}`);
  console.log("PTY implementation: script (util-linux)");
  console.log(`PTY terminal: rows=${PTY_ROWS} cols=${PTY_COLS}`);
}

async function createPackedCandidate(tempRoot: string): Promise<string> {
  const packDir = join(tempRoot, "pack");
  const unpackDir = join(tempRoot, "unpack");
  await mkdir(packDir, { recursive: true });
  await mkdir(unpackDir, { recursive: true });
  const result = await runProcess("pnpm", ["pack", "--pack-destination", packDir], {
    cwd: ROOT,
    env: cleanInheritedEnvironment(),
    timeoutMs: TIMEOUTS.pack,
  });
  if (result.code !== 0) {
    throw new SmokeFailure(
      "pack",
      "pnpm pack succeeds",
      `pnpm pack exited code=${String(result.code)} signal=${String(result.signal)}\n${result.stderr.slice(-4_000)}`,
    );
  }
  const archives = (await readdir(packDir)).filter((name) => name.endsWith(".tgz"));
  if (archives.length !== 1) {
    throw new SmokeFailure("pack", "one package archive", `found ${archives.length} archives in the pack directory`);
  }
  const archiveName = archives[0];
  if (archiveName === undefined) {
    throw new SmokeFailure("pack", "one package archive", "the archive name was missing");
  }
  const archive = join(packDir, archiveName);
  const extract = await runProcess("tar", ["-xzf", archive, "-C", unpackDir], {
    cwd: ROOT,
    env: cleanInheritedEnvironment(),
    timeoutMs: TIMEOUTS.pack,
  });
  if (extract.code !== 0) {
    throw new SmokeFailure(
      "pack",
      "tar extraction succeeds",
      `tar exited code=${String(extract.code)} signal=${String(extract.signal)}\n${extract.stderr.slice(-4_000)}`,
    );
  }
  const candidateDir = join(unpackDir, "package");
  const actualFiles = (await findFiles(candidateDir)).sort();
  if (JSON.stringify(actualFiles) !== JSON.stringify(EXPECTED_PACK_FILES)) {
    throw new SmokeFailure(
      "pack-boundary",
      "exact eight package files",
      `actual files: ${actualFiles.join(", ")}`,
    );
  }
  return candidateDir;
}

function logStage(stage: string): void {
  console.log(`PTY smoke: ${stage}: PASS`);
}

async function sendCommand(
  stage: string,
  command: string,
  expected: RegExp | string,
  timeoutMs = TIMEOUTS.command,
): Promise<void> {
  assertNotInterrupted(stage);
  assertAlive(stage);
  if (!activePty) throw new Error("PTY was not created");
  const baseline = activePty.mark();
  activePty.write(`${command}\r`);
  await activePty.waitForText(stage, expected, baseline, timeoutMs);
  assertAlive(stage);
}

async function runTier1AndTier2(
  candidateDir: string,
  smokeEnv: NodeJS.ProcessEnv,
): Promise<void> {
  const candidateIndex = join(candidateDir, "index.ts");
  const command = buildPtyCommand(candidateIndex, smokeEnv);
  activePty = new PtySession(command, smokeEnv, candidateIndex);

  try {
    await activePty.waitForText("boot", /pi v0\.85\.1/, 0, TIMEOUTS.boot);
    assertAlive("boot");
    logStage("boot");
    await activePty.waitForText("extension-load", /\[Extensions\][\s\S]{0,2000}\bpackage\b/, 0, TIMEOUTS.boot);
    assertAlive("extension-load");
    logStage("extension-load");

    await sendCommand(
      "disabled-status",
      "/input-lock status",
      /Enabled:\s*no[\s\S]{0,300}State:\s*IDLE[\s\S]{0,300}Agent:\s*inactive/,
    );
    logStage("disabled-status");

    await sendCommand("enable", "/input-lock enable", /Input lock enabled/);
    logStage("enable");
    await sendCommand(
      "enabled-status",
      "/input-lock status",
      /Enabled:\s*yes[\s\S]{0,300}State:\s*IDLE[\s\S]{0,300}Agent:\s*inactive/,
    );
    logStage("enabled-status");

    assertAlive("tier2-prompt");
    if (!mockServerForDiagnostics) throw new Error("mock server was not created");
    const promptBaseline = activePty.mark();
    activePty.write("deterministic local smoke prompt\r");
    await mockServerForDiagnostics.waitForFirstRequest(TIMEOUTS.request).catch((error) => {
      throw failure("tier2-request", "one localhost mock completion request", error.message);
    });
    logStage("tier2-request");
    await activePty.waitForText("tier2-watch", /WATCH/, promptBaseline, TIMEOUTS.watch);
    assertAlive("tier2-watch");
    if (!mockServerForDiagnostics.hasHeldResponse || mockServerForDiagnostics.releaseRequested) {
      throw failure(
        "tier2-watch",
        "completion remains held until WATCH is observed",
        "mock response was not held at the WATCH checkpoint",
      );
    }
    logStage("tier2-watch");

    mockServerForDiagnostics.release();
    await activePty.waitForText("tier2-response", /deterministic smoke response/, promptBaseline, TIMEOUTS.response);
    assertAlive("tier2-response");
    logStage("tier2-response");
    await activePty.waitForIdleStatus("tier2-settle-idle", TIMEOUTS.settle);
    if (mockServerForDiagnostics.requestCount !== 1) {
      throw failure(
        "tier2-settle-idle",
        "one deterministic localhost completion",
        `mock server received ${mockServerForDiagnostics.requestCount} completion requests`,
      );
    }
    logStage("tier2-settle-idle");

    await sendCommand(
      "disabled-status-final",
      "/input-lock disable",
      /Input lock disabled/,
    );
    await sendCommand(
      "disabled-status-final",
      "/input-lock status",
      /Enabled:\s*no[\s\S]{0,300}State:\s*IDLE[\s\S]{0,300}Agent:\s*inactive/,
    );
    logStage("disable-final");

    assertAlive("quit-clean");
    activePty.write("\x04");
    const exit = await activePty.waitForExit(TIMEOUTS.quit);
    if (exit.code !== 0 || exit.signal !== null) {
      throw failure(
        "quit-clean",
        "Pi exits with code 0 and no signal",
        `exit code=${String(exit.code)} signal=${String(exit.signal)}`,
      );
    }
    logStage("quit-clean");
  } finally {
    await activePty.terminate();
  }
}

async function main(): Promise<void> {
  const tempRoot = await mkdtemp(join(tmpdir(), "pi-input-lock-pty-smoke-"));
  let server: MockCompletionServer | undefined;
  const onSignal = () => {
    interrupted = true;
    activePty?.terminate().catch(() => {});
    server?.close().catch(() => {});
  };
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);

  try {
    const candidateDir = await createPackedCandidate(tempRoot);
    server = new MockCompletionServer();
    mockServerForDiagnostics = server;
    await server.start();
    const smoke = await makeSmokeEnvironment(tempRoot);
    await writeMockConfiguration(smoke.agentDir, candidateDir, server.port);
    await checkVersion(smoke.env);
    await logSafeEnvironment(candidateDir);
    await runTier1AndTier2(candidateDir, smoke.env);
    console.log("PTY smoke: PASS (Tier 1 + Tier 2)");
  } finally {
    if (activePty) await activePty.terminate();
    if (server) await server.close().catch(() => {});
    mockServerForDiagnostics = undefined;
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
    await rm(tempRoot, { recursive: true, force: true });
  }
}

try {
  await main();
} catch (error) {
  if (error instanceof SmokeFailure) {
    console.error(`PTY smoke: FAIL\n${error.message}`);
  } else {
    const message = error instanceof Error ? error.stack ?? error.message : String(error);
    console.error(`PTY smoke: FAIL\n${message}`);
  }
  process.exitCode = 1;
}
