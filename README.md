# peanut-dsh-plugin

DeepSeek Harness（DSH）个人插件合集——集中管理我自己维护的 DSH 相关插件、工具与皮肤。

## 插件清单

| 插件 | 说明 | 状态 |
|------|------|------|
| [dsh-launcher](dsh-launcher) | DSH 桌面独立窗口启动器（WebView2 壳）：开机自启（托盘壳自动拉起服务）、单实例、真 DPI 高清、自定义图标 | ✅ 可用 |
| [llm-codemaker-hub](llm-codemaker-hub) | CodeMaker Hub provider 路由：经本地 hub 代理（127.0.0.1:15721）接公司 AI 网关，多模态模型支持 | ✅ 可用 |
| [dsh-schedule-ui](dsh-schedule-ui) | 定时任务管理：会话级持久化任务 + 日历循环规则（daily/weekly/monthly/yearly）+ 浏览器第三页签 UI + `schedule_task` 模型工具 | ✅ 可用 |
| [dsh-file-launcher](dsh-file-launcher) | 双击 Ctrl 全盘文件名搜索：Everything 引擎（es.exe）+ 自包含搜索框 UI + 收藏/常用打分 | ✅ 可用 |
| [dsh-restart](dsh-restart) | DSH 自重启：`restart_harness` / `restart_with_tasks`（停机离线任务），端口释放检测、重试与诊断日志 | ✅ 可用 |
| [dsh-usage-monitor](dsh-usage-monitor) | API 余额 + token 日/月用量监控：底部状态栏、悬浮详情窗、缓存命中统计 | ✅ 可用 |
| [dsh-turn-ui](dsh-turn-ui) | 长会话阅读优化：按轮次折叠过程输出与工具调用 + 左侧轮次导航条（含 DSH 核心补丁脚本） | ✅ 可用 |
| [dsh-reasoning-effort](dsh-reasoning-effort) | Codex 风格模型 + 推理强度滑块（fork 自 [HanaAyane/dsh-reasoning-effort](https://github.com/HanaAyane/dsh-reasoning-effort)，v0.5.0 → 本库 0.5.2） | ✅ 可用 |
| [dsh-apex-standard](dsh-apex-standard) | 「梁神模式-win」预设：V4 Pro/Flash 两阶段锚定、anchor-guardian 浅轨迹自动回滚重试、Windows Git Bash 自动探测、晋升后最小常驻目录（fork 自上游 [rinDBeans/dsh-apex-standard](https://github.com/rinDBeans/dsh-apex-standard) v1.2.1 / `42da9ba`，本 fork v1.3.0） | ✅ 已修改 |
| [dsh-market](dsh-market) | DSH 可视化插件市场快照备份（上游 [dsh-market/dsh-market](https://github.com/dsh-market/dsh-market)，v1.9.0 / `1d338fe`，已审计） | ✅ 备份 |
| [dsh-find-plugin](dsh-find-plugin) | 会话内实时搜索 DSH 插件工具快照备份（上游 [awesome-dsh-plugin/dsh-find-plugin](https://github.com/awesome-dsh-plugin/dsh-find-plugin)，v0.3.6 / `e75dc2e`，已审计） | ✅ 备份 |

## 目录约定

- 每个插件占一个**顶层子目录**，完全自包含（自带 README / LICENSE / 源码 / 脚本）
- 插件之间互不依赖；新增插件直接加同级目录即可
- 根目录只放导航与说明，不放插件代码
- `skills/` 存放插件开发规范等 agent skill

## 构建与安装

各插件目录内的 README 有独立的构建/安装说明。

## 许可

- 各插件目录下自带许可证
- `dsh-launcher`：MIT（fork 自 [Ruler4396/dsh-launcher](https://github.com/Ruler4396/dsh-launcher)）
