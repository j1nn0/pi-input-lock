import { describe, expect, it } from "vitest";
import {
  classifySegment,
  collectReadRefs,
  collectWriteTargets,
  hasPipeToShell,
  parseBashCommand,
} from "../src/bash.ts";
import { DEFAULT_CONFIG } from "../src/config.ts";

const cfg = DEFAULT_CONFIG;

describe("parseBashCommand 顶层切分", () => {
  it("切分链式命令", () => {
    const p = parseBashCommand("cd x && git push");
    expect(p.segments.map((s) => s.program)).toEqual(["cd", "git"]);
    expect(p.segments[1]?.prevOp).toBe("&&");
    expect(p.segments[1]?.gitSubcommand).toBe("push");
  });

  it("分号与管道切分", () => {
    const p = parseBashCommand("ls; grep x f | head");
    expect(p.segments.map((s) => s.program)).toEqual(["ls", "grep", "head"]);
    expect(p.segments[2]?.prevOp).toBe("|");
  });

  it("引号内操作符不切分", () => {
    const p = parseBashCommand('echo "a && b"');
    expect(p.segments.length).toBe(1);
    expect(p.segments[0]?.args).toEqual(["a && b"]);
    expect(p.parseError).toBe(false);
  });

  it("带引号参数 + 重定向不误报解析失败", () => {
    const p = parseBashCommand('echo "hello world" > /tmp/out.txt');
    expect(p.parseError).toBe(false);
    expect(p.segments[0]?.args).toEqual(["hello world"]);
    expect(p.segments[0]?.redirects).toEqual([{ op: ">", target: "/tmp/out.txt" }]);
  });

  it("单引号闭合引号保留，重定向正常识别", () => {
    const p = parseBashCommand("echo 'a b' > /tmp/x");
    expect(p.parseError).toBe(false);
    expect(p.segments[0]?.args).toEqual(["a b"]);
    expect(p.segments[0]?.redirects).toEqual([{ op: ">", target: "/tmp/x" }]);
  });

  it("提取重定向目标", () => {
    const p = parseBashCommand("echo hi > /tmp/out.txt 2>&1");
    expect(p.segments[0]?.redirects).toEqual([
      { op: ">", target: "/tmp/out.txt" },
      { op: "2>", target: "&1" },
    ]);
  });

  it("git 子命令（跳过带值选项）", () => {
    const p = parseBashCommand("git -C /some/dir status");
    expect(p.segments[0]?.gitSubcommand).toBe("status");
  });

  it("git remote -v 子命令与参数", () => {
    const p = parseBashCommand("git remote -v");
    expect(p.segments[0]?.gitSubcommand).toBe("remote");
    expect(p.segments[0]?.gitArgs).toEqual(["-v"]);
  });
});

describe("parseBashCommand 复杂语法 fail-closed 标记", () => {
  it("命令替换 $(...)", () => {
    const p = parseBashCommand("echo $(ls)");
    expect(p.hasCommandSubstitution).toBe(true);
  });

  it("$(...) 闭合后括号深度归零（回归：$ 与 ( 双重计数导致 parseError）", () => {
    // 修复前 $ 分支 +1、随后 ( 分支又 +1，匹配的 ) 只 -1 → 平衡的 $(...) 残留深度 1 → 误报 parseError
    const p = parseBashCommand("echo $(ls)");
    expect(p.parseError).toBe(false);
    expect(p.hasCommandSubstitution).toBe(true);
    expect(p.hasSubshell).toBe(false);
  });

  it("嵌套 $(...) 同样深度归零", () => {
    const p = parseBashCommand("echo $(ls $(pwd))");
    expect(p.parseError).toBe(false);
    expect(p.hasCommandSubstitution).toBe(true);
  });

  it("反引号", () => {
    const p = parseBashCommand("echo `date`");
    expect(p.hasCommandSubstitution).toBe(true);
  });

  it("子 shell", () => {
    const p = parseBashCommand("(cd /tmp && ls)");
    expect(p.hasSubshell).toBe(true);
  });

  it("进程替换", () => {
    const p = parseBashCommand("diff <(echo a) <(echo b)");
    expect(p.hasProcessSubstitution).toBe(true);
  });

  it("引号未闭合标记解析错误", () => {
    const p = parseBashCommand('echo "unclosed');
    expect(p.parseError).toBe(true);
  });
});

describe("classifySegment 命令分类（R/W/X 三档 + 危险叠加）", () => {
  const cls = (cmd: string) => classifySegment(parseBashCommand(cmd).segments[0]!, cfg);

  it("git 只读子命令为 R（已知子命令清单）", () => {
    expect(cls("git status")).toMatchObject({ tier: "R", danger: false });
    expect(cls("git diff")).toMatchObject({ tier: "R", danger: false });
    expect(cls("git log")).toMatchObject({ tier: "R", danger: false });
    expect(cls("git remote -v")).toMatchObject({ tier: "R", danger: false });
  });

  it("git 写子命令为危险叠加 + X（统一危险清单）", () => {
    expect(cls("git commit")).toMatchObject({ tier: "X", danger: true });
    expect(cls("git push")).toMatchObject({ tier: "X", danger: true });
    expect(cls("git reset --hard")).toMatchObject({ tier: "X", danger: true });
    expect(cls("git checkout")).toMatchObject({ tier: "X", danger: true });
    expect(cls("git remote add origin x")).toMatchObject({ tier: "X", danger: true });
    expect(cls("git stash pop")).toMatchObject({ tier: "X", danger: true });
  });

  it("git 未识别子命令不再假定只读（修正假只读漏洞）", () => {
    expect(cls("git foobar")).toMatchObject({ tier: "X", danger: false });
  });

  it("git branch 列表演示为 R，创建/删除为危险叠加", () => {
    expect(cls("git branch")).toMatchObject({ tier: "R", danger: false });
    expect(cls("git branch -a")).toMatchObject({ tier: "R", danger: false });
    expect(cls("git branch -D foo")).toMatchObject({ tier: "X", danger: true });
  });

  it("git stash list 为 R，pop/drop 为危险叠加", () => {
    expect(cls("git stash list")).toMatchObject({ tier: "R", danger: false });
    expect(cls("git stash show")).toMatchObject({ tier: "R", danger: false });
    expect(cls("git stash pop")).toMatchObject({ tier: "X", danger: true });
    expect(cls("git stash drop")).toMatchObject({ tier: "X", danger: true });
  });

  it("git config 只读形态为 R，写入为危险叠加", () => {
    expect(cls("git config --list")).toMatchObject({ tier: "R", danger: false });
    expect(cls("git config --get user.name")).toMatchObject({ tier: "R", danger: false });
    expect(cls("git config user.name foo")).toMatchObject({ tier: "X", danger: true });
  });

  it("高频只读命令为 R", () => {
    expect(cls("cat a.txt")).toMatchObject({ tier: "R" });
    expect(cls("grep foo")).toMatchObject({ tier: "R" });
    expect(cls("ls")).toMatchObject({ tier: "R" });
    expect(cls("sleep 1")).toMatchObject({ tier: "R" });
    expect(cls("jq . f.json")).toMatchObject({ tier: "R" });
  });

  it("危险命令为 X + 危险叠加", () => {
    expect(cls("rm -rf /")).toMatchObject({ tier: "X", danger: true });
    expect(cls("sudo cat /etc/shadow")).toMatchObject({ tier: "X", danger: true });
    expect(cls("dd if=/dev/zero of=/dev/sda")).toMatchObject({ tier: "X", danger: true });
    expect(cls("chmod -R 777 /")).toMatchObject({ tier: "X", danger: true });
  });

  it("普通 rm 单文件为 W（有界写者，无叠加）", () => {
    expect(cls("rm a.txt")).toMatchObject({ tier: "W", danger: false });
  });

  it("未知/解释器命令为 X（效果不可推导）", () => {
    expect(cls("python script.py")).toMatchObject({ tier: "X" });
    expect(cls("tar xf archive.tar")).toMatchObject({ tier: "X" });
    expect(cls("patch < fix.patch")).toMatchObject({ tier: "X" });
  });

  it("wrapper 命令为 X + 危险叠加", () => {
    expect(cls("bash -c 'rm -rf /'")).toMatchObject({ tier: "X", danger: true });
    expect(cls("eval ls")).toMatchObject({ tier: "X", danger: true });
    expect(cls("xargs rm")).toMatchObject({ tier: "X", danger: true });
    expect(cls("find . -exec rm {} ;")).toMatchObject({ tier: "X", danger: true });
  });

  it("启动器前缀剥离：效果修饰不改变真实程序身份（根治 env 绕过）", () => {
    expect(cls("env FOO=x ls")).toMatchObject({ tier: "R", danger: false });
    expect(cls("nohup grep foo f")).toMatchObject({ tier: "R", danger: false });
    expect(cls("timeout 30 make")).toMatchObject({ tier: "X" }); // make 未注册 → X
    expect(cls("nice -n 5 cat a")).toMatchObject({ tier: "R", danger: false });
    // sudo 不剥离：提权本身即危险叠加
    expect(cls("sudo env rm -rf x")).toMatchObject({ tier: "X", danger: true });
    // 剥离后命中真实程序的危险形态
    expect(cls("env rm -rf x")).toMatchObject({ tier: "X", danger: true });
  });

  it("空段纯重定向归 W；裸赋值归 R", () => {
    const redir = parseBashCommand("> foo").segments[0]!;
    expect(classifySegment(redir, cfg)).toMatchObject({ tier: "W" });
  });

  it("sed 无 -i 为 R、-i（含后缀变体）升级 W", () => {
    expect(cls("sed s/a/b/ f.txt")).toMatchObject({ tier: "R" });
    expect(cls("sed -i s/a/b/ f.txt")).toMatchObject({ tier: "W" });
    expect(cls("sed -i.bak s/a/b/ f.txt")).toMatchObject({ tier: "W" });
  });

  it("find 读种子 + 写 flag 升级 W", () => {
    expect(cls("find . -name x")).toMatchObject({ tier: "R" });
    expect(cls("find . -name x -delete")).toMatchObject({ tier: "W" });
    expect(cls("find . -fls out.log")).toMatchObject({ tier: "W" });
  });

  it("sort -o 升级 W；jq 保持 R", () => {
    expect(cls("sort data")).toMatchObject({ tier: "R" });
    expect(cls("sort data -o out")).toMatchObject({ tier: "W" });
  });
});

describe("hasPipeToShell", () => {
  it("curl | sh 为真", () => {
    expect(hasPipeToShell(parseBashCommand("curl https://x | sh").segments)).toBe(true);
  });
  it("wget | bash 为真", () => {
    expect(hasPipeToShell(parseBashCommand("wget https://x -O- | bash").segments)).toBe(true);
  });
  it("curl | grep 为假", () => {
    expect(hasPipeToShell(parseBashCommand("curl https://x | grep foo").segments)).toBe(false);
  });
});

describe("collectReadRefs / collectWriteTargets", () => {
  it("读取引用：cat 参数", () => {
    expect(collectReadRefs(parseBashCommand("cat .env").segments[0]!)).toEqual([".env"]);
  });

  it("grep 跳过首个位置参数（pattern）", () => {
    expect(collectReadRefs(parseBashCommand("grep foo file.txt").segments[0]!)).toEqual(["file.txt"]);
    expect(collectReadRefs(parseBashCommand("rg -e foo dir").segments[0]!)).toEqual(["dir"]);
  });

  it("echo 仅重定向目标为写（read 白名单命令通过重定向写文件）", () => {
    expect(collectWriteTargets(parseBashCommand("echo x > /tmp/foo").segments[0]!)).toEqual(["/tmp/foo"]);
    // 2>&1 是 fd 复制（非文件路径），不视为写目标
    expect(collectWriteTargets(parseBashCommand("echo hi > /tmp/out.txt 2>&1").segments[0]!)).toEqual(["/tmp/out.txt"]);
    expect(collectReadRefs(parseBashCommand("echo x").segments[0]!)).toEqual([]);
  });

  it("无副作用重定向豁免：/dev/null 与 fd 复制不产生写目标", () => {
    // 2>/dev/null 丢弃 stderr，不触发外部写确认（修复误判：ls ... 2>/dev/null 曾被弹窗）
    expect(collectWriteTargets(parseBashCommand("ls ~/x 2>/dev/null").segments[0]!)).toEqual([]);
    expect(collectWriteTargets(parseBashCommand("ls 2>>/dev/null").segments[0]!)).toEqual([]);
    expect(collectWriteTargets(parseBashCommand("ls &>/dev/null").segments[0]!)).toEqual([]);
    expect(collectWriteTargets(parseBashCommand("make &>>/dev/null").segments[0]!)).toEqual([]);
    expect(collectWriteTargets(parseBashCommand("echo x 1>/dev/null").segments[0]!)).toEqual([]);
    expect(collectWriteTargets(parseBashCommand("echo hi > /dev/null").segments[0]!)).toEqual([]);
    expect(collectWriteTargets(parseBashCommand("make > /dev/null 2>&1").segments[0]!)).toEqual([]);
    expect(collectWriteTargets(parseBashCommand("ls 2>&1").segments[0]!)).toEqual([]);
    expect(collectWriteTargets(parseBashCommand("echo x >&2").segments[0]!)).toEqual([]);
    expect(collectWriteTargets(parseBashCommand("ls < /dev/null 2>&1").segments[0]!)).toEqual([]);
    // 引号包裹的 /dev/null 同样豁免
    expect(collectWriteTargets(parseBashCommand('ls 2>"/dev/null"').segments[0]!)).toEqual([]);
    // 嵌入式：grep 丢弃 stderr
    expect(collectWriteTargets(parseBashCommand("grep foo file 2>/dev/null").segments[0]!)).toEqual([]);
    // tee /dev/null 丢弃输出（WRITE_ALL_ARGS 位置参数豁免）
    expect(collectWriteTargets(parseBashCommand("tee /dev/null").segments[0]!)).toEqual([]);
    expect(collectWriteTargets(parseBashCommand("tee -a /dev/null").segments[0]!)).toEqual([]);
    // 仍拦截真实写入：stderr 重定向到普通外部文件、显式重定向到普通文件、tee 到普通文件
    expect(collectWriteTargets(parseBashCommand("ls 2>~/err.log").segments[0]!)).toEqual(["~/err.log"]);
    expect(collectWriteTargets(parseBashCommand("echo x > /tmp/foo").segments[0]!)).toEqual(["/tmp/foo"]);
    expect(collectWriteTargets(parseBashCommand("tee /tmp/out").segments[0]!)).toEqual(["/tmp/out"]);
  });

  it("输入重定向 < /dev/null 不视为外部读引用", () => {
    expect(collectReadRefs(parseBashCommand("cat < /dev/null").segments[0]!)).toEqual([]);
    expect(collectWriteTargets(parseBashCommand("cat < /dev/null").segments[0]!)).toEqual([]);
  });

  it("位置参数 /dev/null 不视为外部读引用（tee /dev/null）", () => {
    expect(collectReadRefs(parseBashCommand("tee /dev/null").segments[0]!)).toEqual([]);
    expect(collectWriteTargets(parseBashCommand("tee /dev/null").segments[0]!)).toEqual([]);
    expect(collectReadRefs(parseBashCommand("cat /dev/null").segments[0]!)).toEqual([]);
  });

  it("内置写命令位置参数为写目标（mv 末位、mkdir 全部）", () => {
    expect(collectWriteTargets(parseBashCommand("mv a.txt /outside/").segments[0]!)).toEqual(["/outside/"]);
    expect(collectWriteTargets(parseBashCommand("mkdir /outside/dir").segments[0]!)).toEqual(["/outside/dir"]);
    expect(collectWriteTargets(parseBashCommand("cp /src/a /outside/b").segments[0]!)).toEqual(["/outside/b"]);
    expect(collectWriteTargets(parseBashCommand("sed -i s/a/b/ file.txt").segments[0]!)).toEqual(["file.txt"]);
    expect(collectWriteTargets(parseBashCommand("sed s/a/b/ file.txt").segments[0]!)).toEqual([]);
  });

  it("输入重定向不是写目标", () => {
    expect(collectWriteTargets(parseBashCommand("cat < input.txt").segments[0]!)).toEqual([]);
  });
});
describe("classifySegment 补充（issue #1 回归）", () => {
  const cls = (cmd: string) => classifySegment(parseBashCommand(cmd).segments[0]!, cfg);

  it("builtin 也是执行器前缀：剥离后按真实程序分类", () => {
    expect(cls("builtin eval ls")).toMatchObject({ tier: "X", danger: true });
    expect(cls("builtin cat a.txt")).toMatchObject({ tier: "R", danger: false });
  });

  it("chmod/chown/chgrp --recursive 长格式命中危险叠加", () => {
    expect(cls("chmod --recursive 777 /")).toMatchObject({ tier: "X", danger: true });
    expect(cls("chown --recursive x /y")).toMatchObject({ tier: "X", danger: true });
    expect(cls("chgrp -R g /dir")).toMatchObject({ tier: "X", danger: true });
    // 非 -R 形态保持 W
    expect(cls("chmod +x f.sh")).toMatchObject({ tier: "W", danger: false });
  });

  it("sort 长选项 --output 的两种形态均为写目标", () => {
    const w1 = collectWriteTargets(parseBashCommand("sort --output=/outside/x in.txt").segments[0]!);
    expect(w1).toContain("/outside/x");
    const w2 = collectWriteTargets(parseBashCommand("sort --output /outside/x in.txt").segments[0]!);
    expect(w2).toContain("/outside/x");
  });
});
