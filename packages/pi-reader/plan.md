# pi-reader — 模式切换滚动位置保持方案（v3.1）

> 版本记录：v1 采用"组件实例身份 + 盒几何"锚点，经代码审查否决（盒树前提不成立，见 §3）；
> v2 改用 prompt 序号锚定；v3 合并两项扩展需求设计（见 §9）；
> v3.1 按复审修订：补 latestKb 接线（P1-1）、优先级全序与插入点定死（P1-2/P2-3）、同键冲突澄清（初判 P1-3 经复核证伪降级）。

## 1. 目标（一句话）

**进入/退出阅读模式时，界面没有明显变化——展开收起是排版的事，不动你的书签。**
用户视角效果：

| 时刻 | 现状 | 方案后 |
| ---- | ---- | ------ |
| 进入（alt+o），工具全部展开 | 中部阅读时内容脚下位移 | 视口钉在刚才看的问答上 |
| 退出（esc/i/alt+o），工具全部收拢 | 视口摔到最底部 | 停在原阅读位置 |
| 本来就贴底 | —— | 行为不变（守卫放行，原生跟随接管） |

允许的误差：段级（Q/A 级）；重排到修正落地之间可能有 1~2 帧（约几十毫秒）错位闪现，静默无提示。

## 2. 背景与根因（已经源码审查核实）

滚动丢失的唯一来源是 `setToolsExpanded(true/false)` 引起的内容高度剧变，叠加 ScrollView 的 follow/clamp 语义：

1. transcript 的 ScrollView 启动时一次性创建（`follow:"end"`），toggle 只换编辑器容器不触碰它
   （interactive-mode.js:639-645 `new ScrollView(...)`；:2049-2108 `setCustomEditorComponent` 仅 `editorContainer.clear()` + `addChild`）
2. 工具展开/收起改变内容高度后，`ScrollView.updateLayout`（pi-tui scroll-view.js:154-168）执行：

   ```js
   if (this.followingEnd) this.currentScrollTop = maxScrollTop;            // 跟随态钉底
   else this.currentScrollTop = Math.max(0, Math.min(this.currentScrollTop, maxScrollTop));
   if (this.followEnd && this.currentScrollTop === maxScrollTop && !this.followSuppressedAtEnd)
       this.followingEnd = true;                                            // 落底即重新武装跟随
   ```

退出方向收缩幅度大（全量工具收拢），scrollTop 大概率超过新 maxScrollTop → clamp 到底 + follow 重武装，
体感即"一退就回最底部"。reader 现有 `applyReaderUI` 只保存输入框文本，无任何视口锚点。

## 3. 方案选型与演进

| 候选 | 结论 | 依据 |
| ---- | ---- | ---- |
| 裸 `scrollTop` 数值 | ❌ | 展开/收起后行号整体漂移，数值失义 |
| 文档比例 `scrollTop/maxTop` | ❌ | 长转录下比例误差 = 数百行偏差 |
| 组件实例身份 + 盒几何（v1 主案） | ❌ **P0 否决** | `chatContainer`/`documentContainer` 都是普通 `new Container()`（interactive-mode.js:361-364），无 `[LAYOUT_NODE]` 方法（pi-tui tui.js Container 类），布局器走叶子分支压平为**单个叶子盒**——盒树在滚动内容内只有一层，组件路径恒为 `[documentContainer]`，方案退化为候选 1 |
| 文本签名修正 | ⚠️ 可选增强 | 依赖渲染结果（换行/截断/重复歧义），仅用于行级精度需求 |
| **prompt 序号锚定（本方案）** | ✅ | 见下 |

### prompt 序号为什么是可靠的元信息

- OSC133;A 是 pi 核心有意写进行流的**隐藏带内元数据**（shell-integration 协议的标准 prompt 边界标记），
  渲染时不可见；核心自己的 `scrollToPrompt` 原生导航（tui-alt-screen.js:251-263）扫的就是同一标记
- 标记字节串处处相同，**唯一的是出现次序**——所以锚"第 k 个"，绝不文本匹配
- 展开只改工具块内部行数，不增删消息边界 → **序号的个数与顺序跨 toggle 严格稳定**

## 4. 锚点定义与两个坐标系

```
interface ScrollAnchor { k: number; d: number; count: number; }
// k     = 视口顶行上方最近的 prompt 序号（findPromptRows 下标）
// d     = 视口顶行距该 prompt 的行数（同段内偏移）
// count = 全文 prompt 总数（恢复时 O(1) 校验用）
```

两个坐标系不可混淆：

- **文档系（绝对）**：`scrollContentLines` 是完整转录的拍平行数组（可能上万行）；
  prompt 行号是该数组下标。视口只是其上的滑动窗口 `[scrollTop, scrollTop+vh)`
- 切换改变的是文档总行数 → 绝对行号漂移（裸 scrollTop 失效的原因）；
  序号层不参与漂移，锚点放在这一层

## 5. 恢复的统一 clamp 模型

记：`R'` = 收缩后锚点内容距文档顶部的行数；`v` = 保存时锚点距视口顶部的行数（本方案通常为 0）；
`M` = 新文档 `maxScrollTop`。期望位置只有一行：

```
scrollTop' = clamp(R' − v, 0, M)
```

| 情况 | 条件 | 结果 |
| ---- | ---- | ---- |
| 正常 | `v ≤ R' ≤ M + v` | 锚点精确回到视口内原相对位置 |
| 上方不够 | `R' < v` | `scrollTop'=0`，从文档顶部渲染；锚点出现在视口第 `R'` 行（采用较小的距离）。注：本方案 `v=0` 时此分支不触发 |
| 下方不够 / 不足一屏 | `R' − v > M`（含 `M=0`） | 贴底展示最后一屏；**锚点行必然仍在屏幕内**（clamp 仅当目标已落入最后一屏时发生），只是不在视口顶行 |

**边界决策：不做顶部假空白。** 假空白会污染转录的真实行坐标系——`[q/]q`、`{`/`}`、搜索 n/N
全部建立在对 `scrollContentLines` 的扫描上，填充行要么得让所有导航逻辑跳过、要么制造幽灵匹配；
且贴底展示与 less/man 等终端分页器惯例一致。

**锚点行被收拢消失**（视口顶行原在工具输出深处）：无法逐字还原物理不存在的行，d 截断到新段长度内，
退到同一问题的收拢块——语义最近邻，即用户心智上正确的落点。

## 6. 业务流（何时记录、何时恢复）

三条触发路径（alt+o 双通道、esc/i 经 handleEsc、`/reader` 命令）都汇聚到同一个 `toggle()` →
`applyReaderUI(reading)`，因此只需一个插入点：

```
按键 → toggle()：状态翻转、搜索/缓冲清理（现状不动）
  └─ applyReaderUI(reading)
      ├─ 【新增·捕获】同步，分支最顶部，任何高度变化之前
      │    vs = getViewportState(tui)
      │    守卫链：scrollView 存在？lines 存在？非 followingEnd？prompt 数 > 0？
      │    通过 → anchor = {k, d, count, gen: ++generation}；任一失败 → anchor=null（行为同现状）
      ├─ 【现状】setEditorComponent / setEditorText
      └─ 【现状】Promise.resolve().then(() => setToolsExpanded(reading))
              │ 下一帧起重排，ScrollView clamp/落底发生在这里
              ▼
         【新增·恢复监视器】异步轮询 ~16ms/tick，上限 ~20 次：
            a. generation 仍是自己的？（连按两次 alt+o → 旧恢复作废）
            b. currentLayout 对象已换代？（每次 render 产出新帧对象——证明确实重排过）
            c. contentHeight 连续两个新帧相同？（展开已稳定）
            a 失败 → 静默放弃；b/c 未满足 → 继续；全满足 → 恢复
              ▼
         【新增·恢复】一次性动作：
            重新 findPromptRows → 校验 length === anchor.count（不等则放弃）
            R' = promptRows[anchor.k]
            sv.scrollTo(clamp(R' + d, 0, M), { disableFollow: true })
            tui.requestRender()；anchor 置 null
```

三条时序约束：

1. **捕获必须同步且最先**：`setToolsExpanded` 生效后的第一次 render 会作废旧行号体系
2. **恢复不能紧跟 `Promise.then`**：微任务执行时重排未发生，scrollTo 会被随后的 updateLayout 覆盖
3. **`disableFollow: true` 必带**：否则目标落底时会重新武装 follow-end

复杂度：捕获与恢复各一次 O(N) 扫描（廉价前缀正则，2 万行 < 1ms），定位取下标 O(1)。
参照：reader 每次 `[q`/`]q` 导航本来就在跑同样的扫描，无新增成本类别。

**锚点包装是通用原语**：**扩展自身发起**的一切 `setToolsExpanded` 调用（模式切换两分支、§9.2 的
阅读态手动展开）都必须走「捕获 → 变更 → 挂监视器」同一包装。核心内部的两条调用链
（INSERT 态 actionHandler interactive-mode.js:2261、extension selector :1945）发生在非 READING 管辖范围，
扩展无从也无须包装。

## 7. 正交性与退化安全

- 锚点只依赖 prompt 边界存在，与高度是否变化**正交**：若 toggle 不动工具状态，内容高度不变、
  clamp/follow 本就不触发（位置天然不丢），锚点照常走一遍等于幂等空校正
- 因此"自动展开"（产品特性）与本方案（体验修正）可独立开关，任意组合下均成立
- 防御校验把"信任不变量"降为"验证不变量"：恢复前比较前后 `promptRows.length`，O(1)
- 配置化（§9.1 `autoExpandTools=false`）是正交性的直接应用：高度零变化时位置天然不丢，锚点退化为幂等空校正

## 8. 边界情况总表

| 场景 | 处理 |
| ---- | ---- |
| 捕获时处于贴底跟随态 | 跳过保存，原生 follow-end 接管 |
| 锚点行所在工具块被收拢 | d 截断，退到该问题边界（§5） |
| 收缩后不足一屏 | clamp 公式自动从顶渲染（M=0） |
| 上方内容不足维持视口相对位置 | clamp 到顶，锚点采用较小距离（§5） |
| 快速连按两次 alt+o | generation 检查使旧恢复作废，第二次按当时视口重新捕获 |
| toggle 窗口内 resize | vh 变化使"同一位置"失义 → 监视器放弃本次恢复 |
| compact / fork / 会话切换插入窗口 | `handleSession` 已重置阅读态，锚点随 generation 失效 |
| thinking 显隐切换、`/clear` 等触发 `chatContainer.clear()` | 多数伴随阅读态重置；窗口内发生则由 promptCount 校验拦下 |
| 帮助弹窗 overlay / 搜索高亮 / 多面板 | 已排除，无需处理：overlay 为渲染后合成层不改盒几何；高亮只改行内 ANSI 不改行数；fullscreen 仅一个 primaryScrollView |
| `autoExpandTools=false` 时切换 | 不调 `setToolsExpanded`，高度零变化，位置天然不丢；锚点照常执行，恢复精确无漂移 |
| 监视窗口内连续两次高度变化（手动展开后立即退出） | 各自独立的捕获/恢复周期，generation 作废旧恢复；count 校验无法区分展开/收拢两种排版，d 可能基于过渡态计算——偏差在段级容差内，可接受 |

## 9. 扩展需求设计（经 oracle 评估定稿）

### 9.1 需求 A：工具自动展开/收拢配置化

- 配置：`autoExpandTools: boolean`（默认 `true` = 现状硬编码行为）；`false` 时 toggle 全程不调 `setToolsExpanded`
- **不做三态** `"restore"`：核心工具展开是单一全局布尔（字段 interactive-mode.js:276 / 方法 :3354），无逐工具状态，
  "恢复原状"价值极低（将来真要加，捕获时多存一个布尔即可，YAGNI）
- 接线：`readNavConfigRaw` 加字段解析；**VITEST 分支返回空对象，默认值 `true` 必须在消费侧显式兜底**，
  防测试基线漂移；README 配置节补文档；沿用"改配置需重载"约定

### 9.2 需求 B：`app.tools.expand` 在 READING 态生效

- 可行性：factory 第三参即应用级 keybindings 实例（interactive-mode.js:2064），
  pi-tui 提供 `kb.matches(data, id)` / `kb.getKeys(id)`（keybindings.js:190/198），Kitty 兼容由核心同一套设施保证
- **kb 获取**：input 通道直接用 factory 第三参；terminal 通道回调签名只有 `(data)`（src/index.ts:1320），
  需仿 `latestTui` 先例（:1335）在 factory 内捕获 `latestKb` 到外层作用域。
  不把 pi-tui 全局 `getKeybindings()` 作主路径（跨 jiti/pnpm 的模块实例同一性属实现细节投机，至多作兜底）
- **插入点（定死）**：双通道各自在 exit 判定与 `isDuplicateNav` 去重之后、`tryHandleReadingNav` **之前**
  ——显式绑定键优先于固定白名单的语义导航；命中 → `setToolsExpanded(!当前)` + `{consume:true}`；
  SEARCH_INPUT 态不特判（该键被当查询词吞掉是正确行为）
- **READING 态优先级全序**：
  `SEARCH_INPUT 吞键 > toggle > exit(esc/i/ctrl+c) > help(?) > app.tools.expand > 语义导航([q/a/t {}/n/N) > 通用滚动 switch`
- **同键冲突说明**：仅当 toggleKey 与 app.tools.expand 绑**同一个键**时冲突（如都为 alt+o）：
  READING 态内 toggle 必然胜出、expand 不可达。这是自相矛盾配置，README 仅需补一句
  "两功能请绑不同键"。默认组合（alt+o / ctrl+o）与 README 引导组合（ctrl+o / alt+o）下 B 均天然可用
- **建议避开的键**：`?`、esc、i、ctrl+c（被前置分类截断，绑上去永不可达）；若需保留对应阅读导航功能，
  还应避开 j/k/g/G/n/N/{/}/[/]/数字/ctrl-u/d/f/b/p/n
- 帮助页：用 `kb.getKeys("app.tools.expand")` 动态渲染键位行，标注该键编辑态/阅读态的不同归属
- 编辑态现状不受影响，且这正是 B 必须走输入路径分支的原因：`onAction("app.tools.expand")`
  handler 虽经 setCustomEditorComponent 复制给自定义编辑器，但 READING 态的 ReadonlyEditor.handleInput
  是空操作（src/index.ts:471），复制的 handler 本就不触发

### 9.3 关键联动：手动展开必须复用锚点

手动展开/收拢与 toggle 同源——高度剧变 → 同样滚动丢失。锚点包装必须是共享原语，
`applyReaderUI` 与 B 的手动分支走同一套「捕获 → `setToolsExpanded` → 挂监视器」代码。
**§10 步骤 1（纯函数抽取）是 B 的前置依赖。**

### 9.4 组合语义

- `autoExpandTools=true` + B：退出强制收拢会抹掉阅读态内的手动策展——可接受，文档写明即可
- `autoExpandTools=false` + B：完整自主形态——toggle 不插手，手动展开且有锚点保位（最有价值组合）

### 9.5 不做清单（YAGNI）

| 项 | 理由 |
| ---- | ---- |
| 三态 restore 配置 | 全局布尔下价值极低，将来数行可加 |
| 逐工具粒度控制 | 核心只有全局开关，扩展侧无从谈起 |
| toggleKey 与重绑键智能冲突消解 | 固定优先级 + 文档足够 |
| 退出时脏标记追踪手动改动 | 过度设计，先观察真实反馈 |

## 10. 实施步骤

1. v2 锚点基建：新增纯函数 `captureAnchor(lines, scrollTop)` / `computeRestoreRow(newLines, anchor)`
   （复用现有 `findPromptRows`；**单测 mock 行数组即可，切勿 mock 深层盒树**——真实树只有一层，深层 mock 给虚假信心）；
   新增恢复监视器小类（generation / 帧代际 / contentHeight 三重条件，可注入时钟便于测试）
2. `applyReaderUI`（src/index.ts:1069）接入：分支顶部捕获块 + 尾部挂监视器
3. 需求 A 配置项：`readNavConfigRaw` 解析 + 消费侧默认值兜底 + README 文档（改动极小、独立见效）
4. 需求 B：`latestKb` 捕获 + 双通道快捷键分支（按 §9.2 定死的插入点与优先级全序）+ 帮助页动态键位
   （依赖步骤 1 的锚点原语）
5. 单测：往返一致、d 截断、followingEnd 跳过、count 校验失败放弃、generation 作废、
   `autoExpandTools=false` 不触发 setToolsExpanded、B 分支命中/去重/搜索态吞键、
   expand 绑到 `?`/esc 等前置截断键时不可达（符合优先级全序）
6. 手动冒烟（`pi -ne -e ./packages/pi-reader --tui-mode fullscreen`）：
   阅读中滚到中部→退出应停留原地；底部进出维持贴底；顶部进出维持顶部；连按两次不乱跳；
   `autoExpandTools=false` 进出不展开收拢且位置不丢；阅读态手动展开/收拢位置保持

## 11. 备注

- 关键事实（反转表述）：**当前聊天容器就不产生可锚定的深层布局盒**——除非 pi 核心改用布局容器
  （VStack/Stack）逐消息挂载，"组件身份/盒几何"一类方案无从谈起；届时可作为上游改进另议
- 本方案的存活依赖：核心继续在 `scrollContentLines` 中保留 OSC133;A 且每用户输入恰一条。
  升级 pi 后若导航异常，优先回归 `findPromptRows` 相关测试
- 需求 B 依赖 factory 第三参传递 keybindings 的上游契约——核心若变更则 B 失效，升级 pi 后需一并回归

## 12. 冒烟测试结果（tmux 实测）

全部通过，并额外发现并修复两个实现层 bug（已修复并回归）：

1. **恢复监视器可能永不触发**：pi-tui 按需渲染，空闲时零帧；"两个新帧同高"判据在单次重排后
   可能永远等不到第二个新帧 → 监视器超限静默放弃、恢复失败。修复：监视器每 tick 主动
   `requestRender` 制造帧代际推进，判据变确定性
2. **包目录 config.json 解析失效（预先存在的 bug）**：jiti 把扩展编译为 base64 data:URL 模块，
   `import.meta.url` 拿不到文件路径，原实现静默回退到用户级配置——两份配置字段一致时无感，
   新增 `autoExpandTools` 后被用户级旧配置遮蔽而暴露。修复：改用 jiti CJS 包装注入的
   `__dirname`（实测可用）定位包目录，本级与父级都探测

实测通过项：进入阅读自动展开+◉Reading；中部滚动后退出保位（日志证实 clamp 后主动重定位）；
贴底进出维持贴底；顶部锚点经历展开/收拢/退出全程不动；阅读态 alt+o 手动切换往返精确回位；
快速连按无竞态；autoExpandTools=false 无自动展开且位置无损
- 本文档为方案记录，未改动任何代码
