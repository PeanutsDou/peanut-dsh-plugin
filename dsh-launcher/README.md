# dsh-launcher（fork · 修复版）

DeepSeek Harness 的 Windows 桌面壳：把 Web UI 装进独立的 WebView2 窗口——免浏览器、免手动敲命令，双击即用。

> Fork 自 [Ruler4396/dsh-launcher](https://github.com/Ruler4396/dsh-launcher) v0.1.0（MIT 协议）。

## 特性（继承自上游）

- **独立窗口**：C# WinForms + WebView2 单文件壳（约 1MB），界面即 DSH Web UI 原样呈现
- **开机自启**：`start-dsh.vbs` 放启动文件夹，登录后静默拉起 `dsh web`（不弹窗）
- **单实例**：重复双击只把已有窗口带到前台
- **自动拉起服务**：启动时探测 3080 端口，未运行则自动启动 dsh，最长等 90s
- **下载/弹窗策略、渲染崩溃自愈**

## 本 fork 的改动（相对 v0.1.0 release）

1. **修复「分辨率糊」**：原 release 进程 DPI 不感知（100%），在 125%/150% 缩放屏上被 Windows 位图拉伸变糊。改为在 `Main()` 最先调用 `Application.SetHighDpiMode(HighDpiMode.PerMonitorV2)`，实测窗口 DPI 96 → 120（125%）。
2. **修复「无图标」**：原 release 未打入图标资源。生成多尺寸 `app.ico`（16–256px）经 `<ApplicationIcon>` 嵌入 exe，窗口/任务栏/快捷方式统一显示。
3. **启动即最大化**：`WindowState = FormWindowState.Maximized`（原来是固定 1280×840）。
4. **目标框架 net10.0-windows → net9.0-windows**：便于用 .NET 9 SDK 构建。

## 构建

前置：Windows 10/11（自带 WebView2 Runtime）、.NET SDK 9+。

```powershell
dotnet publish src/DshShell/DshShell.csproj -c Release -r win-x64 --self-contained false -p:PublishSingleFile=true -o dist
```

产物：`dist/DshWeb.exe`、`dist/WebView2Loader.dll`、`dist/runtimes/`。

## 安装

1. 全局安装 dsh：`npm install -g @deepseek-ai/dsh`
2. 把 `dist/` 与 `scripts/start-dsh.vbs` 放到同一目录（如 `%LOCALAPPDATA%\Programs\dsh-launcher`）
3. 双击 `DshWeb.exe`；右键发送桌面快捷方式
4. （可选）开机自启：把 `scripts/start-dsh.vbs` 复制到 `shell:startup`

> 端口默认 3080。改端口需同步改 `scripts/start-dsh.vbs` 与 `Program.cs` 中的常量。

## 许可

MIT，继承自上游。见 [LICENSE](LICENSE)。
