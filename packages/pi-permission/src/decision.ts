import os from "node:os";
import path from "node:path";
import { BUILTIN_WRITE_TOOLS, type PermissionConfig } from "./config.ts";
import {
  classifySegment,
  collectReadRefs,
  collectWriteTargets,
  hasPipeToShell,
  parseBashCommand,
  type BashSegment,
} from "./bash.ts";
import { expandHome, isSensitivePath, isSensitiveReadException, isTrustedPath, isWithinCwd, realpathDeep, realpathOf } from "./path.ts";

export type DecisionAction = "allow" | "ask" | "deny";

export interface Decision {
  action: DecisionAction;
  /** 命中规则标识。 */
  rule: string;
  /** 面向用户的说明（含 `[bash]` / `[tool:<name>]` 来源前缀，便于对照配置）。 */
  reason: string;
  details?: string[];
  /** 会话批准记忆键用的程序标识（危险/不透明段取最严段；git 子命令为 `git:<sub>`）。 */
  approvalId?: string;
}

export type WorkMode = "build" | "plan" | "yolo";

export interface ToolDecisionRequest {
  mode: WorkMode;
  config: PermissionConfig;
  cwd: string;
  toolName: string;
  input: Record<string, unknown>;
}

export interface BashDecisionRequest {
  mode: WorkMode;
  config: PermissionConfig;
  cwd: string;
  command: string;
}

const home = () => os.homedir();

/** 弹窗展示用命令：空白归一化单行 + 中段省略。
 * pi-tui Text 组件支持自动折行，上限可放宽；中段省略保留头部（程序名/主要参数）与尾部（最终目标路径）。 */
const COMMAND_DISPLAY_MAX = 400;
const DISPLAY_HEAD = 160;
const DISPLAY_TAIL = 200;
function displayCommand(command: string): string {
  const withTilde = command.replace(/\s+/g, " ").trim().replace(home(), "~");
  if (withTilde.length <= COMMAND_DISPLAY_MAX) return withTilde;
  const omitted = withTilde.length - DISPLAY_HEAD - DISPLAY_TAIL;
  return `${withTilde.slice(0, DISPLAY_HEAD)} …(${omitted} chars omitted)… ${withTilde.slice(-DISPLAY_TAIL)}`;
}

/** 复杂命令按顶层段分行展示（≤8 行），超限回退单行中段省略。 */
function displaySegmented(parsed: { segments: { raw: string; prevOp: string }[] }, command: string): string {
  const segs = parsed.segments;
  if (segs.length <= 1 || segs.length > 8) return `bash: ${displayCommand(command)}`;
  const lines = [`bash:`];
  for (let i = 0; i < segs.length; i++) {
    const s = segs[i]!;
    const prefix = i === 0 ? "  " : `  ${s.prevOp} `;
    lines.push(`${prefix}${displayCommand(s.raw)}`);
  }
  return lines.join("\n");
}

/** ask 弹窗触发主体展示行：details 尾部统一加 `bash:<command>`（复杂命令分行）/ `tool:<tool_name>`，与 reason 前缀同源。 */
const bashDetail = (command: string, parsed?: { segments: { raw: string; prevOp: string }[] }) =>
  parsed === undefined ? `bash: ${displayCommand(command)}` : displaySegmented(parsed, command);

/** trusted 外部路径前缀：配置项 ∪ 系统临时目录（os.tmpdir()），去重。 */
function trustedPrefixes(cfg: PermissionConfig): string[] {
  return [...new Set([...cfg.trustedExternalPaths, os.tmpdir()])];
}

/**
 * FR-1 敏感文件检查：任何模式、任何优先级之前评估，命中即 ask（D9：ask 非 deny）。
 * `readRefs` 中命中的 `.env.example` 读取豁免（FR-1 例外）。
 */
function sensitiveDecision(
  paths: string[],
  cwd: string,
  cfg: PermissionConfig,
  readRefs: string[],
  label: string,
): Decision | undefined {
  for (const p of paths) {
    const sensitive = isSensitivePath(p, cfg.sensitivePatterns, cwd, home());
    if (sensitive) {
      const isRead = readRefs.includes(p);
      if (isRead && cfg.envExampleReadAllowed && isSensitiveReadException(p, cwd, home())) continue;
      return { action: "ask", rule: "FR-1", reason: `${label} sensitive file access requires confirmation`, details: [p] };
    }
  }
  return undefined;
}

/** 内置写工具固定 deny（D6：write/edit 固定，不可配置）。 */
function isWriteTool(toolName: string): boolean {
  return BUILTIN_WRITE_TOOLS.includes(toolName);
}

function isReadTool(toolName: string, config: PermissionConfig): boolean {
  return config.readonlyTools.includes(toolName);
}

/** 从工具输入中提取路径（read/write/edit/grep/find/ls 等带 path 参数的工具）。 */
function extractPaths(toolName: string, input: Record<string, unknown>): string[] {
  const raw = input["path"];
  const paths: string[] = [];
  if (typeof raw === "string" && raw !== "") paths.push(raw);
  return paths;
}

/** 工具级决策。
 * plan：write/edit deny → 敏感文件 ask → read 白名单 allow → other ask/deny(strict)（不分 cwd 内外）
 * build：敏感文件 ask → cwd 外 read 白名单 allow / other ask；cwd 内 allow
 */
export function decideToolRequest(req: ToolDecisionRequest): Decision {
  const { mode, config, cwd, toolName, input } = req;
  const label = `[tool:${toolName}]`;
  const paths = extractPaths(toolName, input);
  const readTool = isReadTool(toolName, config);
  const writeTool = isWriteTool(toolName);

  // yolo：彻底放行但敏感文件仍 deny（FR-1）
  if (mode === "yolo") {
    const sensitive = sensitiveDecision(paths, cwd, config, readTool ? paths : [], label);
    if (sensitive) {
      return { action: "deny", rule: "FR-1", reason: `${label} sensitive file access requires confirmation`, details: [...(sensitive.details ?? []), `tool:${toolName}`] };
    }
    return { action: "allow", rule: "yolo", reason: `[yolo] yolo mode, all operations allowed` };
  }

  if (mode === "plan") {
    // 1. 内置 write/edit（W 类，目标单一可枚举）：跨域 → 静默 deny；信任域内敏感 → ask；其余 scratch 写 allow（与 bash 的 tee 同权同责）
    if (writeTool) {
      const nonTrusted = paths.filter((p) => !isTrustedPath(p, trustedPrefixes(config), cwd, home()));
      if (nonTrusted.length > 0 || paths.length === 0) {
        return { action: "deny", rule: "FR-8", reason: `[tool:${toolName}] Plan mode forbids writes outside trusted paths. Use /build for writes.`, details: paths.length > 0 ? paths : undefined };
      }
      const sensitive = sensitiveDecision(paths, cwd, config, [], label);
      if (sensitive) return { ...sensitive, details: [...(sensitive.details ?? []), `tool:${toolName}`] };
      return { action: "allow", rule: "FR-9", reason: `${label} plan mode trusted scratch write allowed`, details: paths };
    }
    // 2. 敏感文件 ask
    const sensitive = sensitiveDecision(paths, cwd, config, readTool ? paths : [], label);
    if (sensitive) return { ...sensitive, details: [...(sensitive.details ?? []), `tool:${toolName}`] };
    // 3. read 白名单放行
    if (readTool) {
      return { action: "allow", rule: "FR-8", reason: `${label} plan mode read-only tool allowed` };
    }
    // 4. 未知工具：strictPlanMode deny，否则 ask（FR-8.3）
    if (config.strictPlanMode) {
      return { action: "deny", rule: "FR-8", reason: `${label} plan mode strict: unknown tool denied`, details: [toolName] };
    }
    return { action: "ask", rule: "FR-8", reason: `${label} plan mode unknown tool requires confirmation`, details: [`tool:${toolName}`] };
  }

  // build 模式
  // 1. 敏感文件 ask（工具层无敏感操作概念，最前）
  const sensitive = sensitiveDecision(paths, cwd, config, readTool ? paths : [], label);
  if (sensitive) return { ...sensitive, details: [...(sensitive.details ?? []), `tool:${toolName}`] };
  // 2. 无路径信息（MCP 等未知工具）→ 视为 cwd 内，放行
  if (paths.length === 0) {
    return { action: "allow", rule: "FR-5", reason: `${label} no external path, allowed` };
  }
  // 3. cwd 外：trusted 赎免放行；read 白名单放行；否则 ask
  const external = paths.filter((p) => !isWithinCwd(p, cwd, home()));
  if (external.length > 0) {
    if (readTool) {
      return { action: "allow", rule: "FR-5", reason: `${label} read-only tool whitelist, external path allowed` };
    }
    // FR-9：外部路径全部落在 trusted 前缀（如 /tmp）→ 放行
    const nonTrusted = external.filter((p) => !isTrustedPath(p, trustedPrefixes(config), cwd, home()));
    if (nonTrusted.length === 0) {
      return { action: "allow", rule: "FR-9", reason: `${label} trusted external path allowed` };
    }
    return { action: "ask", rule: "FR-3", reason: `${label} external path referenced by a non-whitelisted tool requires confirmation`, details: [...nonTrusted, `tool:${toolName}`] };
  }
  // 4. cwd 内放行
  return { action: "allow", rule: "FR-2", reason: `${label} inside project, allowed` };
}

function failClosed(mode: WorkMode, label: string, kind: string, command?: string): Decision {
  // B+ S5 指令式文案：类别 + 改道（拆步骤、去命令替换）
  const msg = `${label} Unverifiable syntax (${kind}). Split into simple sequential commands without $(...)`;
  return mode === "plan"
    ? { action: "deny", rule: "FR-7", reason: msg }
    : {
        action: "ask",
        rule: "FR-7",
        reason: msg,
        // ask 必须带触发命令，否则弹窗无上下文，用户无法定位问题
        details: command === undefined ? undefined : [bashDetail(command)],
      };
}

/**
 * 跟踪链式命令中的 cd，返回每段执行时的有效工作目录。
 * `cd` 无参数 → HOME；`cd -` 或参数无法解析 → undefined（后续相对路径保守按外部处理）；
 * 其他段返回沿用当前目录。
 */
function resolveSegmentCwds(segments: readonly BashSegment[], initialCwd: string): (string | undefined)[] {
  const result: (string | undefined)[] = [];
  let current: string | undefined = initialCwd;
  for (const seg of segments) {
    result.push(current); // 本段在 cd 之前执行，用切换前的目录
    if (seg.program === "cd") {
      const positional = seg.args.filter((a) => !a.startsWith("-"))[0];
      if (positional === undefined) {
        current = home(); // 无参数 cd → HOME
      } else if (positional === "-") {
        current = undefined; // cd - 无法跟踪 → uncertain
      } else if (current !== undefined) {
        const abs = path.resolve(current, expandHome(positional, home()));
        current = realpathDeep(abs) ?? abs;
      }
    }
  }
  return result;
}

/** bash 级决策。
 * plan（不分 cwd 内外）：明确写/敏感操作 deny → 敏感文件 ask → read 白名单 allow → other ask/deny(strict)
 * build：敏感操作 ask → 敏感文件 ask → cwd 外（read 白名单 allow / other ask）；cwd 内 allow
 */
export function decideBashRequest(req: BashDecisionRequest): Decision {
  const { mode, config, cwd, command } = req;
  const label = "[bash]";
  const parsed = parseBashCommand(command);

  // yolo：彻底放行但敏感文件仍 deny（跳过 fail-closed / 管道等检查）
  if (mode === "yolo") {
    // 复用段 cwd 缓存，避免每轮重算
    const yoloSegmentCwds = resolveSegmentCwds(parsed.segments, cwd);
    const yoloSensitive = (() => {
      for (let i = 0; i < parsed.segments.length; i++) {
        const seg = parsed.segments[i]!;
        const segCwd = yoloSegmentCwds[i] ?? cwd;
        const readRefs = collectReadRefs(seg);
        const writeTargets = collectWriteTargets(seg);
        const hit = sensitiveDecision([...readRefs, ...writeTargets], segCwd, config, readRefs, label);
        if (hit) return hit;
      }
      return undefined;
    })();
    if (yoloSensitive) {
      return { action: "deny", rule: "FR-1", reason: yoloSensitive.reason, details: [...(yoloSensitive.details ?? []), bashDetail(command)] };
    }
    // 即使含复杂语法/管道也放行（yolo bypass）
    return { action: "allow", rule: "yolo", reason: `[yolo] yolo mode, all operations allowed` };
  }

  // FR-7 fail-closed：语法无法解析 / 含复杂语法 → build=ask、plan=deny
  if (parsed.parseError) return failClosed(mode, label, "unparseable", command);
  if (parsed.hasCommandSubstitution || parsed.hasProcessSubstitution || parsed.hasSubshell) {
    return failClosed(mode, label, "command substitution/subshell", command);
  }

  if (parsed.segments.length === 0) {
    return { action: "allow", rule: "default", reason: `${label} empty command` };
  }

  // 管道到 shell（curl | sh）：并入危险叠加，走决策表第①步

  // 跟踪 cd：每段的有效工作目录（cd 后相对路径按新目录解析，防 cd 到外部绕过）
  // cd 无法解析（如 `cd -`）时置 undefined，后续相对路径引用保守按外部处理
  const segmentCwds = resolveSegmentCwds(parsed.segments, cwd);
  const uncertainRelative = segmentCwds.includes(undefined);

  // 收集段信息（相对路径按各段有效 cwd 判定内外）
  // trusted 判定按段 cwd 解析（相对路径写 /tmp 也算 trusted）；cd 无法跟踪时相对路径保守视为非 trusted
  const prefixes = trustedPrefixes(config);
  const externalRefs: string[] = [];
  const externalTargets: string[] = [];
  const nonTrustedWriteTargets: string[] = []; // plan：所有写目标中不在 trusted 下
  const sensitiveWriteTargets: string[] = []; // trusted 内但命中敏感文件的写（plan 下也：deny；如 /tmp/.env）
  const nonTrustedExternalRefs: string[] = []; // 外部读中不在 trusted 下
  const nonTrustedExternalTargets: string[] = []; // 外部写中不在 trusted 下
  const isTrustedForSegment = (p: string, segCwd: string): boolean => {
    if (uncertainRelative && !path.isAbsolute(p)) return false;
    return isTrustedPath(p, prefixes, segCwd, home());
  };
  for (let i = 0; i < parsed.segments.length; i++) {
    const seg = parsed.segments[i]!;
    const segCwd = segmentCwds[i] ?? cwd;
    const readRefs = collectReadRefs(seg);
    const writeTargets = collectWriteTargets(seg);
    for (const r of readRefs) {
      const external = uncertainRelative && !path.isAbsolute(r) ? true : !isWithinCwd(r, segCwd, home());
      if (external) {
        externalRefs.push(r);
        if (!isTrustedForSegment(r, segCwd)) nonTrustedExternalRefs.push(r);
      }
    }
    for (const w of writeTargets) {
      const external = uncertainRelative && !path.isAbsolute(w) ? true : !isWithinCwd(w, segCwd, home());
      if (!isTrustedForSegment(w, segCwd)) {
        nonTrustedWriteTargets.push(w);
      } else if (isSensitivePath(w, config.sensitivePatterns, segCwd, home())) {
        // trusted 内但命中敏感文件名/realpath（如 /tmp/.env）：plan 下写仍 deny，不弹 ask
        sensitiveWriteTargets.push(w);
      }
      if (external) {
        externalTargets.push(w);
        if (!isTrustedForSegment(w, segCwd)) nonTrustedExternalTargets.push(w);
      }
    }
  }

  // 敏感文件检查按段执行（相对路径用段的有效 cwd）
  const sensitiveBySegment = (): Decision | undefined => {
    for (let i = 0; i < parsed.segments.length; i++) {
      const seg = parsed.segments[i]!;
      const segCwd = segmentCwds[i] ?? cwd;
      const readRefs = collectReadRefs(seg);
      const writeTargets = collectWriteTargets(seg);
      const hit = sensitiveDecision([...readRefs, ...writeTargets], segCwd, config, readRefs, label);
      if (hit) return hit;
    }
    return undefined;
  };

  const kinds = parsed.segments.map((seg) => classifySegment(seg, config));
  const dangerAny = kinds.some((k) => k.danger) || hasPipeToShell(parsed.segments);
  const hasX = kinds.some((k) => k.tier === "X");
  const allPureR = kinds.every((k) => k.tier === "R");
  // 会话批准记忆 id：危险 > 不透明 > 有界写 > 纯读，取最严段的标识
  const rankOf = (k: (typeof kinds)[number]) => (k.danger ? 3 : k.tier === "X" ? 2 : k.tier === "W" ? 1 : 0);
  let approvalId: string | undefined;
  let bestRank = -1;
  for (let i = 0; i < parsed.segments.length; i++) {
    const r = rankOf(kinds[i]!);
    if (r > bestRank) {
      bestRank = r;
      approvalId = kinds[i]!.id;
    }
  }

  if (mode === "plan") {
    // ① 危险叠加命中 → 静默 deny（本操作停死含变体；显式授权任务其余只读部分继续）
    if (dangerAny) {
      return {
        action: "deny",
        rule: "FR-8",
        reason: `[bash] Dangerous op blocked in plan mode. No workarounds — switch to /build or continue read-only work.`,
        details: [displaySegmented(parsed, command)],
        approvalId,
      };
    }
    // ② 可枚举写目标 ∉ T_plan（含写 cwd 项目文件）→ 静默 deny；X 段普通参数只是引用不算
    if (nonTrustedWriteTargets.length > 0) {
      return {
        action: "deny",
        rule: "FR-8",
        reason: `[bash] Plan mode forbids writes outside trusted paths. Continue read-only work or use /build for writes.`,
        details: [...nonTrustedWriteTargets],
        approvalId,
      };
    }
    // ③ 涉及敏感文件（不分读写；能走到此处的写必然在 trusted 内）→ ask
    const sensitive = sensitiveBySegment();
    if (sensitive) return { ...sensitive, details: [...(sensitive.details ?? []), displaySegmented(parsed, command)], approvalId };
    // ④ 可证安全：所有段为 R 或 W（W 写目标已由②证明全 ∈ T_plan）→ allow
    if (!hasX) {
      return { action: "allow", rule: "FR-8", reason: `${label} provable read/trusted-write operations allowed`, approvalId };
    }
    // ⑤ 真兜底：含 X 段（效果不可证明）→ strict 静默 deny / ask
    if (config.strictPlanMode) {
      return {
        action: "deny",
        rule: "FR-10",
        reason: `[bash] Strict plan mode: unverifiable execution blocked. Use commands with provable effects, or switch to /build.`,
        details: [displaySegmented(parsed, command)],
        approvalId,
      };
    }
    return {
      action: "ask",
      rule: "FR-10",
      reason: `[bash] opaque execution cannot be verified in plan mode — the command may write anywhere`,
      details: [displaySegmented(parsed, command)],
      approvalId,
    };
  }

  // build 模式
  // ① 危险叠加命中 → ask
  if (dangerAny) {
    return { action: "ask", rule: "FR-4", reason: `${label} dangerous operation requires confirmation`, details: [bashDetail(command, parsed)], approvalId };
  }
  // ② 涉及敏感文件（不分读写）→ ask
  const sensitive = sensitiveBySegment();
  if (sensitive) return { ...sensitive, details: [...(sensitive.details ?? []), bashDetail(command, parsed)], approvalId };
  // ③ 所有段的引用与写目标全部 ∈ T_build（cwd ∪ trusted）→ allow（R/W/X 同权）
  if (nonTrustedExternalRefs.length === 0 && nonTrustedExternalTargets.length === 0) {
    return { action: "allow", rule: "FR-5", reason: `${label} inside trust domain, allowed`, approvalId };
  }
  // ④ 纯 R（引用任意位置）→ allow
  if (allPureR) {
    return { action: "allow", rule: "FR-5", reason: `${label} read-only command whitelist, external path allowed`, approvalId };
  }
  // ⑤ 兜底：存在跨域写目标 → FR-3（按父目录记忆）；否则 X 跨域引用 → FR-10（按 program 记忆）
  if (nonTrustedExternalTargets.length > 0) {
    return {
      action: "ask",
      rule: "FR-3",
      reason: `${label} writing outside project requires confirmation`,
      details: [...nonTrustedExternalTargets, bashDetail(command, parsed)],
      approvalId,
    };
  }
  return {
    action: "ask",
    rule: "FR-10",
    reason: `${label} external path referenced by an unverifiable command requires confirmation`,
    details: [...nonTrustedExternalRefs, bashDetail(command, parsed)],
    approvalId,
  };
}
