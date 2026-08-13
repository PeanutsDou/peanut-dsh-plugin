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
    private const int WM_NCHITTEST = 0x84;
    private const int WM_NCLBUTTONDOWN = 0xA1;
    private const int WM_GETMINMAXINFO = 0x24;
    private const int HTCAPTION = 2;

    /// 渲染进程崩溃自动重载的节流时间戳（避免崩溃死循环）。
    private static long _lastReloadTick;

    // 标题栏配色 —— 取自 DSH 设计 token（@deepseek-ai/dsh-client-ui-theme / design-platform.css）
    private static readonly Color ThemeLightBg = Color.FromArgb(255, 255, 255);     // neutral-bluish-00
    private static readonly Color ThemeDarkBg = Color.FromArgb(21, 21, 23);         // neutral-bluish-950
    private static readonly Color ThemeLightText = Color.FromArgb(60, 60, 61);      // neutral-700
    private static readonly Color ThemeDarkText = Color.FromArgb(235, 238, 242);    // neutral-bluish-100
    private static readonly Color ThemeLightGlyph = Color.FromArgb(84, 85, 87);     // neutral-600
    private static readonly Color ThemeDarkGlyph = Color.FromArgb(207, 211, 214);   // neutral-bluish-300
    private static readonly Color ThemeLightHover = Color.FromArgb(242, 242, 242);
    private static readonly Color ThemeDarkHover = Color.FromArgb(53, 54, 56);      // neutral-bluish-800
    private static readonly Color ThemeCloseHover = Color.FromArgb(232, 17, 35);    // #E81123
    private static readonly Color ThemeLightBorder = Color.FromArgb(237, 237, 237); // neutral-150
    private static readonly Color ThemeDarkBorder = Color.FromArgb(44, 44, 46);     // neutral-bluish-850

    [DllImport("user32.dll")]
    private static extern bool ReleaseCapture();

    [DllImport("user32.dll")]
    private static extern IntPtr SendMessage(IntPtr hWnd, int msg, IntPtr wParam, IntPtr lParam);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern IntPtr FindWindow(string? lpClassName, string? lpWindowName);

    [DllImport("user32.dll")]
    private static extern bool SetForegroundWindow(IntPtr hWnd);

    [DllImport("user32.dll")]
    private static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);

    [STAThread]
    private static void Main()
    {
        // PerMonitorV2：按真实屏幕 DPI 渲染。否则进程 DPI 不感知，Windows 会把 100% 画面
        // 位图拉伸到 125%+，整个 Web UI 看起来发糊。必须最先调用、早于任何窗口创建。
        Application.SetHighDpiMode(HighDpiMode.PerMonitorV2);

        // 单实例：重复启动只把已开窗口带到前台，避免多开 WebView2 进程白白占用内存
        using var mutex = new Mutex(true, @"Local\DshWeb.SingleInstance", out var firstInstance);
        if (!firstInstance)
        {
            var existing = FindWindow(null, "DeepSeek Harness");
            if (existing != IntPtr.Zero)
            {
                ShowWindow(existing, SW_RESTORE);
                SetForegroundWindow(existing);
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

        Icon? icon = null;
        try { icon = Icon.ExtractAssociatedIcon(Application.ExecutablePath); } catch { /* ignore */ }

        var isDark = DetectDarkTheme();
        var form = new AppForm
        {
            Text = "DeepSeek Harness",
            ClientSize = new Size(1280, 840),
            StartPosition = FormStartPosition.CenterScreen,
            MinimumSize = new Size(800, 600),
            WindowState = FormWindowState.Maximized,
            Icon = icon ?? SystemIcons.Application,
            FormBorderStyle = FormBorderStyle.None,
            BackColor = isDark ? ThemeDarkBg : ThemeLightBg
        };

        var web = new WebView2 { Dock = DockStyle.Fill };
        form.Controls.Add(web);
        form.Controls.Add(BuildTitleBar(form, icon, isDark));
        form.FormClosing += (_, _) =>
        {
            try { web.Dispose(); } catch { /* ignore */ }
            icon?.Dispose();
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
        };

        Application.Run(form);
    }

    /// <summary>无边框主窗体：普通状态支持边缘拖拽调整大小；最大化时限制在屏幕工作区（不盖任务栏）。</summary>
    private sealed class AppForm : Form
    {
        protected override void WndProc(ref Message m)
        {
            if (m.Msg == WM_GETMINMAXINFO)
            {
                var mmi = (MINMAXINFO)Marshal.PtrToStructure(m.LParam, typeof(MINMAXINFO))!;
                var wa = Screen.FromHandle(Handle).WorkingArea;
                mmi.ptMaxPosition.x = wa.Left;
                mmi.ptMaxPosition.y = wa.Top;
                mmi.ptMaxSize.x = wa.Width;
                mmi.ptMaxSize.y = wa.Height;
                Marshal.StructureToPtr(mmi, m.LParam, false);
                m.Result = IntPtr.Zero;
                return;
            }

            base.WndProc(ref m);

            if (m.Msg == WM_NCHITTEST && WindowState == FormWindowState.Normal)
            {
                var lp = m.LParam.ToInt64();
                var x = (short)(lp & 0xFFFF);
                var y = (short)((lp >> 16) & 0xFFFF);
                var pt = PointToClient(new Point(x, y));
                var size = ClientSize;
                const int pad = 6;
                var left = pt.X <= pad;
                var right = pt.X >= size.Width - pad;
                var top = pt.Y <= pad;
                var bottom = pt.Y >= size.Height - pad;
                if (left && top) m.Result = (IntPtr)13;          // HTTOPLEFT
                else if (right && top) m.Result = (IntPtr)14;    // HTTOPRIGHT
                else if (left && bottom) m.Result = (IntPtr)16;  // HTBOTTOMLEFT
                else if (right && bottom) m.Result = (IntPtr)17; // HTBOTTOMRIGHT
                else if (left) m.Result = (IntPtr)10;            // HTLEFT
                else if (right) m.Result = (IntPtr)11;           // HTRIGHT
                else if (top) m.Result = (IntPtr)12;             // HTTOP
                else if (bottom) m.Result = (IntPtr)15;          // HTBOTTOM
            }
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct POINT { public int x; public int y; }

        [StructLayout(LayoutKind.Sequential)]
        private struct MINMAXINFO
        {
            public POINT ptReserved;
            public POINT ptMaxSize;
            public POINT ptMaxPosition;
            public POINT ptMinTrackSize;
            public POINT ptMaxTrackSize;
        }
    }

    /// <summary>从 $DSH_HOME/settings.yaml 读取 ui-theme 偏好；读不到时按亮色处理。</summary>
    private static bool DetectDarkTheme()
    {
        try
        {
            var home = Environment.GetEnvironmentVariable("DSH_HOME");
            if (string.IsNullOrWhiteSpace(home))
                home = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), ".dsh");
            var path = Path.Combine(home, "settings.yaml");
            if (!File.Exists(path)) return false;
            var m = Regex.Match(File.ReadAllText(path), @"preference:\s*(light|dark)");
            return m.Success && m.Groups[1].Value == "dark";
        }
        catch { return false; }
    }

    /// <summary>构建与 DSH Web UI 同色系的自定义标题栏（供无边框窗口使用）。</summary>
    private static Panel BuildTitleBar(AppForm form, Icon? icon, bool isDark)
    {
        var bg = isDark ? ThemeDarkBg : ThemeLightBg;
        var text = isDark ? ThemeDarkText : ThemeLightText;
        var glyph = isDark ? ThemeDarkGlyph : ThemeLightGlyph;
        var hover = isDark ? ThemeDarkHover : ThemeLightHover;
        var border = isDark ? ThemeDarkBorder : ThemeLightBorder;

        var bar = new Panel { Dock = DockStyle.Top, Height = 36, BackColor = bg };

        // 底部 1px 分隔线（与 DSH border token 同色）
        bar.Paint += (_, e) =>
        {
            using var pen = new Pen(border);
            e.Graphics.DrawLine(pen, 0, bar.Height - 1, bar.Width - 1, bar.Height - 1);
        };

        // 标题栏拖动（最大化时不拖，避免误触还原）
        void DragStart(object? s, MouseEventArgs e)
        {
            if (e.Button != MouseButtons.Left || form.WindowState == FormWindowState.Maximized) return;
            ReleaseCapture();
            SendMessage(form.Handle, WM_NCLBUTTONDOWN, (IntPtr)HTCAPTION, IntPtr.Zero);
        }
        void ToggleOnDouble(object? s, EventArgs e)
        {
            form.WindowState = form.WindowState == FormWindowState.Maximized
                ? FormWindowState.Normal : FormWindowState.Maximized;
        }

        var titleLabel = new Label
        {
            Text = "DeepSeek Harness",
            AutoSize = false,
            Location = new Point(34, 0),
            Size = new Size(280, 36),
            TextAlign = ContentAlignment.MiddleLeft,
            ForeColor = text,
            BackColor = bg,
            Font = new Font("Segoe UI", 9f, FontStyle.Regular)
        };
        titleLabel.MouseDown += DragStart;
        titleLabel.DoubleClick += ToggleOnDouble;
        bar.Controls.Add(titleLabel);

        var minBtn = MakeTitleButton("─", bg, glyph, hover, () => form.WindowState = FormWindowState.Minimized);
        var maxBtn = MakeTitleButton("□", bg, glyph, hover, () =>
            form.WindowState = form.WindowState == FormWindowState.Maximized
                ? FormWindowState.Normal : FormWindowState.Maximized);
        var closeBtn = MakeTitleButton("✕", bg, glyph, ThemeCloseHover, () => form.Close());
        closeBtn.MouseEnter += (_, _) => closeBtn.ForeColor = Color.White;
        closeBtn.MouseLeave += (_, _) => closeBtn.ForeColor = glyph;
        bar.Controls.Add(closeBtn);
        bar.Controls.Add(maxBtn);
        bar.Controls.Add(minBtn);

        bar.Resize += (_, _) =>
        {
            closeBtn.Location = new Point(bar.Width - 46, 0);
            maxBtn.Location = new Point(bar.Width - 92, 0);
            minBtn.Location = new Point(bar.Width - 138, 0);
            titleLabel.Size = new Size(Math.Max(120, bar.Width - 138 - 34), 36);
        };

        // 最大化/还原时切换按钮字形（□ / ❐）
        form.Resize += (_, _) =>
            maxBtn.Text = form.WindowState == FormWindowState.Maximized ? "❐" : "□";

        if (icon is not null)
        {
            var iconBox = new PictureBox
            {
                Image = icon.ToBitmap(),
                SizeMode = PictureBoxSizeMode.Zoom,
                Location = new Point(10, 9),
                Size = new Size(18, 18),
                BackColor = bg,
                TabStop = false
            };
            iconBox.MouseDown += DragStart;
            iconBox.DoubleClick += ToggleOnDouble;
            bar.Controls.Add(iconBox);
        }

        bar.MouseDown += DragStart;
        bar.DoubleClick += ToggleOnDouble;
        return bar;
    }

    /// <summary>标题栏窗口控制按钮（扁平样式，46×36）。</summary>
    private static Button MakeTitleButton(string glyph, Color bg, Color fg, Color hover, Action onClick)
    {
        var b = new Button
        {
            Text = glyph,
            FlatStyle = FlatStyle.Flat,
            Size = new Size(46, 36),
            Font = new Font("Segoe UI", 10f),
            ForeColor = fg,
            BackColor = bg,
            UseVisualStyleBackColor = false,
            Cursor = Cursors.Hand,
            TabStop = false,
            Margin = Padding.Empty,
            Padding = Padding.Empty
        };
        b.FlatAppearance.BorderSize = 0;
        b.FlatAppearance.MouseOverBackColor = hover;
        b.FlatAppearance.MouseDownBackColor = hover;
        b.Click += (_, _) => onClick();
        return b;
    }

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
        // - Notifications：桌面通知插件（dsh-notification 等）
        // - ClipboardRead：复制/粘贴（此 SDK 版本剪贴板读写的唯一权限项）
        // - Autoplay：声音类插件（打字音效、自定义提示音）无手势时也能播放
        // - MultipleAutomaticDownloads：多文件导出插件不被拦截
        // - PersistentStorage：插件 IndexedDB/localStorage 免于被驱逐
        // 麦克风/摄像头保持默认拒绝（隐私），将来有语音类插件再改为弹窗询问。
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
