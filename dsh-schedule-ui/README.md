# @deepseek-ai/dsh-schedule-ui

DeepSeek Harness 定时任务管理插件：在会话视图里加第三个页签「定时任务」（与「对话」「轨迹」并列），可查看、新建、修改、启动/暂停、删除当前会话的定时任务。后端复用 DSH 自带的 `dsh-schedule` 作为执行引擎（到点后在会话里注入 `[SCHEDULE REMINDER]` 提醒），本插件在其上叠一层持久化的任务存储。

- 支持三种选择器：延时（`after_seconds`）、固定间隔（`every_seconds`，≥300）、绝对时间（`at`，严格 RFC 3339 带 `Z` 或偏移量）。
- 任务有状态：运行中 / 已暂停 / 已完成；暂停 = 停止触发但保留定义，启动 = 用原定义重新注册。
- 任务定义持久化在 `~/.dsh/schedule-ui/tasks.json`（按会话隔离）。
- 到点提醒走官方 `dsh-schedule` 的 follow-up，会话关闭时不触发、重开会话后补发（session-local）。
- 不修改 DSH 源码；独立目录，装上/卸载都只动 profile。

## 目录

```text
src/index.ts            host：/schedule/tasks|create|edit|pause|resume|delete 六条 webServer 路由 + JSON 任务存储
src/client/index.tsx    browser：第三个「定时任务」页签（单文件）
scripts/wrap-client.mjs 客户端 CJS 打包成 window.__ModuleLoader__.load 交接
```

## 部署

```text
1. 构建（产出 lib/index.js + lib/client.js）：
   npm install && npm run build

2. 物理复制（勿用 link）到 profile：
   lib/ + package.json → ~/.dsh/profiles/web/node_modules/@deepseek-ai/dsh-schedule-ui/

3. 挂载依赖 + 本插件，~/.dsh/profiles/web/cordis.patch.yml 追加：
   - insert:
       - id: time-context
         name: '@deepseek-ai/dsh-time-context'
       - id: schedule
         name: '@deepseek-ai/dsh-schedule'
       - id: schedule-ui
         name: '@deepseek-ai/dsh-schedule-ui'

4. 重启 DSH（关窗重开，插件只在启动时加载）
```

`dsh-schedule` 与 `dsh-time-context` 已在 DSH 安装闭包里（默认未挂载），第 3 步把它们和本插件一起挂上即可；本插件自身的代码则必须物理复制到 profile 的 node_modules。

## 卸载

```text
1. 从 ~/.dsh/profiles/web/cordis.patch.yml 删掉上面三行
2. 删除 ~/.dsh/profiles/web/node_modules/@deepseek-ai/dsh-schedule-ui/
3. 重启 DSH
```

## 说明

- 活跃任务注册在 `dsh-schedule` 的 `schedule/change` 事件流里（走官方 `schedule_create`/`schedule_delete` 工具，校验、持久化 barrier、定时器重算都保持权威）；任务定义另存在 `~/.dsh/schedule-ui/tasks.json`，用于支持暂停/恢复/修改。
- 修改活跃任务 = 先删旧提醒再按新定义重建；修改已暂停任务只改定义。
- 一次性任务触发后自动归入「已完成」；固定间隔任务持续在「运行中」。
- 仅对当前已打开的会话可用（提醒是 session-local 的）；冷会话请先点开该会话。
- 绝对时间不解析自然语言，需填带 `Z` 或数值偏移量的 RFC 3339 字符串。
