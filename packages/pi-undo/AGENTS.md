# @inobit/pi-undo

Pi 撤销扩展：把最近一次发送的输入撤回到输入框并从对话中移除，单次/轮，原子 abort 再撤。

> 环境要求、catalog、常用命令、版本与发布（含 tag 规范）、文档分工等公共约定见仓库根 `AGENTS.md`，本文件只写本包目标、结构与包特有约束。

## 目标

- `/undo` + 快捷键 `alt+u` 同走 `doUndo`，编辑器非空时提示 `Editor has draft, clear it first` 且不撤回（守卫优先级最高）
- 撤销效果：从对话中移除最近一次 `user` 轮及其全部 assistant 响应（含半截），文本回填到输入框；`/tree` 可找回，文件副作用不回滚
- 执行中且队列非空：等价官方 dequeue（alt+up）——经捕获的 TUI 引用直调宿主 `CustomEditor.actionHandlers` 中的 `app.message.dequeue` handler：取回全部排队文本、清空队列、当前轮继续运行；触达失败仅提示
- 执行中且队列已空：先判草稿再 `abort→waitForIdle→再判草稿→移除刚发的 user 消息`

## 源码结构（src/）

| 文件 | 职责 |
|---|---|
| `src/index.ts` | 工厂装配：TUI 引用捕获 widget、事件接线、canUndo 轮级锁、doUndo、注册命令/快捷键 |
| `src/history.ts` | 纯函数 `extractText` / `findLastUserEntry`（分支倒序找最近非空 user） |

依赖方向：`index → history`；`history` 不依赖 pi 运行时类型。

## 包特有约束（改动前必读）

- **草稿守卫优先级最高**：任何分支只要撤销动作将要发生而编辑器非空（含 abort 后宿主回灌的排队文本），一律提示并返回
- **单次/轮**：每轮仅可撤销一次，下次发送后重置
- **可找回**：仅回退对话分支，文件副作用不回滚，可经 `/tree` 找回
- **不维护本地副本队列**：steer/followUp 排队消息的取回统一经宿主编辑器的 `app.message.dequeue` handler 完成（依赖 `CustomEditor.actionHandlers` 内部结构，升级 pi 需回归验证）
- **使用约束**：无界面模式静默（非 TUI 模式队列取回走提示回退），有草稿不覆盖，执行中先中断再撤销
