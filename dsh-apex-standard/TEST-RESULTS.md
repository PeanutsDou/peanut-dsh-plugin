# anchor-guardian 实测记录（2026-08-16）

环境：dsh 0.1.0-rc.6、deepseek-v4-pro、Windows 10/11（Git Bash）、
`apex-guardian` v1.3.0（`maxAttempts: 3`、`earlyAbort: true`、`wakeMode: followup`）。
每轮均为全新会话；困难 shell 任务用同一个 prompt 重复采样。

## 汇总

| 轮次 | 语言 | 任务 | 首轮深轨迹 | guardian 后最终深轨迹 | 平均尝试轮 |
| --- | --- | --- | --- | --- | --- |
| 1 | 英文 | 困难 shell（pwd/ls 类） | 3/10 (30%) | 10/10 (100%) | 1.7 |
| 2 | 英文 | 真实编码修复（sum.js + node test） | 10/10 (100%) | 10/10 (100%) | 1.0 |
| 3 | 中文 | 困难 shell（pwd/ls 类） | 7/10 (70%) | 10/10 (100%) | 1.3 |
| 4 | 中文 | 真实编码修复（sum.js + node test） | 10/10 (100%) | 10/10 (100%) | 1.0 |
| 合计 | | | 30/40 (75%) | 40/40 (100%) | 1.4 |

关键结论：

- 10 次首轮浅/含糊轨迹，guardian 全部在 1 次重试内翻转为 `we` 深度轨迹。
- 20 个真实编码任务全部修复正确并通过测试，guardian 零重试（无额外开销）。
- 语言影响首轮触发率：同一个困难 shell prompt，英文首轮约 30%，中文约 70%；guardian 对两种语言都能兜到 100%。
- 每次重试的首请求均保持 Minimal 双工具 `[bash, str_replace_editor]`，且无 time-context / AGENTS.md / skill-catalog 注入。
- 浅首块会提前 abort 当前 turn（不执行工具），失败成本约等于一次模型首响应；本批困难任务失败+重试会话耗时约 10–20s。

## 判定规则

首块 reasoning 分类：

- `we > 0` 且 `let me == 0` → 深轨迹（放行）
- 含 `let me` → 浅轨迹（回滚重试）
- 两者皆无 → 含糊，按浅处理（回滚重试）

`maxAttempts` 耗尽后强制 fail-open，不阻塞会话。

## 产物

完整 session JSONL 与脚本位于本地测试目录 `_research_anchor_test/results/`，未随包发布。
