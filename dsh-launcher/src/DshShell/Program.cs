using System.Diagnostics;
using System.Drawing;
using System.Net.Sockets;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.RegularExpressions;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

namespace DshWeb;

internal static class Program
{
    private const string Url = "http://127.0.0.1:3080";
    private const int Port = 3080;
    private const int SW_RESTORE = 9;

    // 全局键盘钩子（双击 Ctrl 唤起）
    private const int WH_KEYBOARD_LL = 13;
    private const int WM_KEYDOWN = 0x0100;
    private const int WM_KEYUP = 0x0101;
    private const int VK_CONTROL = 0x11;
    private const int VK_LCONTROL = 0xA2;
    private const int VK_RCONTROL = 0xA3;
    private const int TRIGGER_WINDOW_MS = 500;
    private const int TRIGGER_COOLDOWN_MS = 300;

    /// 渲染进程崩溃自动重载的节流时间戳（避免崩溃死循环）。
    private static long _lastReloadTick;

    private static Form? _mainForm;
    private static NotifyIcon? _notifyIcon;
    private static Icon? _appIcon;
    private static bool _forceExit;
    private static bool _startInTray;
    private static int _wmShowMain;
    private static bool _closePromptShowing;

    // 双击 Ctrl 检测状态
    private static long _lastCtrlDownAt;
    private static long _lastTriggeredAt;
    private static bool _ctrlIsDown;

    // 键盘钩子句柄 + 委托（static 字段保持引用，防止被 GC）
    private static LowLevelKeyboardProc? _keyboardProc;
    private static IntPtr _hookId = IntPtr.Zero;

    // 文件搜索框 overlay（双击 Ctrl 唤起）
    private static Form? _launcherForm;
    private static WebView2? _launcherWeb;

    private delegate IntPtr LowLevelKeyboardProc(int nCode, IntPtr wParam, IntPtr lParam);

    /// <summary>
    /// 主窗口：监听第二个实例发来的"显示主窗口"消息，由第一个实例自己执行完整恢复，
    /// 避免第二个实例用 ShowWindow(SW_RESTORE) 硬拉隐藏窗口导致 WebView2 白屏。
    /// </summary>
    private sealed class MainForm : Form
    {
        public Action? ShowRequested;
        protected override void WndProc(ref Message m)
        {
            if (m.Msg == _wmShowMain)
            {
                ShowRequested?.Invoke();
                return;
            }
            base.WndProc(ref m);
        }
    }

    [DllImport("user32.dll", CharSet = CharSet.Auto)]
    private static extern bool DestroyIcon(IntPtr handle);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern IntPtr FindWindow(string? lpClassName, string? lpWindowName);

    [DllImport("user32.dll")]
    private static extern bool SetForegroundWindow(IntPtr hWnd);

    [DllImport("user32.dll")]
    private static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);

    [DllImport("user32.dll", SetLastError = true)]
    private static extern IntPtr SetWindowsHookEx(int idHook, LowLevelKeyboardProc lpfn, IntPtr hMod, uint dwThreadId);

    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool UnhookWindowsHookEx(IntPtr hhk);

    [DllImport("user32.dll")]
    private static extern IntPtr CallNextHookEx(IntPtr hhk, int nCode, IntPtr wParam, IntPtr lParam);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)]
    private static extern IntPtr GetModuleHandle(string? lpModuleName);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern int RegisterWindowMessage(string message);

    [DllImport("user32.dll")]
    private static extern bool PostMessage(IntPtr hWnd, int msg, IntPtr wParam, IntPtr lParam);

    [STAThread]
    private static void Main(string[] args)
    {
        // --tray：开机自启时静默启动到托盘（不显示主窗口），双击 Ctrl 直接可用
        _startInTray = args is not null
            && Array.Exists(args, a => a == "--tray" || a == "-tray" || a == "--minimized");

        // PerMonitorV2：按真实屏幕 DPI 渲染。否则进程 DPI 不感知，Windows 会把 100% 画面
        // 位图拉伸到 125%+，整个 Web UI 看起来发糊。必须最先调用、早于任何窗口创建。
        Application.SetHighDpiMode(HighDpiMode.PerMonitorV2);

        // 自定义窗口消息：第二个实例发它，通知第一个实例完整恢复窗口
        _wmShowMain = RegisterWindowMessage("DshWeb.ShowMainForm");
        DebugLog($"process start pid={Environment.ProcessId}");

        // 单实例：重复启动只通知已开实例恢复窗口，避免多开 WebView2 进程白白占用内存
        using var mutex = new Mutex(true, @"Local\DshWeb.SingleInstance", out var firstInstance);
        if (!firstInstance)
        {
            var existing = FindWindow(null, "DeepSeek Harness");
            DebugLog($"second instance, found={existing != IntPtr.Zero}");
            if (existing != IntPtr.Zero)
            {
                PostMessage(existing, _wmShowMain, IntPtr.Zero, IntPtr.Zero);
                DebugLog("second instance, posted ShowMainForm message");
            }
            return;
        }

        // 服务未启动时自动拉起（调用同目录下的 start-dsh.vbs 静默启动）
        if (!PortOpen())
        {
            var vbs = Path.Combine(AppContext.BaseDirectory, "start-dsh.vbs");
            if (File.Exists(vbs))
            {
                Process.Start(new ProcessStartInfo("wscript.exe", "\"" + vbs + "\"") { UseShellExecute = true });
                for (var i = 0; i < 90 && !PortOpen(); i++)
                    Thread.Sleep(1000);
            }
            else
            {
                MessageBox.Show("未找到 start-dsh.vbs，无法启动 dsh 服务。", "DeepSeek Harness",
                    MessageBoxButtons.OK, MessageBoxIcon.Warning);
                return;
            }
        }

        if (!PortOpen())
        {
            MessageBox.Show("dsh 服务启动超时，请查看日志：%USERPROFILE%\\.dsh-web.log", "DeepSeek Harness",
                MessageBoxButtons.OK, MessageBoxIcon.Warning);
            return;
        }

        Application.EnableVisualStyles();
        Application.SetCompatibleTextRenderingDefault(false);

        try { _appIcon = Icon.ExtractAssociatedIcon(Application.ExecutablePath); }
        catch { _appIcon = null; }

        var form = new MainForm
        {
            Text = "DeepSeek Harness",
            ClientSize = new Size(1280, 840),
            StartPosition = FormStartPosition.CenterScreen,
            MinimumSize = new Size(800, 600),
            WindowState = FormWindowState.Maximized,
            Icon = _appIcon ?? SystemIcons.Application,
            Opacity = _startInTray ? 0 : 1
        };
        _mainForm = form;
        form.ShowRequested = () => ShowMainForm(form);

        var web = new WebView2 { Dock = DockStyle.Fill };
        form.Controls.Add(web);

        // 关闭窗口：首次弹出选择（最小化到托盘 / 关闭），可记住选择；记住后不再提示。
        form.FormClosing += (_, e) =>
        {
            DebugLog($"FormClosing forceExit={_forceExit}");
            // 托盘菜单"退出"已确认，直接放行并清理
            if (_forceExit)
            {
                CleanupShutdown(web);
                return;
            }

            // 已记住的偏好，直接执行
            var pref = LoadClosePreference();
            DebugLog($"FormClosing pref={pref}");
            if (pref == "tray") { e.Cancel = true; HideToTray(); return; }
            if (pref == "exit") { CleanupShutdown(web); return; }

            // 首次关闭：先取消关闭，再延迟弹窗。避免在 FormClosing 事件里直接弹模态
            // 对话框（TaskDialog）导致的窗口重入 / 白屏窗口问题。
            e.Cancel = true;
            if (_closePromptShowing) return;
            _closePromptShowing = true;
            form.BeginInvoke(() =>
            {
                try
                {
                    var choice = AskCloseAction();
                    if (choice.Remember) SaveClosePreference(choice.Action);
                    if (choice.Action == "tray") HideToTray();
                    else if (choice.Action == "exit") { _forceExit = true; form.Close(); }
                    // cancel：什么都不做，窗口保持打开
                }
                finally
                {
                    _closePromptShowing = false;
                }
            });
        };

        form.Load += async (_, _) =>
        {
            // WebView2 user data goes to %LOCALAPPDATA%\DshWeb to keep the app dir clean
            // (固定目录：避免系统临时目录被清理导致会话/插件登录态丢失)
            var userDataFolder = Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                "DshWeb", "WebView2");
            await InitWebViewAsync(web, userDataFolder);
            web.CoreWebView2.Navigate(Url);
            // 托盘启动：主窗口 WebView2 就绪后立即隐藏到托盘
            if (_startInTray) HideToTray();
        };

        SetupTray(form);
        StartHotkey(form);

        Application.Run(form);
    }

    // ===== 托盘 =====

    private static void SetupTray(Form form)
    {
        var menu = new ContextMenuStrip();
        menu.Items.Add("显示主窗口", null, (_, _) => ShowMainForm(form));
        menu.Items.Add(new ToolStripSeparator());
        menu.Items.Add("退出（同时关闭 DSH 服务）", null, (_, _) =>
        {
            _forceExit = true;
            form.Close();
        });

        _notifyIcon = new NotifyIcon
        {
            Icon = _appIcon ?? SystemIcons.Application,
            Text = "DeepSeek Harness",
            Visible = true,
            ContextMenuStrip = menu
        };
        _notifyIcon.DoubleClick += (_, _) => ShowMainForm(form);
    }

    private static void ShowMainForm(Form form)
    {
        DebugLog($"ShowMainForm called, state={form.WindowState} visible={form.Visible}");
        form.Opacity = 1;
        form.Show();
        // 注意：不要改 form.ShowInTaskbar！它会触发 RecreateHandle 销毁重建窗口句柄，
        // 导致 WebView2 内容丢失 + 白屏。窗口 Show 后任务栏按钮自然恢复。
        // 仅最小化时恢复为普通窗口；最大化保持最大化（SW_RESTORE 会把最大化降级，
        // 状态切换 + 尺寸变化会导致 WebView2 白屏）
        if (form.WindowState == FormWindowState.Minimized)
            form.WindowState = FormWindowState.Normal;
        form.Activate();
        SetForegroundWindow(form.Handle);
        DebugLog($"ShowMainForm done, state={form.WindowState} visible={form.Visible}");
    }

    /// 真正退出前的清理：释放 WebView2、停热键、杀 DSH、清理托盘与图标。
    private static void CleanupShutdown(WebView2 web)
    {
        try { web.Dispose(); } catch { /* ignore */ }
        StopHotkey();
        KillDsh();
        _notifyIcon?.Dispose();
        _appIcon?.Dispose();
    }

    /// 隐藏到托盘（不退出，DSH 继续后台运行）。
    private static void HideToTray()
    {
        DebugLog("HideToTray called");
        var form = _mainForm;
        if (form is null || form.IsDisposed) return;
        form.Hide();
        // 注意：不要改 form.ShowInTaskbar！它会触发 RecreateHandle 销毁重建窗口句柄，
        // 重建后窗口自动弹出且 WebView2 内容丢失 → 白屏。窗口 Hide 后任务栏按钮自然消失。
        if (_notifyIcon is not null) _notifyIcon.Visible = true;
        DebugLog($"HideToTray done, visible={form.Visible} state={form.WindowState}");
    }

    /// 诊断日志：写 %LOCALAPPDATA%\DshWeb\debug.log（定位窗口生命周期问题）。
    private static void DebugLog(string message)
    {
        try
        {
            var p = Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                "DshWeb", "debug.log");
            Directory.CreateDirectory(Path.GetDirectoryName(p)!);
            File.AppendAllText(p, $"[{DateTime.Now:HH:mm:ss.fff}] {message}\r\n");
        }
        catch { /* ignore */ }
    }

    /// 关闭偏好配置文件路径。
    private static string ClosePrefPath()
    {
        return Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
            "DshWeb", "close-action.txt");
    }

    private static string LoadClosePreference()
    {
        try
        {
            var p = ClosePrefPath();
            if (File.Exists(p)) return File.ReadAllText(p).Trim();
        }
        catch { /* ignore */ }
        return "";
    }

    private static void SaveClosePreference(string action)
    {
        try
        {
            var p = ClosePrefPath();
            Directory.CreateDirectory(Path.GetDirectoryName(p)!);
            File.WriteAllText(p, action);
        }
        catch { /* ignore */ }
    }

    /// 关闭确认弹窗：最小化到托盘 / 关闭，可勾选"记住我的选择"。
    private static (string Action, bool Remember) AskCloseAction()    {
        var trayBtn = new TaskDialogButton("最小化到托盘");
        var exitBtn = new TaskDialogButton("关闭");
        var page = new TaskDialogPage
        {
            Caption = "DeepSeek Harness",
            Heading = "关闭窗口",
            Text = "选择关闭后的行为（最小化到托盘可继续后台运行）：",
            Icon = TaskDialogIcon.Information,
            AllowCancel = true,
            Buttons = { trayBtn, exitBtn },
            Verification = new TaskDialogVerificationCheckBox
            {
                Text = "记住我的选择，不再提示"
            }
        };

        var result = TaskDialog.ShowDialog(page);
        var remember = page.Verification.Checked;
        if (result == trayBtn) return ("tray", remember);
        if (result == exitBtn) return ("exit", remember);
        return ("cancel", false);
    }

    // ===== 全局双击 Ctrl 热键 =====

    private static void StartHotkey(Form form)
    {
        try
        {
            _keyboardProc = HookCallback;
            using var cur = Process.GetCurrentProcess();
            using var mod = cur.MainModule;
            _hookId = SetWindowsHookEx(WH_KEYBOARD_LL, _keyboardProc, GetModuleHandle(mod?.ModuleName), 0);
        }
        catch (Exception ex)
        {
            Debug.WriteLine($"[DshShell] 全局热键注册失败: {ex.Message}");
        }
    }

    private static void StopHotkey()
    {
        if (_hookId != IntPtr.Zero)
        {
            UnhookWindowsHookEx(_hookId);
            _hookId = IntPtr.Zero;
        }
    }

    private static IntPtr HookCallback(int nCode, IntPtr wParam, IntPtr lParam)
    {
        if (nCode >= 0)
        {
            var vkCode = Marshal.ReadInt32(lParam);
            var isCtrl = vkCode is VK_CONTROL or VK_LCONTROL or VK_RCONTROL;
            if (isCtrl)
            {
                if (wParam == (IntPtr)WM_KEYDOWN)
                {
                    if (!_ctrlIsDown)
                    {
                        _ctrlIsDown = true;
                        var now = Environment.TickCount64;
                        var withinDoubleTap = now - _lastCtrlDownAt <= TRIGGER_WINDOW_MS;
                        var outsideCooldown = now - _lastTriggeredAt > TRIGGER_COOLDOWN_MS;
                        _lastCtrlDownAt = now;
                        if (withinDoubleTap && outsideCooldown)
                        {
                            _lastTriggeredAt = now;
                            DebugLog("double-Ctrl triggered -> ToggleLauncher");
                            ToggleLauncher();
                        }
                    }
                }
                else if (wParam == (IntPtr)WM_KEYUP)
                {
                    _ctrlIsDown = false;
                }
            }
        }
        return CallNextHookEx(_hookId, nCode, wParam, lParam);
    }

    private static void BringWindowToFront()
    {
        var form = _mainForm;
        if (form is null || form.IsDisposed) return;
        if (form.InvokeRequired)
        {
            form.BeginInvoke(BringWindowToFront);
            return;
        }
        if (form.WindowState == FormWindowState.Minimized)
            form.WindowState = FormWindowState.Normal;
        form.Show();
        // 注意：不要改 form.ShowInTaskbar（RecreateHandle 销毁重建 → 白屏），见 ShowMainForm。
        form.Activate();
        SetForegroundWindow(form.Handle);
    }

    // ===== 文件搜索框 overlay（双击 Ctrl 唤起） =====

    private const int LauncherWidth = 560;
    private const int LauncherCollapsedHeight = 50;
    private const int LauncherCornerRadius = 14;

    private static void ToggleLauncher()
    {
        // 键盘钩子回调运行在 UI 线程，但保险起见跨线程时封送到主窗体线程
        var main = _mainForm;
        if (main is not null && !main.IsDisposed && main.InvokeRequired)
        {
            main.BeginInvoke(ToggleLauncher);
            return;
        }
        var form = _launcherForm;
        if (form is null || form.IsDisposed)
        {
            CreateLauncher();
            return;
        }
        if (form.Visible) HideLauncher();
        else ShowLauncher();
    }

    private static void ShowLauncher()
    {
        var form = _launcherForm;
        if (form is null || form.IsDisposed) { CreateLauncher(); return; }
        if (!form.Visible)
        {
            ResizeLauncher(LauncherCollapsedHeight);
            PlaceLauncher(form);
            form.Show();
        }
        // 每次唤起重新加载页面（让 launcher.html 的改动即时生效，无需重启）
        try { _launcherWeb?.CoreWebView2?.Navigate(Url + "/file-launcher"); } catch { /* ignore */ }
        form.Activate();
        SetForegroundWindow(form.Handle);
        try { _launcherWeb?.Focus(); } catch { /* ignore */ }
    }

    private static void HideLauncher()
    {
        var form = _launcherForm;
        if (form is null || form.IsDisposed) return;
        form.Hide();
    }

    private static void PlaceLauncher(Form form)
    {
        try
        {
            var area = Screen.FromPoint(Cursor.Position).WorkingArea;
            form.Location = new Point(
                area.Left + (area.Width - form.Width) / 2,
                area.Top + (int)(area.Height * 0.15));
        }
        catch { /* 保持 CenterScreen 默认 */ }
    }

    private static void ApplyRoundedRegion(Form form)
    {
        try
        {
            var d = LauncherCornerRadius * 2;
            var path = new System.Drawing.Drawing2D.GraphicsPath();
            path.AddArc(0, 0, d, d, 180, 90);
            path.AddArc(form.Width - d, 0, d, d, 270, 90);
            path.AddArc(form.Width - d, form.Height - d, d, d, 0, 90);
            path.AddArc(0, form.Height - d, d, d, 90, 90);
            path.CloseFigure();
            form.Region = new Region(path);
        }
        catch { /* ignore */ }
    }

    private static void ResizeLauncher(int height)
    {
        var form = _launcherForm;
        if (form is null || form.IsDisposed) return;
        if (form.InvokeRequired)
        {
            form.BeginInvoke(() => ResizeLauncher(height));
            return;
        }
        var h = Math.Max(LauncherCollapsedHeight, Math.Min(520, height));
        form.ClientSize = new Size(LauncherWidth, h);
        ApplyRoundedRegion(form);
    }

    private static void HandleLauncherMessage(string? json)
    {
        if (string.IsNullOrWhiteSpace(json)) return;
        try
        {
            using var doc = System.Text.Json.JsonDocument.Parse(json);
            var root = doc.RootElement;
            var type = root.TryGetProperty("type", out var t) ? t.GetString() : null;
            if (type == "close")
            {
                HideLauncher();
            }
            else if (type == "resize")
            {
                var h = root.TryGetProperty("height", out var hv) && hv.TryGetInt32(out var n)
                    ? n
                    : LauncherCollapsedHeight;
                ResizeLauncher(h);
            }
        }
        catch { /* ignore */ }
    }

    private static void CreateLauncher()
    {
        DebugLog("CreateLauncher called");
        var form = new Form
        {
            Text = "文件搜索",
            ClientSize = new Size(LauncherWidth, LauncherCollapsedHeight),
            FormBorderStyle = FormBorderStyle.None,
            ShowInTaskbar = false,
            StartPosition = FormStartPosition.CenterScreen,
            TopMost = true,
            KeyPreview = true,
        };
        var web = new WebView2 { Dock = DockStyle.Fill };
        form.Controls.Add(web);
        _launcherForm = form;
        _launcherWeb = web;

        form.KeyDown += (_, e) =>
        {
            if (e.KeyCode == Keys.Escape) HideLauncher();
        };

        // 关闭时仅隐藏，不销毁（下次唤起更快）
        form.FormClosing += (_, e) =>
        {
            e.Cancel = true;
            HideLauncher();
        };

        form.Load += async (_, _) =>
        {
            try
            {
                var userDataFolder = Path.Combine(
                    Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                    "DshWeb", "WebView2");
                await InitWebViewAsync(web, userDataFolder);
                web.CoreWebView2.WebMessageReceived += (_, e) =>
                {
                    try
                    {
                        HandleLauncherMessage(e.WebMessageAsJson);
                    }
                    catch { /* ignore */ }
                };
                ApplyRoundedRegion(form);
                web.CoreWebView2.Navigate(Url + "/file-launcher");
            }
            catch (Exception ex)
            {
                DebugLog($"launcher init failed: {ex.Message}");
            }
        };

        ShowLauncher();
        DebugLog("launcher shown");
    }

    // ===== 退出时杀掉 DSH 服务 =====

    private static void KillDsh()
    {
        try
        {
            var psi = new ProcessStartInfo
            {
                FileName = "powershell.exe",
                UseShellExecute = false,
                CreateNoWindow = true
            };
            psi.ArgumentList.Add("-NoProfile");
            psi.ArgumentList.Add("-Command");
            psi.ArgumentList.Add(
                "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" " +
                "| Where-Object { $_.CommandLine -match '--port 3080' } " +
                "| ForEach-Object { Stop-Process -Id $_.ProcessId -Force }");
            using var p = Process.Start(psi);
            p?.WaitForExit(5000);
        }
        catch { /* ignore */ }
    }

    // ===== 以下为原有 WebView2 初始化逻辑（保持不变） =====

    /// <summary>
    /// 统一的 WebView2 初始化：设置 + 权限 + 下载 + 弹窗 + 崩溃自愈。
    /// 主窗口与插件弹出的内部窗口共用，保证行为一致。
    /// </summary>
    private static async Task InitWebViewAsync(WebView2 web, string userDataFolder)
    {
        web.CreationProperties = new CoreWebView2CreationProperties { UserDataFolder = userDataFolder };
        await web.EnsureCoreWebView2Async();

        var settings = web.CoreWebView2.Settings;
        settings.AreDefaultContextMenusEnabled = true;   // 保留右键菜单（复制/粘贴等）
        settings.AreDevToolsEnabled = true;              // 保留 F12（仅实际打开时才占用内存）
        settings.IsGeneralAutofillEnabled = false;       // 关闭表单自动填充，减少后台开销
        settings.IsPasswordAutosaveEnabled = false;      // 不保存密码

        // 权限：自动放行插件/DSH 依赖的能力，其余保持默认拒绝。
        web.CoreWebView2.PermissionRequested += (_, e) =>
        {
            if (e.PermissionKind is CoreWebView2PermissionKind.Notifications
                or CoreWebView2PermissionKind.ClipboardRead
                or CoreWebView2PermissionKind.Autoplay
                or CoreWebView2PermissionKind.MultipleAutomaticDownloads
                or CoreWebView2PermissionKind.PersistentStorage)
                e.State = CoreWebView2PermissionState.Allow;
        };

        // 下载：固定保存到系统“下载”文件夹（自动避开同名文件），完成后用默认程序打开
        web.CoreWebView2.DownloadStarting += (_, e) =>
        {
            try
            {
                var downloads = Path.Combine(
                    Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), "Downloads");
                Directory.CreateDirectory(downloads);
                var name = SanitizeFileName(SuggestDownloadName(
                    e.DownloadOperation.ContentDisposition, e.DownloadOperation.Uri, e.DownloadOperation.MimeType));
                var path = Path.Combine(downloads, name);
                for (var i = 1; File.Exists(path); i++)
                    path = Path.Combine(downloads,
                        $"{Path.GetFileNameWithoutExtension(name)} ({i}){Path.GetExtension(name)}");
                e.Handled = true;   // 禁用 WebView2 默认下载对话框
                e.ResultFilePath = path;
                e.DownloadOperation.StateChanged += (_, _) =>
                {
                    if (e.DownloadOperation.State == CoreWebView2DownloadState.Completed)
                    {
                        try
                        {
                            Process.Start(new ProcessStartInfo(e.DownloadOperation.ResultFilePath) { UseShellExecute = true });
                        }
                        catch { /* 无默认程序打开时忽略 */ }
                    }
                };
            }
            catch { /* 处理失败时回退 WebView2 默认下载行为 */ }
        };

        // 弹窗策略：
        // - http(s) 外部链接 → 系统默认浏览器
        // - http(s) 同源（127.0.0.1/localhost）→ 新建轻量壳窗口（保留会话，避免主窗口被导航走）
        // - blob: / data: / about: 等 → WebView2 默认行为（插件生成的预览等）
        web.CoreWebView2.NewWindowRequested += async (_, e) =>
        {
            DebugLog($"NewWindowRequested uri={e.Uri}");
            if (!Uri.TryCreate(e.Uri, UriKind.Absolute, out var uri)
                || uri.Scheme is not ("http" or "https"))
                return;

            if (uri.Host is not ("127.0.0.1" or "localhost"))
            {
                e.Handled = true;
                try { Process.Start(new ProcessStartInfo(e.Uri) { UseShellExecute = true }); } catch { }
                return;
            }

            var deferral = e.GetDeferral();
            try
            {
                var popup = CreatePopupForm();
                await InitWebViewAsync(popup.Web, userDataFolder);
                popup.Web.CoreWebView2.DocumentTitleChanged += (_, _) =>
                {
                    var title = popup.Web.CoreWebView2.DocumentTitle;
                    if (!string.IsNullOrWhiteSpace(title)) popup.Form.Text = title;
                };
                e.NewWindow = popup.Web.CoreWebView2;
                popup.Form.Show();
            }
            finally { deferral.Complete(); }
        };

        // 渲染进程崩溃/无响应：自动重载避免白屏（每 10 秒最多一次，防止崩溃死循环）
        web.CoreWebView2.ProcessFailed += (_, e) =>
        {
            if (e.ProcessFailedKind is CoreWebView2ProcessFailedKind.RenderProcessExited
                or CoreWebView2ProcessFailedKind.RenderProcessUnresponsive)
            {
                var now = Environment.TickCount64;
                if (now - _lastReloadTick > 10_000)
                {
                    _lastReloadTick = now;
                    try { web.CoreWebView2.Reload(); } catch { }
                }
            }
        };
    }

    /// 插件内部弹窗用的轻量窗口（与主窗口共享 WebView2 用户数据，保持登录态/会话）。
    private static (Form Form, WebView2 Web) CreatePopupForm()
    {
        DebugLog("CreatePopupForm called");
        var popupWeb = new WebView2 { Dock = DockStyle.Fill };
        var form = new Form
        {
            Text = "DeepSeek Harness",
            ClientSize = new Size(900, 640),
            StartPosition = FormStartPosition.CenterParent,
            Icon = SystemIcons.Application
        };
        form.Controls.Add(popupWeb);
        form.FormClosing += (_, _) =>
        {
            try { popupWeb.Dispose(); } catch { /* ignore */ }
        };
        return (form, popupWeb);
    }

    private static Icon? LoadEmbeddedIcon()
    {
        try
        {
            var name = Assembly.GetExecutingAssembly().GetManifestResourceNames()
                .FirstOrDefault(n => n.EndsWith("favicon.png", StringComparison.OrdinalIgnoreCase));
            if (name is null) return null;
            using var stream = Assembly.GetExecutingAssembly().GetManifestResourceStream(name);
            if (stream is null) return null;
            using var bmp = new Bitmap(stream);
            return Icon.FromHandle(bmp.GetHicon());
        }
        catch
        {
            return null;
        }
    }

    /// <summary>
    /// 从 Content-Disposition / 下载 URI / MIME 推导建议文件名。
    /// （当前 SDK 版本没有 SuggestedFileName API，只能自行推导。）
    /// </summary>
    private static string SuggestDownloadName(string? disposition, string? downloadUri, string? mimeType)
    {
        string? name = null;
        if (!string.IsNullOrWhiteSpace(disposition))
        {
            var m = Regex.Match(disposition, @"filename\*?=(?:UTF-8'')?[""']?(?<name>[^""';]+)");
            if (m.Success && !string.IsNullOrWhiteSpace(m.Groups["name"].Value))
                name = m.Groups["name"].Value.Trim();
        }
        if (string.IsNullOrWhiteSpace(name) && !string.IsNullOrWhiteSpace(downloadUri)
            && Uri.TryCreate(downloadUri, UriKind.Absolute, out var uri))
        {
            var segment = Path.GetFileName(uri.AbsolutePath);
            if (!string.IsNullOrWhiteSpace(segment))
                name = segment;
        }
        name = string.IsNullOrWhiteSpace(name)
            ? $"dsh-{DateTime.Now:yyyyMMddHHmmss}"
            : Uri.UnescapeDataString(name);

        // blob: 等无扩展名下载：按 MIME 类型补一个扩展名，便于识别
        if (!Path.HasExtension(name) && !string.IsNullOrWhiteSpace(mimeType))
        {
            var ext = MimeToExtension(mimeType);
            if (ext is not null) name += ext;
        }
        return name;
    }

    private static string? MimeToExtension(string mime)
    {
        var map = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase)
        {
            ["text/plain"] = ".txt",
            ["text/markdown"] = ".md",
            ["text/html"] = ".html",
            ["text/csv"] = ".csv",
            ["application/json"] = ".json",
            ["application/pdf"] = ".pdf",
            ["application/zip"] = ".zip",
            ["application/x-zip-compressed"] = ".zip",
            ["application/gzip"] = ".gz",
            ["application/x-tar"] = ".tar",
            ["image/png"] = ".png",
            ["image/jpeg"] = ".jpg",
            ["image/gif"] = ".gif",
            ["image/webp"] = ".webp",
            ["image/svg+xml"] = ".svg",
            ["audio/mpeg"] = ".mp3",
            ["audio/wav"] = ".wav",
            ["video/mp4"] = ".mp4",
        };
        return map.TryGetValue(mime.Split(';')[0].Trim(), out var ext) ? ext : null;
    }

    /// 清理文件名中的非法字符，避免拼接路径时报错。
    private static string SanitizeFileName(string name)
    {
        var invalid = Path.GetInvalidFileNameChars();
        var sb = new StringBuilder(name.Length);
        foreach (var c in name)
            sb.Append(invalid.Contains(c) ? '_' : c);
        var result = sb.ToString().Trim();
        return result.Length == 0 ? $"dsh-{DateTime.Now:yyyyMMddHHmmss}" : result;
    }

    private static bool PortOpen()
    {
        try
        {
            using var c = new TcpClient();
            c.Connect("127.0.0.1", Port);
            return true;
        }
        catch
        {
            return false;
        }
    }
}
