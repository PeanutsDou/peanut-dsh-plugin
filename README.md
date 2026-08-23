# peanut-dsh-plugin

DeepSeek Harness（DSH）个人插件合集——集中管理我自己维护的 DSH 相关插件、工具与皮肤。

## 插件清单

| 插件 | 说明 | 状态 |
|------|------|------|
| [dsh-schedule-ui](dsh-schedule-ui) | 定时任务管理：会话级持久化任务 + 日历循环规则（daily/weekly/monthly/yearly）+ 浏览器第三页签 UI + `schedule_task` 模型工具 | ✅ 可用 |
| [dsh-restart](dsh-restart) | DSH 自重启：`restart_harness` / `restart_with_tasks`（停机离线任务），端口释放检测、重试与诊断日志 | ✅ 可用 |
| [dsh-usage-monitor](dsh-usage-monitor) | API 余额 + token 日/月用量监控：底部状态栏、悬浮详情窗、缓存命中统计 | ✅ 可用 |
| [dsh-completion-toast](dsh-completion-toast) | 后台任务完成通知：窗口最小化时，会话结束自动在右下角弹 Windows 通知，显示会话与任务摘要 | ✅ 可用 |
| [dsh-turn-ui](dsh-turn-ui) | 长会话阅读优化：按轮次折叠过程输出与工具调用 + 左侧轮次导航条（含 DSH 核心补丁脚本） | ✅ 可用 |
| [dsh-reasoning-effort](dsh-reasoning-effort) | Codex 风格模型 + 推理强度滑块（fork 自 [HanaAyane/dsh-reasoning-effort](https://github.com/HanaAyane/dsh-reasoning-effort)，v0.5.0 → 本库 0.6.0） | ✅ 可用 |
| [dsh-find-plugin](dsh-find-plugin) | 会话内实时搜索 DSH 插件工具快照备份（上游 [awesome-dsh-plugin/dsh-find-plugin](https://github.com/awesome-dsh-plugin/dsh-find-plugin)，v0.3.6 / `e75dc2e`，已审计） | ✅ 备份 |
| [dsh-better-sidebar](dsh-better-sidebar) | DSH Web 侧边栏完整工作台：文件管理/编辑/终端/Git/内嵌浏览器/后台任务 + 第三方 Tab 注册（上游 [omdsh-dev/DSH-better-sidebar](https://github.com/omdsh-dev/DSH-better-sidebar)，v0.12.3，npm 快照备份） | ✅ 备份 |

## 目录约定

- 每个插件占一个**顶层子目录**，完全自包含（自带 README / LICENSE / 源码 / 脚本）
- 插件之间互不依赖；新增插件直接加同级目录即可
- 根目录只放导航与说明，不放插件代码
- `skills/` 存放插件开发规范等 agent skill

## 构建与安装

各插件目录内的 README 有独立的构建/安装说明。

## 许可

- 各插件目录下自带许可证
