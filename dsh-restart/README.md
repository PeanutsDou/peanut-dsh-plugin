# dsh-restart

重启整个 DeepSeek Harness 进程的插件，用于重新加载插件与配置（profile 的 cordis 组合、settings 等）。host + client 双半，装进 profile 的 bundle 后即可用。

## 功能

- **模型工具 `restart_harness`**：让 agent 直接安排一次进程重启（可选 `delayMs`）。重启 helper 会**等待旧进程释放端口**（而不是固定延时）后拉起新进程，并对早期退出自动重试、把诊断写入 `%TEMP%\dsh-restart-*.err.log`。
- **模型工具 `restart_with_tasks`**：安排一次"停机离线任务 + 重启"——旧进程退出后、新进程拉起前，由独立 runner 依次执行预写的自动化脚本，再自动重启（详见下文）。
- **`.ps1` 离线步骤编码安全**：runner 优先使用 `pwsh.exe -File`；没有 pwsh 时用 Windows PowerShell 5.1 的 `-EncodedCommand` 回退，按 UTF-8 读取 BOM-less 脚本，不再受系统 ANSI/GBK 代码页影响。
- **`/restart` 斜杠命令**：在 UI 里手动触发重启。
- **配置卡片**（设置 → 插件 → 插件配置 → 「DSH 重启」）：可视化编辑以下设置，改动即时写入 `settings.yaml`：
  - `legacyRestart` — 旧 PowerShell/WMI/taskkill 重启方式（默认关闭，用 Node 原生方式）。
  - `continuePrompt` — 重启后自动继续时注入给 agent 的提示词。
  - `watchdogEnabled` — 崩溃/关闭时自动拉起 DSH（默认关闭，需谨慎）。
  - `watchdogCooldownMs` / `watchdogPollMs` — 看门狗冷却与轮询间隔。
- **「立即重启」按钮**：卡片内的同源重启端点。出于安全考虑，仅接受来自环回地址（127.0.0.1 / localhost）的同源 POST 请求；经反向代理/远程访问时该按钮会被拒绝（403）。

## 安装

1. 把包加入 profile 依赖并挂进 bundle：

```jsonc
// profiles/<profile>/package.json
{
  "dependencies": { "dsh-restart": "..." },
  "dsh": { "profile": { "bundles": ["...", "dsh-restart"] } }
}
```

2. 重启 DSH（`/restart` 或 `restart_harness`），刷新页面后即可看到卡片。

## 停机离线任务（`restart_with_tasks`）

解决"需要在 DSH 关闭之后、重启之前完成一些事情"的任务：agent 预先评估复杂度、把**可脚本化的确定性步骤**写成脚本，调度一次离线任务——旧进程退出后，detached runner 等端口释放 → 依次执行步骤（每步日志 + 退出码）→ 写 `results/summary.json` → 按原命令行自动重启 → 重启后向会话注入续跑提示词。

- **模式**
  - `auto`：全部必选步骤成功（可选步骤失败不中止）后自动重启。
  - `prepare`：步骤执行完即停止、**不自动重启**——剩余需要人工完成的步骤由用户在 DSH 运行时（或手动停服后）完成，再手动重启。
- **步骤脚本**：`.js/.cjs/.mjs`（node 执行）、`.ps1`（powershell 执行）、`.cmd/.bat`（cmd 执行），传绝对路径，支持 `args`、`timeoutMs`（默认 120s，超时 taskkill 整树）、`required`（默认 true，失败即中止并放弃重启）。
- **产物位置**：`$DSH_HOME/offline/missions/<missionId>/` 下 `mission.json`（状态机：planned → down → tasks → relaunched / prepare-done / failed / aborted）、`results/summary.json`、`results/step-N.log`、`mission-<id>.runner.log`（runner 自身日志）。
- **复杂度评估（务必遵守）**：只有可脚本化的确定性步骤（文件操作、迁移、备份、测试运行、外部服务调用、等待端口/条件）才能放进 `tasks`；需要人工判断、交互或提供新信息的步骤绝不能放进 `tasks`——应直接在对话中告知用户，等用户完成后手动重启，或先用 `mode=prepare` 跑完可脚本化部分再交接。
- **安全**：旧进程端口不释放（默认 30s）即中止，绝不误杀；`required=false` 的步骤失败不影响任务成败；`mode=prepare` 或必选步骤失败时绝不自动重启（若启用了 watchdog，注意它仍可能按端口探测自动拉起）。
- 使用本工具时忽略 `legacyRestart` 设置（始终走 Node 原生路径）。

## 构建

```bash
pnpm install
node scripts/link-dsh-workspace.mjs --source <path-to-deepseek-harness>
pnpm run build
```

host 半由 `tsc` 输出到 `lib/index.js`（`@deepseek-ai/*` 保持外部依赖）；client 半由 `tsdown` 打成单文件 `lib/client.js`。

## 测试

```bash
node --test tests/restart.test.mjs
```

覆盖两个核心回归场景：

1. 普通重启 helper 在旧进程仍占用端口时不会按固定延时抢跑，而是等端口释放后再拉起新进程，并确认新进程存活。
2. 离线 runner 在 `PATH` 中没有 pwsh 时，仍能正确执行 BOM-less UTF-8（含中文注释）的 `.ps1` 脚本，并完成 auto 模式重启。
