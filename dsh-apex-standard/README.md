# apex-standard

> DeepSeek V4 系列（Pro / Flash）统一锚定 agent 预设，同时适配 DeepSeek 官方 API 与 opencode-go 订阅接口。

`apex-standard` 是面向 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（dsh）的 agent-plane 预设。其设计目标是：让 V4 Pro 稳定进入训练对齐（RL-aligned）轨迹以发挥能力上限，让 V4 Flash 稳定进入高规划质量的"神模式"，同时不牺牲 Standard 预设的完整工具能力，不引入额外模型调用，不注入任何合成消息。

本预设为社区实验项目，与 DeepSeek 官方无关，未获任何官方背书。文中所引实测结论均来自公开仓库的个人测量，不构成跨任务普适性承诺。

## 1. 项目简介

DeepSeek V4 系列模型对 agent scaffold（系统提示词、API 可见工具目录、上下文注入）高度敏感。公开实测表明：

- V4 Pro 在官方 Minimal 预设（两工具）下可达 **99/96**（Project2 V4.1b），而在 Standard / PTC 及通用接口下仅 91–93；
- V4 Flash 的能力相对稳健，但默认无引导时陷入"鬼模式"——思考浅、草草动手、交付质量差；补足引导后规划深度可提升一个数量级。

`apex-standard` 以"**两阶段锚定 + 模型感知分流 + epoch 感知管理**"为核心机制，在单一预设内同时解决上述两类问题，并兼容 dsh rc.5 / rc.6、Windows / Linux / macOS 三种平台。

## 2. 功能特性

1. **双渠道统一**：同一预设覆盖 DeepSeek 官方 API 与 opencode-go 订阅接口，四组模型组合（Pro / Flash × 两渠道）自动适配。
2. **模型感知分流**：依据路由模型 id 是否含 `flash` 自动选择路径（Pro 路径 / Flash 路径），与 provider 无关，支持手动钉死。
3. **两阶段工具锚定**：首个请求仅暴露官方 Minimal 预设的真实工具对（`bash` + `str_replace_editor`），首个持久晋升信号后按路径切换目录。
4. **锚定释放门（anchor-guardian）**：首块 reasoning 必须命中 `we` 且不含 `let me` 才放行；浅轨迹会被提前中止、surface 回滚并自动重试，达到 `maxAttempts` 后强制 fail-open。
5. **Pro 常驻目录**：晋升后 Pro 保持最小常驻集（锚定对 + 三个发现工具），重型工具经 `dev_tool_search` 按需解锁，避免轨迹回归。
6. **Flash 神模式 persona**：w7 五锚（分类、回顾、反跑题、深度思考、决策闭环）静态挂载，含 P10 收敛绑定，避免"深度思考跑满预算"陷阱。
7. **rc.6 兼容**：不依赖 rc.6 失效的 `session/event` 馈送与 `agent.inbox`；晋升与压缩边界通过 durable 日志增长重扫兜底。
8. **epoch 感知管理**：压缩边界后自动回退受控阶段；解锁集合与一次性提示均按 epoch 重置/重发，长对话轨迹不漂移。
9. **零额外模型调用**：无 warmup 轮、无 replay。anchor-guardian 失败重试会写入一条带稳定 id 的 user 侧 surface 替换节点（compaction 同款机制），不是伪造 assistant 历史。
10. **降级纪律**：组件缺失、过滤器异常、配置错误均按既定策略降级或快速失败，不使会话瘫痪。
11. **全平台**：Windows（Git Bash 自动探测）、Linux、macOS；插件零依赖、无网络请求、无遥测。

## 3. 技术栈

| 组件 | 说明 |
| --- | --- |
| DeepSeek Harness（dsh） | 0.1.0-rc.5+（rc.6 已适配）；agent-plane cordis 组合 |
| 插件实现 | Node.js ESM（`.mjs`），零第三方依赖 |
| 组合配置 | YAML（`agent.cordis.yml` / `preset.yml`） |
| Windows 执行环境 | Git for Windows（`custom-bash` 自动探测安装位置） |
| 测试 | Node.js 内置模块，`node test/smoke.mjs`（21 项断言） |

## 4. 安装

### 4.1 环境要求

- DeepSeek Harness（dsh）0.1.0-rc.5 及以上（rc.6 已适配）；
- Windows 需安装 Git for Windows。`custom-bash` 自动探测常见安装位置（`C:\Program Files\Git`、`C:\Program Files (x86)\Git`、`D:\Git`、`E:\Git`、`C:\Git`、`%LOCALAPPDATA%\Programs\Git`、scoop），未命中时回退 PATH 中的 `bash`；如需显式指定，取消 `agent.cordis.yml` 中 `custom-bash` 行的 `config.bashPath` 注释；
- 以下渠道之一：DeepSeek 官方 API key，或 opencode-go 订阅。

### 4.2 安装预设

方式一（推荐，直接克隆本仓库）：

```bash
git clone https://github.com/rinDBeans/dsh-apex-standard.git
# Windows PowerShell: Copy-Item -Recurse .\dsh-apex-standard\preset "$env:USERPROFILE\.dsh\.agent-presets\apex-standard"
# Linux / macOS:      cp -r dsh-apex-standard/preset "${DSH_HOME:-$HOME/.dsh}/.agent-presets/apex-standard"
```

方式二（发布归档）：从 zip / tar.gz 解压后，将 `preset/` 目录复制到 dsh 用户预设目录：

```powershell
# Windows PowerShell
Copy-Item -Recurse .\preset "$env:USERPROFILE\.dsh\.agent-presets\apex-standard"
```

```bash
# Linux / macOS
mkdir -p "${DSH_HOME:-$HOME/.dsh}/.agent-presets"
cp -r preset "${DSH_HOME:-$HOME/.dsh}/.agent-presets/apex-standard"
```

安装后需完全重启 dsh，预设于启动时挂载。

### 4.3 渠道与模型配置

在 `~/.dsh/settings.yaml` 中配置默认模型与预设：

```yaml
# DeepSeek 官方 API
agent-default-model:
  provider: deepseek            # 官方渠道，按 dsh 文档配置 API key
  model: deepseek-v4-pro        # 或 deepseek-v4-flash，自动走对应路径
  reasoningEffort: max          # 必需：全部上游证据基于 max 档
agent-presets:
  default: apex-standard
```

```yaml
# opencode-go 订阅
agent-default-model:
  provider: opencode-go         # endpoint: https://opencode.ai/zen/go/v1
  model: deepseek-v4-pro        # 或 deepseek-v4-flash，自动走对应路径
  reasoningEffort: max
agent-presets:
  default: apex-standard
```

## 5. 使用方法

### 5.1 启用

1. 完全退出并重启 dsh；
2. 创建全新会话，选择预设 `Apex Standard (Pro/Flash unified, experimental)`；
3. 请勿在活跃会话中切换预设——首请求锚定仅在会话开始时生效。

### 5.2 验证

导出会话 JSONL，检查 `request/header` 事件：

1. 首请求 `tools` 数组恰好为 `["bash", "str_replace_editor"]`；
2. 首请求不含 AGENTS.md/CLAUDE.md 摘要与 `<available_skills>` 提醒；Pro 的 system 为 Minimal 原文，Flash 的 system 为神模式五锚；
3. 首个 `tool/call` 或 `assistant/message` 之后：Pro 的下一 header 为常驻集（锚定对 + 五个发现/搜索工具；Windows 上 `pwsh` 替换 `bash`），Flash 为完整 Standard 目录；
4. anchor-guardian 命中浅首块时：当前 turn 被提前中止，出现一条 `surfaceOp: replace` 的 guardian retry 用户消息，随后自动开启新 turn，新请求 header 仍为 `["bash", "str_replace_editor"]`；
5. 若配置了 `bootstrapMaxTokens`，首请求 `config.maxTokens` 记录该值且晋升后被剥离；
6. 可选：统计 reasoning 词频，锚定生效时 `let me` 趋近于 0、`we` 高频、过程可见回复仅最终一次。

### 5.3 常见调优

| 场景 | 操作 |
| --- | --- |
| Flash 连续多轮修改同一文件（相关任务链） | 设 `flashGuidance: false` |
| Flash 晋升后保持窄目录 | `flashPromotedCatalog: resident` |
| 渠道模型 id 不含 pro/flash 字样 | `forcePath: pro` 或 `forcePath: flash` |
| 首请求锚定不稳的加强手段 | `bootstrapMaxTokens: 1024`（注意 rc.6 预构建包可能覆盖） |
| 长对话 / 大型工程的 Pro 防偏航 | `proDisciplineHint: true` |
| Windows 晋升后用 pwsh 而非 Git Bash | `replaceTools: !!js "process.platform === 'win32' ? { bash: 'pwsh' } : {}"` |
| Windows 晋升后仍需 Git Bash | `dev_tool_search` 显式解锁 `bash`，或设 `custom-bash` 行 `lockAfterPromotion: false` |
| 纯 greenfield 创意构建（Pro） | 建议与官方 PTC/code preset 对照使用（见 §9） |

## 6. 配置说明

配置位于 `preset/agent.cordis.yml` 首行 `apex-bootstrap`：

| 键 | 默认值 | 说明 |
| --- | --- | --- |
| `bootstrapTools` | `[bash, str_replace_editor]` | 首请求可见工具（Minimal 真实工具对） |
| `promoteOn` | `either` | 晋升触发：`either` / `tool-call` / `assistant-message` |
| `bootstrapMaxTokens` | 未设 | 首请求输出上限（opt-in，晋升后显式剥离） |
| `suppressedContextSources` | `[agent-instructions, skill-catalog, time-context]` | bootstrap 期剥离的注入源（kind 或 plugin 名）；`[]` 禁用过滤 |
| `compactionTools` | `[read, edit, glob, grep]` | 压缩后、再晋升前的受控工具集 |
| `forcePath` | `auto` | 路径钉死：`auto` / `pro` / `flash` |
| `flashGuidance` | `true` | Flash 神模式 persona 开关 |
| `flashPersona` | 内置 w7+deep | 自定义 Flash persona 文本 |
| `flashPromotedCatalog` | `full` | Flash 晋升后目录：`full` / `resident` |
| `includeSubagents` | `false` | 子代理是否也走 bootstrap 阶段 |
| `proDisciplineHint` | `false` | Pro 晋升后每 epoch 注入一次长任务纪律提示 |
| `proDisciplineHintText` | 内置纪律提示文本 | 自定义提示内容 |
| `replaceTools` | `{}` | 锚定阶段之后的工具替换映射（如 Windows `{ bash: 'pwsh' }`）；严格 bootstrap 对与显式解锁不受影响，替换目标缺失时保留原工具 |

`anchor-guardian` 行：

| 键 | 默认值 | 说明 |
| --- | --- | --- |
| `enabled` | `true` | 释放门开关 |
| `maxAttempts` | `3` | 锚定尝试上限；耗尽后 fail-open |
| `earlyAbort` | `true` | 收到浅首块即取消本轮，再回滚重试 |
| `wakeMode` | `followup` | turn-stopping 兜底路径的重试方式：`followup` / `steer` |
| `retryOnCompaction` | `true` | 压缩后的“第二个首请求”是否同样受门控 |
| `retryPrefix` | 内置文本 | 重试节点的引导文本 |
| `wakeText` | `Continue from the instruction immediately above.` | 自动续跑的 wake 消息 |

`custom-bash` 行（仅 Windows 生效）：

| 键 | 默认值 | 说明 |
| --- | --- | --- |
| `bashPath` | 自动探测 | 显式固定 Git Bash 可执行文件路径 |
| `lockAfterPromotion` | `true` | 晋升后（及压缩受控期）`bash` 执行被拒并提示改用 `pwsh`；`dev_tool_search` 显式解锁 `bash` 后恢复 |

## 7. 设计原理

### 7.1 背景问题

综合 `xiaobright/modeltest` 系列文档与本地触发实验，可归纳为三类问题：

**A 类 · 轨迹触发机制**：V4 Pro 的首请求工具 schema 决定轨迹——官方 Minimal 工具对（持久 `bash` + `str_replace_editor`）在默认 maxTokens 下锚定 5/5，其余 standard 系 schema 全部落入 standard-like 轨迹（11/11）；工具提示词语序调整、工具数量增长（+4 起出现、+8 失控）均会触发"Let me"人格；skill 目录与 AGENTS.md 摘要注入会使锚定失效（0/9）；压缩重写模型可见面，构成"第二个首请求"。

**B 类 · 渠道与运行环境**：正式版 Pro 对 scaffold 高度敏感（OpenCode 四跑均值 92.75 vs Minimal 99/96）；Windows 无 PTY、rc.6 事件语义变化；Standard 存在 AGENTS.md 重复阅读、工具结果中段截断、搜索失控等部署风险。

**C 类 · 模型差异**：Flash 由 persona 主导、目录免疫；深度思考指令需绑定收敛指令（否则 0% 收敛）；spec 侧 persona 对 greenfield 任务反路由；相关任务链上静态引导为负收益；路由指令本身落入 react 吸引子。

### 7.2 上游方案对比

| 维度 | anchored-standard | router-standard | v4-flash-godmode | myDshPresets |
| --- | --- | --- | --- | --- |
| 目标渠道 | DSH 官方 API，Pro | DSH 官方 API，Pro/Flash | opencode-go，Flash | 官方 API + opencode，Pro |
| 核心机制 | 首请求字节级 Minimal 锚定 + 常驻目录 | 任务分类路由 persona + 近距离引导 | w7 persona 静态合并，首调用后全目录 | 首轮 warmup 锚定（生成或重放） |
| 实测成绩 | Project2 98/99 | P1–P23 探针矩阵 | 单任务鬼→神对照 | 单环境观察 |
| 主要短板 | 不处理 Flash；rc.6 晋升可能卡死 | 动态注入 rc.6 失效；greenfield 反路由 | 仅 Flash；全目录倾倒；无 compaction | 零工具锚定不持久；曾发生历史腐蚀事故 |

**关键冲突与消解**：(1) persona 改与不改——按模型分流：Pro 不改（工具 schema 是其决定变量）、Flash 改（persona 是其决定变量）；(2) 晋升后目录规模——Pro 常驻集、Flash 全目录；(3) 零工具 vs 两工具锚定——采用两工具锚定（零成本且轨迹持久）；(4) 深度思考锚——绑定收敛指令，并保留 `flashGuidance` 开关。

### 7.3 请求生命周期

```
用户首条消息
    │
    ▼
┌ 请求 #1 ─ bootstrap 阶段 ─────────────────────────────────────┐
│ tools   : bash + str_replace_editor（Minimal 真实 schema）     │
│ context : 无 AGENTS.md 摘要、无 skill 目录注入                  │
│ persona : Pro = Minimal 原文 / Flash = 神模式五锚               │
│ budget  : adapter 默认（bootstrapMaxTokens 可选）               │
└───────────────────────────────────────────────────────────────┘
    │ 首个 durable tool/call 或 assistant/message（promoteOn: either）
    ▼ 晋升（durable 事件派生，resume/reload 安全，rc.6 重扫兜底）
┌ 请求 #2+ ─ resident 阶段 ─────────────────────────────────────┐
│ Pro   : bootstrap 对 + 五个发现/搜索工具 + 已解锁工具             │
│         （Windows 上 replaceTools 将 bash 换为 pwsh，且         │
│          custom-bash 锁定 bash 执行并提示改用 pwsh）             │
│ Flash : 完整 Standard 目录（默认；可配 resident）               │
│ context : 注入恢复；instruction-hint 提示读取 AGENTS.md         │
└───────────────────────────────────────────────────────────────┘
    │ compaction/end
    ▼ 回退受控阶段：bootstrap 对 + compactionTools，直至新晋升信号
```

### 7.4 长对话稳定性设计

1. **解锁集合 epoch 化**：`dev_tool_search` 解锁仅统计最近一次压缩边界之后的记录，防止常驻目录随多轮压缩单调累积突破工具数阈值。
2. **受控目录收紧**：压缩后受控工具集为 4 个（`read/edit/glob/grep`），锚定对 + 受控集共 6 个，处于实测安全区间。
3. **批量解锁引导**：`dev_tool_search` 要求一次调用批量解锁，减少目录变更次数（每次变更都会断开 prompt 前缀缓存）。
4. **提示按 epoch 注入**：instruction-hint 与 proDisciplineHint 以 `会话ID:压缩边界` 为键，每 epoch 注入一次，避免压缩折叠后静默丢失。
5. **rc.6 重扫兜底**：晋升追踪在 durable 日志增长时自动重扫，晋升与压缩降级在无事件馈送时均正确。
6. **bash 执行锁定**：晋升后 wire 目录已无 `bash`，但宿主运行时不拦截未广播的工具调用，Pro 锚定轨迹惯性会继续调 `bash`——`custom-bash` 在晋升/受控期直接拒绝执行并提示改用 pwsh（严格锚定期与显式解锁不受限）。

## 8. 测试

```bash
npm test
# 或：node test/smoke.mjs && node test/guardian.smoke.mjs
```

`test/smoke.mjs` 覆盖 41 项断言：双路径锚定、guardian 重试边界的 fresh 目录、晋升、解锁、压缩回退、`replaceTools` 替换（严格期不替换 / 晋升后替换 / 显式解锁优先 / Flash 全目录 / 目标缺失降级）、custom-bash 锚定后锁定（晋升锁定 / 解锁恢复 / 压缩受控锁定 / guardian 重试放行 / 开关关闭）、注入剥离（含 time-context）、提示每 epoch 一次、无事件馈送的 rc.6 降级路径、降级目录。`test/guardian.smoke.mjs` 覆盖 7 项断言：浅首块 early-abort、surface 替换节点、followup 唤醒、重试后达标释放、分类器。全部通过输出 `ALL PASS`。

## 9. 已知限制

- **证据边界**：98/99 与神模式结论来自单一题面 / 单任务对照（n=2 / n=1），不构成跨任务普适性证明；guardian 的自动重试在本地真实 loop 上验证过（surface 回滚 + followup/steer + early-abort 三条路径），但网页 UI 转录会保留被回滚的失败回合，且重试会按尝试次数增加首轮延迟与 token 成本；
- **C4 残余风险**：Pro 在纯 greenfield 创意构建上存在 spec 侧反路由证据（Mario 6/10 vs PTC 10/10），预设层无代价方案，建议此类任务与官方 PTC/code preset 对照使用；
- **C5 相关任务链**：Flash 静态引导在紧密相关的任务链上实测为负收益，已提供 `flashGuidance: false` 开关；
- **宿主能力边界**：compaction 摘要质量、token 计量等属 dsh 宿主能力，agent-plane 无法控制；宿主的工具执行不校验 wire 目录，`bash` 锁定依赖 `custom-bash` 自身的晋升感知（`lockAfterPromotion`）；
- **上游遗留**：`custom-bash` 的 `timeoutMs` 配置被声明但未传入 spawn（继承自上游，行为无影响）。

## 10. 贡献指南

欢迎提交问题（Issue）与改进（Pull Request）。请遵循以下约定：

1. **自包含约束**：每个预设目录必须自包含；`agent.cordis.yml` 行仅允许引用 `./` 相对路径；
2. **零依赖与零遥测**：插件不得引入第三方运行时依赖，不得发起网络请求或采集遥测；
3. **降级纪律**：新增过滤器必须提供失败降级路径（保留全部上下文 / 完整目录）；
4. **测试**：修改插件后运行 `node test/smoke.mjs`，新增行为须补充断言；
5. **归属**：派生自上游 MIT 项目的代码须保留 NOTICE 中的归属声明。

## 11. 许可证

MIT License。本项目派生自以下 MIT 项目，详见 [`NOTICE`](./NOTICE)：

- [xiaobright/dsh-anchored-standard](https://github.com/xiaobright/dsh-anchored-standard)
- [SheberDavid/v4-flash-godmode-opencode-go](https://github.com/SheberDavid/v4-flash-godmode-opencode-go)
- [yjh051108/dsh-router-standard](https://github.com/yjh051108/dsh-router-standard)
- [deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness)

## 12. 致谢

- `xiaobright/modeltest`：Project2 评测方法论与轨迹触发实验；
- `xiaobright/dsh-anchored-standard`：两阶段锚定机制；
- `yjh051108/dsh-router-standard`：persona 路由研究与 P1–P23 探针；
- `SheberDavid/v4-flash-godmode-opencode-go`：Flash 神模式 persona 与 rc.6 适配；
- `0liveiraaa/myDshPresets`：warmup 方案及其教训（合成消息 id 事故）。
