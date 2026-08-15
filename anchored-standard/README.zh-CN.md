# dsh-anchored-standard

[English](./README.md)

这是一个实验性的 DeepSeek Harness agent preset：第一次模型请求使用与 Minimal 对齐的
完整 system prompt、两项工具，并且不注入工作区/技能上下文；会话记录首次持久晋升信号
（`tool/call` 或首次 `assistant/message`，先到者为准）后，开放 Standard 的完整工具目录
并恢复常规上下文注入。

这是社区项目，并非 DeepSeek 官方 preset，也不代表 DeepSeek 的认可或背书。

## 为什么这样做

DeepSeek V4 Pro 会强烈依赖 API 中可见的工具目录选择执行轨迹。在 Project2 评测中，
Standard 和 PTC 分别得到 91、92 分，官方 Minimal 得到 99、96 分；但如果全程停留在
Minimal，又会失去 Standard 的大部分工具。

Anchored Standard 把“首次轨迹选择”和“后续完整工具能力”拆开：

1. 保持 Minimal 的完整 system prompt；
2. 首次模型请求只暴露当前平台 shell 和 `read`；
3. 首次请求同时剥离自动注入的上下文——AGENTS.md/CLAUDE.md 工作区摘要和可用技能
   目录提醒，真正的 Minimal 根本不挂载这两个插件（`tool-bootstrap` 行的
   `suppressedContextSources`）。用户主动的技能手势不被过滤，且两者从请求 #2 起
   原样恢复；
4. 会话出现首次持久晋升信号（`tool/call` 或首次 `assistant/message`，先到者为准）
   后开放全部 Standard 工具——请求 #1 恒为 bootstrap 目录，请求 #2 起恒为完整目录，
   纯文字首答不再把会话困死在 bootstrap（`tool-bootstrap` 行的 `promoteOn` 可选
   `either` 默认 / `tool-call` / `assistant-message`）；
5. 从持久 session event 推导阶段，resume 和 reload 不会丢失状态。

Windows 首次目录为 `pwsh/read`，Linux 为 `bash/read`。

## 实测结果

Project2 V4.1b、DeepSeek V4 Pro、`reasoningEffort=max`、Windows 原生环境：

| 运行 | Ability | reasoning 块 | `we` | `let's` | `let me` | 可见回复 |
|---|---:|---:|---:|---:|---:|---:|
| r1 | 98 | 193 | 179 | 88 | 1 | 1 |
| r2 | 99 | 162 | 165 | 98 | 0 | 1 |

两轮都只出现两份工具目录快照：首次两工具，随后为 25 项 Standard 工具。这证明该方案
在本题同配置下可以复现，不代表它对所有模型和任务都普遍增益。

完整方法和聚合证据见
[`xiaobright/modeltest`](https://github.com/xiaobright/modeltest)。

## 兼容范围

开发和验证版本：

- DeepSeek Harness `0.1.0-rc.5`
- 仓库提交 [`47f9438`](https://github.com/deepseek-ai/deepseek-harness/tree/47f943859bef60e4160492346772ded9b24f765a)
- Windows / Node.js 24

DeepSeek Harness 目前仍是开发者预览版，官方明确说明未来会有破坏性变更。本 preset 是
Standard 组装的完整快照；升级 Harness 后，应先对照上游改动再继续使用。

## 安装

克隆本仓库，将整个 `preset` 目录复制到用户 preset 根目录，并将目标目录命名为
`anchored-standard`。

PowerShell：

```powershell
$target = Join-Path $env:USERPROFILE '.dsh\.agent-presets\anchored-standard'
if (Test-Path -LiteralPath $target) { throw "Preset already exists: $target" }
New-Item -ItemType Directory -Force -Path (Split-Path -Parent $target) | Out-Null
Copy-Item -Recurse -LiteralPath '.\preset' -Destination $target
```

Linux/macOS：

```sh
dsh_home="${DSH_HOME:-$HOME/.dsh}"
mkdir -p "$dsh_home/.agent-presets"
test ! -e "$dsh_home/.agent-presets/anchored-standard"
cp -R preset "$dsh_home/.agent-presets/anchored-standard"
```

完整重启 DeepSeek Harness，新建空 session，选择 **Anchored Standard (experimental)**。
不要在已经产生内容的会话中途切换 preset。

## 验证加载

导出 session JSONL，检查 `request/header`：

- 第一份 header 应只有 `pwsh/read` 或 `bash/read`；
- 第一次请求的消息中不应包含 AGENTS.md/CLAUDE.md 摘要或可用技能目录提醒——只有
  用户消息与 Minimal persona 系统提示；
- 首次工具调用或首次助手回复后，下一份变更 header 应包含完整 Standard 目录；
- 此后的请求应保持完整目录，并恢复常规上下文注入。

本仓库的零依赖测试：

```sh
npm test
```

## 重要行为

- 默认 `promoteOn: either`：会话在首次持久 `tool/call` **或** 首次 `assistant/message`
  （先到者为准）后晋升——请求 #1 见 bootstrap 目录，之后所有请求见完整目录；纯文字
  首答也会在请求 #2 晋升。改为 `promoteOn: tool-call` 可恢复原行为（首答不调工具则
  永不晋升）；
- 工具执行即使失败，只要 `tool/call` 已持久化，下一步仍会晋升；
- bootstrap 工具缺失时降级为完整目录并一次性告警，不再让请求失败，组合漂移不会锁死
  会话；非法的 `promoteOn` 值会在 preset 挂载时报错；
- 晋升判定按会话在进程内记忆化，持久事件扫描每会话每进程只执行一次。
- 会话未晋升期间，pre-step 过滤器剥离 `source.kind` 列在 `suppressedContextSources`
  中的消息（默认 `agent-instructions` 与 `skill-catalog`，即 Standard 比 Minimal 多出的
  两项自动注入）。设为 `[]` 可关闭上下文过滤；加入其他 `source.kind` 可抑制更多。
  过滤器自身出错时降级为保留全部消息，绝不吞掉上下文。
- 工具目录只变化一次，因此第一、第二次请求之间也会发生一次前缀缓存变化；
- preset 与 shell 访问具有相同信任等级，安装前应自行审阅文件；
- 插件不会发起网络请求，也不增加遥测。

## Zero-Anchored Standard（实验）

这是不改变上面 Anchored Standard 逻辑的额外测试模式。它沿用同一套 Minimal
对齐的 system prompt，但首轮不再暴露两个工具，而是先注入一轮固定的零工具锚定
对话：

1. 用户发出第一条消息时，`anchor-turn` 插件会把固定消息——"This round is a
   test. Tools are not open yet; all tools will open next round."——插到它前面；
2. 第一个真实模型请求携带 **0 个工具**，首条思维链因此走零注入的 "we" 轨迹；
3. 锚定回复落库后开放完整 Standard 目录，真实消息带着全部工具继续。

锚定发生在第一条消息到达时而不是会话创建时，因此新建会话仍然可以先切换模式；
子 agent 始终看到完整目录。

实测行为（opencode-go、DeepSeek V4 Pro、`reasoningEffort=max`）：锚定请求稳定
为 "we" 风格且 `let me` 为 0；后续带工具请求会回到 "The user wants…/Let me"
风格。因此该模式用于对比"零工具首轮是否值得多一次模型调用"，并不承诺工具轮次
保持 "we" 风格。

以独立 preset id 安装：

```sh
dsh_home="${DSH_HOME:-$HOME/.dsh}"
mkdir -p "$dsh_home/.agent-presets"
test ! -e "$dsh_home/.agent-presets/zero-anchored-standard"
cp -R zero-anchored-standard "$dsh_home/.agent-presets/zero-anchored-standard"
```

重启 DeepSeek Harness，新建空白会话，选择 **Zero-Anchored Standard
(experimental)**，然后发送第一条消息。

## 官方生态要求

DeepSeek 当前建议社区作者把插件放在自己的 GitHub 项目中，并为仓库添加
[`dsh-plugin`](https://github.com/topics/dsh-plugin) topic 方便发现。官方仓库目前不接受
外部 PR，也没有强制社区插件仓库模板。原文见官方
[`CONTRIBUTING.zh.md`](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/CONTRIBUTING.zh.md)。

## 许可证

MIT。`preset/agent.cordis.yml` 基于 DeepSeek Harness Standard preset 修改，原始 DeepSeek
版权和 MIT 许可声明保留在 [`NOTICE`](./NOTICE) 中。
