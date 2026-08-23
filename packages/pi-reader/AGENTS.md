# @inobit/pi-reader

> 环境要求、catalog、常用命令、版本与发布（含 tag 规范）、文档分工等公共约定见仓库根 `AGENTS.md`，本文件只写本包目标、结构与包特有约束。

## 目标

- 阅读模式：`alt+o`（`config.json: toggleKey` 可改）经 `TUI inputListener` 拦截进/出 `READING`，`Promise` 异步展开工具输出；`/reader`、`/scroll` 兜底
- Vim 翻页：`ctrl+u/d` 半页、`ctrl+f/b` 整页、`j/k`/`ctrl+n/p` 行、`g g` 顶部（300ms，含同批 `gg`）、`G` 底部
- 指示：`ReadonlyEditor` 左显 `◉ Reading` 覆盖原输入（无边框），原输入保留；`?` 弹窗英文帮助 `Esc` 关闭
- 位置保位：进出阅读与手动展开/收拢时视口钉在原问答附近；锚点为 OSC133 prompt 序号坐标系 `{k,d,count}`，恢复用统一 clamp 模型（详见 plan.md §4–§6）
- 配置：`autoExpandTools: false` 关闭自动展开/收拢（位置天然无损）；`app.tools.expand` 在 READING 态也可用（走同一锚点包装）

## 架构（改动前必读）

按键主通道 `TUI inputListener` + `ctx.ui.onTerminalInput` 双通道（后者确保 `reload`/`resume` 后仍生效），`INSERT` 透传：

- **事件**：`listenerInstalled` 防重；`currentCtx` 在全量会话事件刷新；`latestTui` 缓存用于滚动
- **禁抢 `tui.altScreen.*`**：`TUI` 层摘要先 consume
- **stale ctx**：仅 `.ui` 访问异常置 `ctxBroken`；输入保留 `savedInput`；工具展开 `Promise` 异步
- `ScrollReaderEditor` 必须传**真实 theme/keybindings** 构造（空对象会让 `Editor.render` 的 `borderColor()` 崩）

## 源码结构（src/）

| 文件           | 职责                                                                                                                                                                                                                                                                                                |
| -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/index.ts` | 纯逻辑导出 `parseReadingKey`/`halfPage`/`pageStep`/`GgSequence`；`ScrollReaderEditor`/`ReadonlyEditor`（左显 `◉ Reading`）；`factory` + `onTerminalInput` 双通道；`applyReaderUI` 隐藏输入（保留原输入）+ `Promise` 异步工具；`?` 帮助（`custom` overlay）；`getActiveToggleLabel` 读 `config.json` |

依赖方向：`index.ts → {CustomEditor, ExtensionAPI, ExtensionContext} from pi-coding-agent` + `{Key, matchesKey, truncateToWidth, type TUI} from pi-tui`；无本地子模块。

## 包特有约束（设计层面，改动前必读）

**键位路由**
- 阅读切换不注册 `pi.registerShortcut`，走双通道拦截；expand 分支优先级低于切换/退出/help、高于语义导航（显式绑定键优先于固定白名单），与 `toggleKey` 同绑的键在 READING 不可达——文档已写明勿同键

**配置定位**
- jiti 把扩展编译为 base64 data:URL 模块，`import.meta.url` 无文件路径；定位包目录必须用 CJS 包装注入的 `__dirname`
- 若改回基于 URL 的解析不会报错，只会静默回退到用户级旧配置（字段分歧时新配置项失效，极难排查）

**保位不变量**（三者缺一恢复会静默失效，无报错）
- 一切改变 transcript 高度的动作（自动或手动的 `setToolsExpanded`）都必须过锚点包装：先同步捕获、变更后挂恢复监视器
- 恢复 `scrollTo` 必带 `disableFollow:true`，否则目标落底会重新武装 follow-end，前功尽弃
- 监视器的稳定性判据依赖帧代际推进，而 pi-tui 按需渲染（空闲零帧），故每 tick 必须主动 `requestRender`

**锚点坐标系**
- 选 OSC133 prompt 序号是因为它跨展开/收拢严格稳定（盒树/行号/文本签名均被否决，论证见 plan.md §3）；核心升级后若保位异常，先验证 `findPromptRows` 前提再查别处

**已知限制**
- 工具展开状态靠本地镜像维护（核心无 getter）：编辑态经核心路径切换会漂移，进入 READING 自动对齐
- `regular` 模式无视口，滚动/保位静默降级
- `parseReadingKey` 兼容传统控制符与 Kitty 协议；`gg` 用 `GgSequence(300)` 双击判定
