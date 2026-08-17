# dsh-completion-toast

DSH 后台任务完成通知插件。

当 DSH 窗口被最小化/隐藏时，如果某个正在运行的会话结束（agent 从 running 回到 idle），自动在屏幕右下角弹出 Windows 通知：

- 标题：`DeepSeek Harness`
- 内容：`会话「<会话标题>」任务完成：<最近一条用户消息摘要>`

通知使用 DSH 图标，跟随 Windows 系统通知样式。

## 功能

- 监听 `agent/status`：`running` → `idle` 判定一次任务完成
- 客户端通过 `visibilitychange` / `blur` / `focus` 上报窗口是否隐藏
- 只有窗口隐藏时才弹通知，避免你正在看的时候打扰
- 自动提取会话标题和最近用户消息作为摘要
- 使用 PowerShell `NotifyIcon` 弹出系统右下角通知，零 npm 运行时依赖

## 安装

1. 构建：

   ```bash
   pnpm install
   pnpm run build
   ```

2. 复制到 profile：

   ```bash
   cp -r . ~/.dsh/profiles/web/node_modules/@peanutsdou/dsh-completion-toast
   ```

3. 在 `~/.dsh/profiles/web/cordis.patch.yml` 追加：

   ```yaml
   - id: dsh-completion-toast
     name: '@peanutsdou/dsh-completion-toast'
   ```

4. 重启 DSH。

## 限制

- 仅 Windows 支持（使用 PowerShell NotifyIcon）
- 只对插件启动后发生的 running→idle 转换生效
- 摘要取最近一条 `user/message` 的纯文本内容，截断到 80 字

## 许可

MIT
