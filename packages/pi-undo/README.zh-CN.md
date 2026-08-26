# @inobit/pi-undo

[English](./README.md) | **中文**

Pi 撤销扩展：把最近一次发送的输入撤回到输入框并从对话中移除，单次/轮，原子 abort 再撤。

- **撤销**：移除最近一次 `user` 轮及其全部 assistant 响应（含半截）并回填到输入框，`/tree` 可找回；文件副作用**不回滚**
- **单次/轮**：发一次可撤一次，`before_agent_start` 重置，草稿原子检查
- **执行中原子 abort**：`!isIdle` 时 `abort() → waitForIdle` 后再判草稿再移除刚发的消息
- **队列非空 = 官方 dequeue（alt+up）**：取回全部排队文本到编辑器并清空 steer/followUp 队列，**不中断当前轮**、不动会话。经捕获的 TUI 引用直调宿主 `CustomEditor` 注册的 `app.message.dequeue` handler（与按下 alt+up 同一函数对象）；触达失败仅提示手动按 dequeue 快捷键

## 安装

```bash
pi install npm:@inobit/pi-undo
```

重启或 `/reload` 生效。本地调试（隔离，--no-extensions 屏蔽已安装旧版）：

```bash
pi -ne -e ./packages/pi-undo
# 发一句后 /undo 或 alt+u
```

## 使用

- `/undo` — 撤回最近一次输入到编辑框，仅出错时英文提示
- `alt+u` — 同 `/undo`

行为：

- 编辑器非空时提示 `Editor has draft, clear it first` 且不撤回——守卫优先级最高，适用于所有分支（含宿主在 abort 时回灌进编辑器的排队文本）
- 执行中且队列非空：等价官方 dequeue——全部排队文本回编辑器、清空 steer/followUp 队列，当前轮继续运行、不动会话（与按下 alt+up 同一函数对象）；无法触达宿主编辑器时提示手动按 dequeue 快捷键（`alt+up`，Windows 为 `alt+q`）
- 执行中且队列已空：abort 后撤刚发的 user 消息，无确认；若 abort 后编辑器变为非空（如宿主回灌了排队文本），则按草稿拦截、本次不撤
- 空闲时：撤最后一条 user 消息
- 无 redo：从输入框重发或 `/tree` 找回；仅出错时英文提示

## 配置

快捷键可配，配置文件 `~/.pi/agent/extensions/pi-undo/config.json`（改后需 `/reload`）：

```json
{
  "shortcut": "alt+u"
}
```

默认 `alt+u`，受信任项目下 `.pi/extensions/pi-undo/config.json` 可覆盖全局。

## 兼容与限制

- 撤销立刷页并跨 `--session` 持久化，首条经 `resetLeaf` 回到空分支
- 若 `parentId` 已被压缩截断，提示 `Hard undo failed`（`details` 含原文本已回填）
- 文件副作用不回滚（edit/write/bash），仅回退对话分支
- 队列取回依赖宿主 `CustomEditor.actionHandlers` 内部结构（非文档化 API）：pi 升级若变更该结构，将自动回退为提示按 `alt+up`；官方未提供编程式 dequeue API

## 开发

```bash
pnpm --filter @inobit/pi-undo check
pnpm --filter @inobit/pi-undo test
pnpm --filter @inobit/pi-undo pack:check
pi -ne -e ./packages/pi-undo
```

## License

MIT
