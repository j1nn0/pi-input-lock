# @j1nn0/pi-input-lock

Pi coding agent 的独立扩展包，面向 `@earendil-works/pi-coding-agent` 0.84.2+，经 jiti 直载，无需编译。当前阶段只完成从 monorepo 提升为单包；现有阅读模式行为保持不变，后续再演进输入锁语义。

## 技术栈

- Node >=24 · pnpm 11.22.0（由 `packageManager` 锁定）
- TypeScript ^7.0.0（仅 `tsc --noEmit` 类型检查，无构建产物）
- vitest ^4.1.8（仅 devDependency）
- 运行时零第三方依赖；Pi 核心包只在 `peerDependencies` 声明

## 结构

- `package.json`：发布元数据、Pi 入口和脚本
- `index.ts`：根入口，转出 `src/index.ts`
- `src/index.ts`：阅读模式扩展的全部实现
- `test/`：阅读与按键路由测试
- `config.json`：本地/安装目录的可选配置（被 `.gitignore` 忽略）

## 常用命令

```bash
pnpm install
pnpm check
pnpm test
pnpm pack:check
pi -ne -e . --tui-mode fullscreen
```

## 目标与约束

- `INSERT` 态透传输入，`READING` 态通过 `TUI inputListener` 与 `ctx.ui.onTerminalInput` 双通道拦截按键。
- 阅读模式支持 Vim 风格滚动、语义跳转、搜索、帮助浮层和 OSC133 prompt 序号锚定；修改路由行为时先补 `test/router.test.ts`。
- `ScrollReaderEditor` 必须使用真实的 theme/keybindings 构造；不要用空对象替代运行时上下文。
- 阶段 1 不改动 `src/index.ts` 的运行逻辑，不提前移除阅读模式功能，也不加入输入锁状态机。
- 版本发布前同步更新 `package.json`、`CHANGELOG.md`；tag 使用 `v<version>`（如 `v0.1.0`）。
