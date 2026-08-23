import path from "node:path";
import type { PermissionConfig } from "./config.ts";

/** 重定向目标。 */
export interface Redirect {
  /** 重定向操作符，如 `>`、`>>`、`<`、`2>`。 */
  op: string;
  /** 重定向目标（文件路径或 fd，如 `&1`）。 */
  target: string;
}

/** 顶层命令段。 */
export interface BashSegment {
  /** 段原始文本。 */
  raw: string;
  /** 前一个连接操作符：`&&` / `||` / `;` / `|` / `&` / `换行`。 */
  prevOp: string;
  /** 命令名（basename，去除路径前缀）。 */
  program: string;
  /** 参数（不含重定向）。 */
  args: string[];
  /** 重定向列表。 */
  redirects: Redirect[];
  /** git 子命令（`git <subcommand>`）。 */
  gitSubcommand?: string;
  /** git 子命令后的参数。 */
  gitArgs: string[];
  /** 是否为包装命令（bash -c / eval / sudo / xargs / find -exec 等）。 */
  wrapper: boolean;
}

/** bash 解析结果，供决策层判定（FR-4/FR-5/FR-7/FR-8）。 */
export interface ParsedCommand {
  segments: BashSegment[];
  /** 含命令替换 `$(...)` 或反引号。 */
  hasCommandSubstitution: boolean;
  /** 含进程替换 `<(...)` / `>(...)`。 */
  hasProcessSubstitution: boolean;
  /** 含子 shell `(...)`。 */
  hasSubshell: boolean;
  /** 语法解析失败（引号未闭合等）。 */
  parseError: boolean;
}

/**
 * 效果三档（效果可证明性分类）：
 * - R 纯读者：无文件副作用
 * - W 有界写者：写目标可从参数穷举
 * - X 不透明：效果不可从参数推导（解释器、构建工具、未识别程序、解析失败降级）
 */
export type EffectTier = "R" | "W" | "X";

/** 单段分类结果：效果档位 + 危险叠加标记 + 批准记忆标识。 */
export interface SegmentClass {
  /** 效果档位。 */
  tier: EffectTier;
  /** 危险叠加命中（凌驾档位之上的产品契约层，如 rm -rf / sudo / git push / wrapper）。 */
  danger: boolean;
  /** 会话批准记忆标识：程序名或 `git:<子命令>`。 */
  approvalId: string;
}

const GIT_OPTION_WITH_VALUE = new Set([
  "-C", "-c", "--git-dir", "--work-tree", "--exec-path",
  "--namespace", "--super-prefix", "--object-format", "--no-optional-locks",
]);

const WRAPPER_SHELLS = new Set(["bash", "sh", "zsh", "dash", "ksh"]);

/** 可剥离的启动器前缀：效果修饰程序，不改变真实程序身份；sudo/su 不剥离（提权本身即危险，走叠加）。 */
const STRIPPABLE_LAUNCHERS = new Set(["env", "nohup", "setsid", "stdbuf", "command"]);
/** 变量赋值前缀（`FOO=bar`）：启动段环境设置，剥离后取真实程序。 */
const VAR_ASSIGN = /^[A-Za-z_][A-Za-z0-9_]*=/;
/** 已知只读 git 子命令：不在其中的子命令视为未识别（X），不再假定为只读。 */
export const GIT_READONLY_SUBS = new Set([
  "status", "log", "diff", "show", "fetch", "remote", "branch", "tag", "stash", "config",
  "ls-files", "rev-parse", "describe", "shortlog", "reflog", "grep", "cat-file",
  "blame", "whatchanged", "ls-remote", "symbolic-ref", "var", "version", "help",
]);

/** 顶层连接操作符（引号外、括号外才生效）。 */
const TOP_LEVEL_OPS = ["||", ";;", "|&", "|", ";", "\n"];

/** 顶层切分：感知引号，按 `&&`/`||`/`;`/`|`/`&`/换行 分段，并检测复杂语法标记。 */
function splitTopLevel(command: string): {
  segments: string[];
  ops: string[];
  hasCommandSubstitution: boolean;
  hasProcessSubstitution: boolean;
  hasSubshell: boolean;
  parseError: boolean;
} {
  const segments: string[] = [];
  const ops: string[] = [];
  let current = "";
  let inSingle = false;
  let inDouble = false;
  let escaped = false;
  let parenDepth = 0;
  let hasCommandSubstitution = false;
  let hasProcessSubstitution = false;
  let hasSubshell = false;
  let parseError = false;

  const flush = (op: string) => {
    segments.push(current);
    ops.push(op);
    current = "";
  };

  let i = 0;
  while (i < command.length) {
    const ch = command[i];
    const next = command[i + 1];

    if (escaped) {
      current += ch;
      escaped = false;
      i++;
      continue;
    }
    if (ch === "\\") {
      if (next === "\n") {
        i += 2;
        continue; // 行继续符
      }
      current += ch;
      escaped = true;
      i++;
      continue;
    }
    if (inSingle) {
      // 闭合引号同样保留到 current，保证后续 token 化引号匹配正确
      if (ch === "'") {
        inSingle = false;
        current += ch;
      } else {
        current += ch;
      }
      i++;
      continue;
    }
    if (inDouble) {
      if (ch === '"') {
        inDouble = false;
        current += ch;
      } else if (ch === "$" && next === "(") hasCommandSubstitution = true;
      else if (ch === "`") hasCommandSubstitution = true;
      else current += ch;
      i++;
      continue;
    }

    if (ch === "'") {
      inSingle = true;
      current += ch;
      i++;
      continue;
    }
    if (ch === '"') {
      inDouble = true;
      current += ch;
      i++;
      continue;
    }
    if (ch === "`") {
      hasCommandSubstitution = true;
      current += ch;
      i++;
      continue;
    }
    if (ch === "$" && next === "(") {
      hasCommandSubstitution = true;
      parenDepth++; // 与闭合 ) 配对，深度归零
      current += ch;
      i += 2; // 同时跳过 $ 和 (，避免 ( 分支二次计数把平衡的 $(...) 误判为 parseError
      continue;
    }
    if ((ch === "<" && next === "(") || (ch === ">" && next === "(")) {
      hasProcessSubstitution = true;
      current += ch;
      i++;
      continue;
    }
    if (ch === "(") {
      if (parenDepth === 0) hasSubshell = true;
      parenDepth++;
      current += ch;
      i++;
      continue;
    }
    if (ch === ")") {
      if (parenDepth > 0) parenDepth--;
      else parseError = true;
      current += ch;
      i++;
      continue;
    }

    if (ch === "&") {
      const prev = command[i - 1];
      const next = command[i + 1];
      // 重定向 fd 中的 &（2>&1、&>file、>&2）不是后台分隔符
      if (prev === ">" || next === ">") {
        current += ch;
        i++;
        continue;
      }
      if (next === "&") {
        flush("&&");
        i += 2;
        continue;
      }
      flush("&");
      i++;
      continue;
    }

    if (parenDepth === 0) {
      const op = TOP_LEVEL_OPS.find((o) => command.startsWith(o, i));
      if (op) {
        flush(op.trim() === "" ? "\n" : op);
        i += op.length;
        continue;
      }
    }
    current += ch;
    i++;
  }

  if (inSingle || inDouble || parenDepth !== 0) parseError = true;
  flush("\n");
  return { segments, ops, hasCommandSubstitution, hasProcessSubstitution, hasSubshell, parseError };
}

const REDIRECT_OPS = ["2>>", "&>>", ">>", "2>", "&>", "1>", "<>", "<<", "<", ">"];

function isRedirectStart(raw: string, index: number): boolean {
  return REDIRECT_OPS.some((o) => raw.startsWith(o, index));
}

/** 单段 token 化：切分参数并抽取重定向目标（引号感知）。 */
function tokenizeSegment(raw: string): { tokens: string[]; redirects: Redirect[]; error: boolean } {
  const tokens: string[] = [];
  const redirects: Redirect[] = [];
  let current = "";
  let inSingle = false;
  let inDouble = false;
  let escaped = false;
  let error = false;

  const pushToken = () => {
    if (current !== "") {
      tokens.push(current);
      current = "";
    }
  };

  const readTarget = (start: number): { target: string; end: number } => {
    let j = start;
    while (j < raw.length && /\s/.test(raw[j]!)) j++;
    if (raw[j] === '"' || raw[j] === "'") {
      const quote = raw[j]!;
      j++;
      let target = "";
      while (j < raw.length && raw[j] !== quote) {
        target += raw[j]!;
        j++;
      }
      j++; // 跳过闭合引号
      return { target, end: j };
    }
    let target = "";
    while (j < raw.length && !/\s/.test(raw[j]!) && !isRedirectStart(raw, j)) {
      target += raw[j]!;
      j++;
    }
    return { target, end: j };
  };

  let i = 0;
  while (i < raw.length) {
    const ch = raw[i]!;
    if (escaped) {
      current += ch;
      escaped = false;
      i++;
      continue;
    }
    if (ch === "\\") {
      escaped = true;
      i++;
      continue;
    }
    if (inSingle) {
      if (ch === "'") inSingle = false;
      else current += ch;
      i++;
      continue;
    }
    if (inDouble) {
      if (ch === '"') inDouble = false;
      else current += ch;
      i++;
      continue;
    }
    if (ch === "'") {
      inSingle = true;
      i++;
      continue;
    }
    if (ch === '"') {
      inDouble = true;
      i++;
      continue;
    }
    if (/\s/.test(ch)) {
      pushToken();
      i++;
      continue;
    }
    const rest = raw.slice(i);
    const op = REDIRECT_OPS.find((o) => rest.startsWith(o));
    if (op) {
      pushToken();
      const { target, end } = readTarget(i + op.length);
      // << / <<< / <<- 为 heredoc/herestring，目标是内联内容或标记，不视为文件引用
      const heredoc = op === "<<" || op === "<<<" || op === "<<-";
      if (!heredoc && target !== "") redirects.push({ op, target });
      i = end;
      continue;
    }
    current += ch;
    i++;
  }

  if (inSingle || inDouble) error = true;
  pushToken();
  return { tokens, redirects, error };
}

/** 提取 git 子命令（跳过带值的全局选项如 `-C dir`、`-c key=val`）。 */
function extractGit(args: string[]): { subcommand?: string; gitArgs: string[] } {
  const rest = args.slice(1);
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]!;
    if (GIT_OPTION_WITH_VALUE.has(a) && i + 1 < rest.length) {
      i++;
      continue;
    }
    if (a.startsWith("-")) continue;
    return { subcommand: a, gitArgs: rest.slice(i + 1) };
  }
  return { subcommand: undefined, gitArgs: [] };
}

/** 检测包装命令：bash -c / eval / sudo / xargs / find -exec 等（危险叠加）。 */
function detectWrapper(program: string, args: string[]): boolean {
  if (program === "eval" || program === "sudo" || program === "su" || program === "xargs") {
    return true;
  }
  if (WRAPPER_SHELLS.has(program)) {
    return args.includes("-c");
  }
  if (program === "find") {
    return args.some((a) => a === "-exec" || a === "-execdir" || a === "-ok" || a === "-exec+");
  }
  return false;
}

/** 剥离启动器前缀（env/nice/timeout/nohup/setsid/stdbuf/command/VAR=x），返回真实程序与参数。
 * sudo 不剥离：提权本身即危险叠加。剥离后 tokens 为空（裸 `env`）时保留原程序名（仅打印环境变量，读者）。 */
function stripLauncherPrefix(tokens: string[]): { program: string; args: string[] } {
  const t = [...tokens];
  while (t.length > 0) {
    const head = t[0]!;
    if (head === "sudo" || head === "su") break;
    if (VAR_ASSIGN.test(head) && head.includes("=")) {
      t.shift();
      continue;
    }
    if (STRIPPABLE_LAUNCHERS.has(head)) {
      t.shift();
      // 消费启动器自身的选项：env/stdbuf 的 - 开头 token（如 -i/-X SIZE）；其余启动器无值选项已含于 token
      while (t.length > 0 && (t[0] === "-i" || t[0]!.startsWith("--") || (head === "stdbuf" && /^-[io]/.test(t[0]!)))) {
        // stdbuf 的 -o/-i 可能带值（-o 256K 与 -oL 两种形态），带空格分立时多消费一个
        if ((head === "stdbuf" && /^-[io]$/.test(t[0]!)) || (t[0] === "--suffix")) t.splice(0, 2);
        else t.splice(0, 1);
      }
      continue;
    }
    if (head === "nice") {
      t.shift();
      if (t[0] === "-n" && t.length > 1) t.splice(0, 2);
      continue;
    }
    if (head === "timeout") {
      t.shift();
      // 第一个位置参数是时长（如 30 / 30s / 2m）
      if (t.length > 0 && /^\d/.test(t[0]!)) t.shift();
      continue;
    }
    break;
  }
  if (t.length === 0) {
    // 裸启动器（如 `env`）：还原为自身程序名
    const orig = tokens[0] ?? "";
    return { program: orig === "" ? "" : path.posix.basename(orig), args: [] };
  }
  return { program: path.posix.basename(t[0]!), args: t.slice(1) };
}

/** 解析 bash 命令为顶层命令段结构（自研简化解析器，D11）。 */
export function parseBashCommand(command: string): ParsedCommand {
  const top = splitTopLevel(command);
  const segments: BashSegment[] = [];

  top.segments.forEach((raw, idx) => {
    const trimmed = raw.trim();
    if (trimmed === "") return;
    const { tokens, redirects, error } = tokenizeSegment(trimmed);
    if (error) top.parseError = true;
    const stripped = stripLauncherPrefix(tokens);
    const program = stripped.program;
    const args = stripped.args;
    const git = program === "git" ? extractGit([program, ...args]) : undefined;
    const segment: BashSegment = {
      raw: trimmed,
      prevOp: idx === 0 ? "" : (top.ops[idx - 1] ?? ""),
      program,
      args,
      redirects,
      gitSubcommand: git?.subcommand,
      gitArgs: git?.gitArgs ?? [],
      wrapper: detectWrapper(program, args),
    };
    segments.push(segment);
  });

  return {
    segments,
    hasCommandSubstitution: top.hasCommandSubstitution,
    hasProcessSubstitution: top.hasProcessSubstitution,
    hasSubshell: top.hasSubshell,
    parseError: top.parseError,
  };
}

export type SegmentTier = "R" | "W" | "X";

export interface SegmentClassification {
  /** 效果档位：R 纯读者 / W 有界写者 / X 不透明（效果不可从参数推导）。 */
  tier: SegmentTier;
  /** 危险叠加命中：wrapper、固定规则（rm -r/-f 等）、危险清单。凌驾于档位之上。 */
  danger: boolean;
  /** 会话批准记忆键用的程序标识（git 子命令为 `git:<sub>`）。 */
  id: string;
}

const DANGEROUS_BRANCH_FLAGS = /^-[dDmMcC]$|^--(delete|move|copy|create-reflog)/;

/** find 写动作 flag：目标 = 起始路径（可枚举），命中后段升级为 W。 */
const FIND_WRITE_FLAGS = new Set(["-delete", "-fls", "-fprint", "-fprint0", "-fprintf"]);

/** sed -i 变体（含 `-i.bak` 后缀形态）：原位写入，段升级为 W。 */
const SED_IN_PLACE = /^-i(bak.*|\.[A-Za-z0-9_]+)?$/;

/** 命令段效果分类：R/W/X 三档 + 危险叠加。
 * 判定轴是「副作用能否从参数完整推导」而非程序名认识与否；未识别程序一律 X（fail-closed）。
 * 前缀已在 parseBashCommand 中剥离，此处看到的是真实程序。 */
export function classifySegment(segment: BashSegment, config: PermissionConfig): SegmentClassification {
  const { program } = segment;
  const id = program === "git" && segment.gitSubcommand ? `git:${segment.gitSubcommand}` : program;

  // ---- 空段：纯重定向（如 `> foo`）效果为截断/创建且可枚举 → W；裸赋值无文件副作用 → R ----
  if (program === "") {
    const writes = collectWriteTargets(segment);
    return { tier: writes.length > 0 ? "W" : "R", danger: false, id: "" };
  }

  // ---- 危险叠加 ----
  let danger = false;
  if (segment.wrapper) {
    return { tier: "X", danger: true, id };
  }
  if (program === "git") {
    const sub = segment.gitSubcommand;
    // 裸 git：交互式，不可证 → X
    if (!sub) return { tier: "X", danger: false, id };
    // 危险清单命中的子命令：只读形态豁免叠加，否则叠加 + X
    if (config.dangerousBashCommands.includes(`git ${sub}`)) {
      const danger = !isGitReadonlyForm(segment, sub);
      return { tier: danger ? "X" : "R", danger, id };
    }
    // 未识别子命令不再假定只读（X）；已知只读子命令 → R
    if (!GIT_READONLY_SUBS.has(sub)) return { tier: "X", danger: false, id };
    return { tier: "R", danger: false, id };
  }
  if (program === "rm") {
    if (segment.args.some((a) => a.startsWith("-") && /[rf]/.test(a))) return { tier: "X", danger: true, id };
  } else if ((program === "chmod" || program === "chown") && segment.args.some((a) => a.startsWith("-") && a.includes("R"))) {
    return { tier: "X", danger: true, id };
  }
  if (config.dangerousBashCommands.includes(program)) return { tier: "X", danger: true, id };

  // ---- 档位判定 ----
  // 有界写者注册表（W 种子）：tar 移出（解压目标不可枚举）；sed 特殊（仅 -i 升 W）
  const writeTargets = collectWriteTargets(segment);
  let tier: SegmentTier;
  if (WRITE_LAST_ARG.has(program) || (WRITE_ALL_ARGS.has(program) && program !== "tar")) {
    tier = "W";
  } else if (program === "sed" && segment.args.some((a) => SED_IN_PLACE.test(a))) {
    tier = "W";
  } else if (config.readonlyBashCommands.includes(program)) {
    // 读种子 + 写动作扫描（重定向/sort -o/find 写 flag）→ 升级 W；否则保持 R
    tier = writeTargets.length > 0 ? "W" : "R";
  } else {
    return { tier: "X", danger: false, id };
  }
  // W 目标含 glob（* ?）→ 无法穷举 → 降级 X（保守：plan 落⑤ ask，build 域内仍③放行）
  if (tier === "W" && writeTargets.some((t) => /[*?]/.test(t))) tier = "X";
  return { tier, danger: false, id };
}

/** 命中危险清单的 git 子命令中，仅列表演示的形态仍视为只读（避免误伤 git branch/stash list/remote -v）。 */
function isGitReadonlyForm(segment: BashSegment, sub: string): boolean {
  if (sub === "branch" || sub === "tag") {
    // 带位置参数 = 创建/删除/移动分支或标签 → 写；仅列表演示 → 只读
    return !segment.gitArgs.some((a) => !a.startsWith("-"));
  }
  if (sub === "stash") {
    const first = segment.gitArgs[0];
    return first === "list" || first === "show";
  }
  if (sub === "config") {
    // 只读形态：--list/--get/--get-all/--show-origin 等；`git config <key> <value>` 为写
    return segment.gitArgs.some((a) =>
      a === "--list" || a === "--get" || a === "--get-all" || a === "--show-origin" ||
      a === "--show-scope" || a === "--name-only" || a.startsWith("--get-"),
    );
  }
  if (sub === "remote") {
    const positional = segment.gitArgs.find((a) => !a.startsWith("-"));
    return positional !== "add" && positional !== "set-url" && positional !== "remove" && positional !== "rename";
  }
  return false;
}

/** 管道到 shell 检测：`curl ... | sh` / `wget ... | bash`（FR-4）。 */
export function hasPipeToShell(segments: readonly BashSegment[]): boolean {
  for (let i = 0; i < segments.length - 1; i++) {
    const seg = segments[i]!;
    const next = segments[i + 1]!;
    if ((seg.program === "curl" || seg.program === "wget") && next.prevOp === "|") {
      if (WRAPPER_SHELLS.has(next.program)) return true;
    }
  }
  return false;
}

/** 带值选项（后一 token 为其值，不视为路径）。 */
const OPTIONS_WITH_VALUE = new Set([
  "-e", "-f", "-E", "-F", "-I", "-L", "-P", "-o", "-w", "-c", "-C",
  "--include", "--exclude", "--glob", "--max-depth", "--jobs", "--timeout", "--color", "--regexp", "--file",
]);

/** 读取型路径引用：命令参数中会被当作文件访问的 token（含重定向输入目标）。 */
export function collectReadRefs(segment: BashSegment): string[] {
  const refs: string[] = [];
  for (const r of segment.redirects) {
    // 仅 `<` 输入重定向是读取；其余重定向是写入
    // `< /dev/null` 为惯用写法（丢弃 stdin），无副作用，不视为外部读引用
    if (r.op === "<" && r.target !== "/dev/null") refs.push(r.target);
  }
  if (segment.program === "echo" || segment.program === "printf" || segment.program === "git") {
    return refs;
  }
  const isGrepLike = segment.program === "grep" || segment.program === "rg" || segment.program === "sed";
  // 模式已通过 -e/-E/-f/-F 显式给出时，首个位置参数即为路径而非 pattern
  const patternViaOption = isGrepLike && segment.args.some((a) => a === "-e" || a === "-E" || a === "-f" || a === "-F");
  let skipFirst = isGrepLike && !patternViaOption;
  for (let i = 0; i < segment.args.length; i++) {
    const a = segment.args[i]!;
    if (a.startsWith("-")) {
      if (OPTIONS_WITH_VALUE.has(a) && i + 1 < segment.args.length) i++;
      continue;
    }
    if (skipFirst) {
      skipFirst = false;
      continue;
    }
    // 读取 /dev/null 无副作用（如 `tee /dev/null` 的写位置、`cat /dev/null`），豁免外部读判定
    if (a === "/dev/null") continue;
    refs.push(a);
  }
  return refs;
}

/** 重定向目标是否为无副作用目标（不作为写入目标）：
 * - `/dev/null`：空设备，写入无副作用（`> /dev/null`、`2>/dev/null` 均为惯用写法）
 * - `&N`（如 `&1`、`&2`）：fd 复制（`2>&1`、`>&2`），非文件路径
 */
function isHarmlessRedirectTarget(target: string): boolean {
  return target === "/dev/null" || target.startsWith("&");
}

/** 内置写命令（硬编码，不可配置）：位置参数视为写入目标，用于区分读写语义与外部写判定。
 * tar 已移出（解压目标由包内容决定不可枚举，归 X）；sed 特殊处理（仅 -i 原位写入，含 -i.bak 后缀变体）。 */
const WRITE_LAST_ARG = new Set(["cp", "mv", "ln", "install", "scp", "rsync"]);
const WRITE_ALL_ARGS = new Set([
  "mkdir", "rmdir", "touch", "rm", "tee", "truncate", "unlink", "shred",
  "chmod", "chown", "chgrp", "chattr", "dd",
  "gzip", "gunzip", "bzip2", "xz", "zstd", "zip", "unzip",
]);

/**
 * 提取段内的写入目标：
 * 1. 重定向输出目标（`>`/`>>`/`2>` 等）；
 * 2. 内置写命令的位置参数——cp/mv/ln/install/scp/rsync 取末位（源文件是读取），其余取全部位置参数。
 * 这样 `mv a /outside/` 按「写外部」判定（而非误入 read 白名单语义）。
 */
export function collectWriteTargets(segment: BashSegment): string[] {
  const targets: string[] = [];
  for (const r of segment.redirects) {
    // 输出重定向（> >> 2> &> 等）→ 写入目标；纯输入 < 除外
    // `2>/dev/null` 等 fd 重定向到空设备/&N 不产生文件副作用，豁免
    if (r.op !== "<" && !isHarmlessRedirectTarget(r.target)) targets.push(r.target);
  }
  // find 写动作（-delete/-fls/-fprint*）：目标 = 起始路径（首个位置参数）
  if (segment.program === "find" && segment.args.some((a) => FIND_WRITE_FLAGS.has(a))) {
    const start = segment.args.find((a) => !a.startsWith("-"));
    if (start !== undefined) targets.push(start);
    return targets;
  }
  // sort -o <file>：输出目标可枚举
  if (segment.program === "sort") {
    for (let i = 0; i < segment.args.length; i++) {
      const a = segment.args[i]!;
      if (a === "-o" && i + 1 < segment.args.length) targets.push(segment.args[i + 1]!);
      else if (a.startsWith("-o") && a.length > 2) targets.push(a.slice(2));
    }
  }
  // sed 仅在 -i（含 -i.bak 变体）时原位写入；chmod/chown/chgrp 首位是 mode/owner
  const sedInPlace = segment.program === "sed" && segment.args.some((a) => SED_IN_PLACE.test(a));
  if (WRITE_LAST_ARG.has(segment.program)) {
    const positionals = segment.args.filter((a) => !a.startsWith("-"));
    if (positionals.length > 0) targets.push(positionals[positionals.length - 1]!);
    return targets;
  }
  if (sedInPlace) {
    // sed 原位写：跳过脚本表达式（首个非 flag 位置参数），其余为被编辑文件
    const files = segment.args.filter((a) => !a.startsWith("-")).slice(1);
    targets.push(...files);
    return targets;
  }
  if (WRITE_ALL_ARGS.has(segment.program)) {
    let skipFirst = segment.program === "chmod" || segment.program === "chown" || segment.program === "chgrp";
    for (const a of segment.args) {
      if (a.startsWith("-")) continue;
      if (skipFirst) {
        skipFirst = false;
        continue;
      }
      // /dev/null 无副作用（如 `tee /dev/null` 丢弃输出），豁免
      if (a === "/dev/null") continue;
      targets.push(a);
    }
    return targets;
  }
  return targets;
}