# human-input-driver.ps1
# Resident driver: reads one JSON command per line from stdin, drives mouse/keyboard,
# writes one JSON result per line to stdout.
#
# Why resident: spawning PowerShell + Add-Type costs ~700ms per call.
# Why Win32: injection goes through the real system input path, so foreground apps
# receive genuine mouse/keyboard events.
#
# Commands (one JSON per line):
#   {"op":"pos"}                                 -> cursor position
#   {"op":"screen"}                              -> primary screen size
#   {"op":"move","x":100,"y":200,"ms":350}       -> human-like smooth move
#   {"op":"rmove","dx":20,"dy":-10,"ms":300}     -> relative move
#   {"op":"click","button":"left","count":1}     -> click / double click
#   {"op":"down","button":"left"}                -> press and hold
#   {"op":"up","button":"left"}                  -> release
#   {"op":"drag","from":[x1,y1],"to":[x2,y2],"ms":600}
#   {"op":"scroll","clicks":3}                   -> positive scrolls down
#   {"op":"key","combo":"ctrl+c"}                -> key combination
#   {"op":"type","text":"hello","delay":35}      -> per-character typing
#   {"op":"windows"}                             -> enumerate visible windows
#   {"op":"active"}                              -> foreground window
#   {"op":"focus","hwnd":123456}                 -> bring to foreground
#   {"op":"capture","path":"C:\\tmp\\shot.png","x":0,"y":0,"w":1920,"h":1080,"scale":1}
#                                                 -> grab screen region to a PNG file
#   {"op":"wait","ms":300}
#   {"op":"quit"}

param()

$ErrorActionPreference = 'Stop'
try {
  [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
} catch {
  [Console]::OutputEncoding = [System.Text.Encoding]::UTF8
}
# stdin 必须也按 UTF-8 解码，否则中文指令会被系统的 GBK 解码成乱码，JSON.parse 失败
try {
  $utf8 = [System.Text.UTF8Encoding]::new($false)
  [Console]::InputEncoding = $utf8
  $script:stdinReader = [System.IO.StreamReader]::new([Console]::OpenStandardInput(), $utf8, $false)
} catch {
  $script:stdinReader = $null
}

Add-Type -ReferencedAssemblies System.Drawing -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Text;
using System.Threading;
using System.Runtime.InteropServices;

public static class HumanInput
{
    [DllImport("user32.dll", SetLastError = true)] public static extern bool SetCursorPos(int X, int Y);
    [DllImport("user32.dll", SetLastError = true)] public static extern bool GetCursorPos(out POINT p);
    [DllImport("user32.dll")] public static extern void mouse_event(uint f, int dx, int dy, uint d, IntPtr e);
    [DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint flags, IntPtr extra);
    [DllImport("user32.dll")] public static extern short GetAsyncKeyState(int vk);
    [DllImport("user32.dll")] public static extern int GetSystemMetrics(int i);
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowTextLengthW(IntPtr h);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
    [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr p);
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
    [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
    [DllImport("user32.dll", SetLastError = true)] public static extern uint SendInput(uint n, INPUT[] p, int cb);

    public delegate bool EnumProc(IntPtr h, IntPtr p);

    [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X; public int Y; }
    [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
    [StructLayout(LayoutKind.Sequential)] public struct KEYBDINPUT { public ushort wVk; public ushort wScan; public uint dwFlags; public uint time; public IntPtr dwExtra; }
    [StructLayout(LayoutKind.Sequential)] public struct MOUSEINPUT { public int dx; public int dy; public uint mouseData; public uint dwFlags; public uint time; public IntPtr dwExtra; }
    [StructLayout(LayoutKind.Sequential)] public struct HARDWAREINPUT { public uint uMsg; public ushort wParamL; public ushort wParamH; }
    [StructLayout(LayoutKind.Explicit)] public struct INPUTUNION { [FieldOffset(0)] public MOUSEINPUT mi; [FieldOffset(0)] public KEYBDINPUT ki; [FieldOffset(0)] public HARDWAREINPUT hi; }
    [StructLayout(LayoutKind.Sequential)] public struct INPUT { public uint type; public INPUTUNION u; }

    const uint LEFTDOWN = 0x0002;
    const uint LEFTUP = 0x0004;
    const uint RIGHTDOWN = 0x0008;
    const uint RIGHTUP = 0x0010;
    const uint MIDDLEDOWN = 0x0020;
    const uint MIDDLEUP = 0x0040;
    const uint WHEEL = 0x0800;
    const uint KEYUP = 0x0002;
    const uint UNICODE = 0x0004;

    static Random R = new Random();
    static bool escSeen = false;

    public static void ResetEsc() { escSeen = false; }

    public static bool Esc()
    {
        if (escSeen) { return true; }
        if ((GetAsyncKeyState(0x1B) & 0x8000) != 0) { escSeen = true; return true; }
        return false;
    }

    public static int CX = 0;
    public static int CY = 0;

    public static void Read()
    {
        POINT p;
        GetCursorPos(out p);
        CX = p.X;
        CY = p.Y;
    }

    // Human-like trajectory: quadratic bezier bow + easeOutCubic + decaying jitter
    // + a tiny overshoot before settling on the target.
    public static System.Collections.Generic.List<string> LastTrace = new System.Collections.Generic.List<string>();
    public static bool TraceEnabled = false;

    public static string MoveTo(int tx, int ty, int totalMs)
    {
        if (TraceEnabled) LastTrace.Clear();
        Read();
        int sx = CX;
        int sy = CY;
        double dx = (double)(tx - sx);
        double dy = (double)(ty - sy);
        double dist = Math.Sqrt(dx * dx + dy * dy);

        if (dist < 1.5)
        {
            SetCursorPos(tx, ty);
            Read();
            return CX + "," + CY;
        }
        if (totalMs < 40) { totalMs = 40; }

        // 步数按距离自适应，且不低于 12：保证小距离也看得见"挪"的过程
        int steps = (int)Math.Max(12.0, Math.Min(180.0, dist / 4.0));
        int stepMs = Math.Max(1, totalMs / steps);

        // 曲率：距离越短弧度越小，避免小移动也画大弧
        double bow = (R.NextDouble() - 0.5) * Math.Min(60.0, dist * 0.14);
        double ux = dx / dist;
        double uy = dy / dist;
        double cx = (sx + tx) / 2.0 + (-uy) * bow;
        double cy = (sy + ty) / 2.0 + (ux) * bow;

        for (int i = 1; i <= steps; i++)
        {
            if (Esc()) { return "ESC"; }

            double t = (double)i / (double)steps;
            // easeInOutCubic：起步和收尾都慢，中段快 —— 比纯 easeOut 更像真人
            double e = t < 0.5
                ? 4.0 * t * t * t
                : 1.0 - Math.Pow(-2.0 * t + 2.0, 3.0) / 2.0;

            double x = (1.0 - e) * (1.0 - e) * sx + 2.0 * (1.0 - e) * e * cx + e * e * tx;
            double y = (1.0 - e) * (1.0 - e) * sy + 2.0 * (1.0 - e) * e * cy + e * e * ty;

            // 抖动：中段最大，两端接近 0（手在起步和落点时最稳）
            double bell = Math.Sin(Math.PI * t);
            double jit = bell * 0.9;
            int px = (int)Math.Round(x + (R.NextDouble() - 0.5) * jit);
            int py = (int)Math.Round(y + (R.NextDouble() - 0.5) * jit);

            SetCursorPos(px, py);
            if (TraceEnabled && LastTrace.Count < 400) {
                POINT got; GetCursorPos(out got);
                LastTrace.Add((i * 1000 / steps) + "|" + got.X + "," + got.Y);
            }
            if (stepMs > 1) { Thread.Sleep(stepMs); }
        }

        // 落点微调：先小过冲再回正，模拟指尖落定
        if (dist > 90.0)
        {
            int ox = tx + (int)Math.Round((R.NextDouble() - 0.5) * 3.0);
            int oy = ty + (int)Math.Round((R.NextDouble() - 0.5) * 3.0);
            SetCursorPos(ox, oy);
            Thread.Sleep(14);
        }

        SetCursorPos(tx, ty);
        Read();
        return CX + "," + CY;
    }

    public static string GetTrace()
    {
        return string.Join(";", LastTrace);
    }

    public static void Click(string btn, int count)
    {
        uint d = LEFTDOWN;
        uint u = LEFTUP;
        if (btn == "right") { d = RIGHTDOWN; u = RIGHTUP; }
        else if (btn == "middle") { d = MIDDLEDOWN; u = MIDDLEUP; }

        for (int i = 0; i < count; i++)
        {
            mouse_event(d, 0, 0, 0, IntPtr.Zero);
            Thread.Sleep(35 + R.Next(0, 30));
            mouse_event(u, 0, 0, 0, IntPtr.Zero);
            if (i < count - 1) { Thread.Sleep(85); }
        }
    }

    public static void Down(string btn)
    {
        mouse_event(btn == "right" ? RIGHTDOWN : LEFTDOWN, 0, 0, 0, IntPtr.Zero);
    }

    public static void Up(string btn)
    {
        mouse_event(btn == "right" ? RIGHTUP : LEFTUP, 0, 0, 0, IntPtr.Zero);
    }

    public static void Scroll(int clicks)
    {
        int step = clicks > 0 ? 120 : -120;
        int n = Math.Abs(clicks);
        for (int i = 0; i < n; i++)
        {
            mouse_event(WHEEL, 0, 0, (uint)step, IntPtr.Zero);
            Thread.Sleep(55 + R.Next(0, 45));
        }
    }

    static Dictionary<string, byte> VK = BuildVk();

    static Dictionary<string, byte> BuildVk()
    {
        Dictionary<string, byte> d = new Dictionary<string, byte>(StringComparer.OrdinalIgnoreCase);
        d.Add("backspace", 0x08); d.Add("tab", 0x09); d.Add("enter", 0x0D); d.Add("return", 0x0D);
        d.Add("shift", 0x10); d.Add("ctrl", 0x11); d.Add("control", 0x11); d.Add("alt", 0x12);
        d.Add("capslock", 0x14); d.Add("esc", 0x1B); d.Add("escape", 0x1B); d.Add("space", 0x20);
        d.Add("pageup", 0x21); d.Add("pagedown", 0x22); d.Add("end", 0x23); d.Add("home", 0x24);
        d.Add("left", 0x25); d.Add("up", 0x26); d.Add("right", 0x27); d.Add("down", 0x28);
        d.Add("insert", 0x2D); d.Add("delete", 0x2E); d.Add("del", 0x2E);
        d.Add("0", 0x30); d.Add("1", 0x31); d.Add("2", 0x32); d.Add("3", 0x33); d.Add("4", 0x34);
        d.Add("5", 0x35); d.Add("6", 0x36); d.Add("7", 0x37); d.Add("8", 0x38); d.Add("9", 0x39);
        d.Add("a", 0x41); d.Add("b", 0x42); d.Add("c", 0x43); d.Add("d", 0x44); d.Add("e", 0x45);
        d.Add("f", 0x46); d.Add("g", 0x47); d.Add("h", 0x48); d.Add("i", 0x49); d.Add("j", 0x4A);
        d.Add("k", 0x4B); d.Add("l", 0x4C); d.Add("m", 0x4D); d.Add("n", 0x4E); d.Add("o", 0x4F);
        d.Add("p", 0x50); d.Add("q", 0x51); d.Add("r", 0x52); d.Add("s", 0x53); d.Add("t", 0x54);
        d.Add("u", 0x55); d.Add("v", 0x56); d.Add("w", 0x57); d.Add("x", 0x58); d.Add("y", 0x59);
        d.Add("z", 0x5A); d.Add("win", 0x5B); d.Add("lwin", 0x5B); d.Add("rwin", 0x5C);
        d.Add("f1", 0x70); d.Add("f2", 0x71); d.Add("f3", 0x72); d.Add("f4", 0x73);
        d.Add("f5", 0x74); d.Add("f6", 0x75); d.Add("f7", 0x76); d.Add("f8", 0x77);
        d.Add("f9", 0x78); d.Add("f10", 0x79); d.Add("f11", 0x7A); d.Add("f12", 0x7B);
        d.Add(";", 0xBA); d.Add("=", 0xBB); d.Add(",", 0xBC); d.Add("-", 0xBD); d.Add(".", 0xBE);
        d.Add("/", 0xBF); d.Add("`", 0xC0); d.Add("[", 0xDB); d.Add("\\", 0xDC); d.Add("]", 0xDD);
        d.Add("'", 0xDE);
        return d;
    }

    public static bool Key(string combo)
    {
        if (combo == null) { return false; }
        string[] parts = combo.Split('+');
        List<byte> held = new List<byte>();
        for (int i = 0; i < parts.Length; i++)
        {
            string k = parts[i].Trim();
            if (k.Length == 0) { continue; }
            byte vk;
            if (!VK.TryGetValue(k, out vk)) { return false; }
            keybd_event(vk, 0, 0, IntPtr.Zero);
            held.Add(vk);
        }
        Thread.Sleep(18);
        for (int i = held.Count - 1; i >= 0; i--)
        {
            keybd_event(held[i], 0, KEYUP, IntPtr.Zero);
        }
        return true;
    }

    static void Uni(char ch)
    {
        INPUT[] a = new INPUT[2];
        a[0].type = 1;
        a[0].u.ki.wVk = 0;
        a[0].u.ki.wScan = (ushort)ch;
        a[0].u.ki.dwFlags = UNICODE;
        a[1].type = 1;
        a[1].u.ki.wVk = 0;
        a[1].u.ki.wScan = (ushort)ch;
        a[1].u.ki.dwFlags = UNICODE | KEYUP;
        SendInput(2, a, Marshal.SizeOf(typeof(INPUT)));
    }

    public static int TypeText(string text, int delayMs)
    {
        if (text == null) { return 0; }
        int n = 0;
        for (int i = 0; i < text.Length; i++)
        {
            if (Esc()) { return n; }
            char ch = text[i];
            if (ch == '\n')
            {
                keybd_event(0x0D, 0, 0, IntPtr.Zero);
                keybd_event(0x0D, 0, KEYUP, IntPtr.Zero);
            }
            else if (ch == '\t')
            {
                keybd_event(0x09, 0, 0, IntPtr.Zero);
                keybd_event(0x09, 0, KEYUP, IntPtr.Zero);
            }
            else
            {
                Uni(ch);
            }
            n++;
            Thread.Sleep(delayMs + R.Next(0, Math.Max(1, delayMs / 2)));
        }
        return n;
    }

    static string J(string s)
    {
        StringBuilder sb = new StringBuilder("\"");
        for (int i = 0; i < s.Length; i++)
        {
            char c = s[i];
            if (c == '"') { sb.Append("\\\""); }
            else if (c == '\\') { sb.Append("\\\\"); }
            else if (c == '\n') { sb.Append("\\n"); }
            else if (c == '\r') { sb.Append("\\r"); }
            else if (c == '\t') { sb.Append("\\t"); }
            else if (c < 32) { sb.Append(' '); }
            else { sb.Append(c); }
        }
        sb.Append("\"");
        return sb.ToString();
    }

    public static string Windows()
    {
        StringBuilder sb = new StringBuilder("[");
        bool first = true;
        EnumWindows(delegate(IntPtr h, IntPtr p)
        {
            if (!IsWindowVisible(h)) { return true; }
            int len = GetWindowTextLengthW(h);
            if (len == 0) { return true; }
            StringBuilder t = new StringBuilder(len + 2);
            GetWindowText(h, t, t.Capacity);
            string title = t.ToString().Trim();
            if (title.Length == 0) { return true; }
            RECT r;
            if (!GetWindowRect(h, out r)) { return true; }
            int w = r.Right - r.Left;
            int hh = r.Bottom - r.Top;
            if (w <= 0 || hh <= 0) { return true; }
            if (!first) { sb.Append(","); }
            first = false;
            sb.Append("{\"title\":").Append(J(title));
            sb.Append(",\"rect\":[").Append(r.Left).Append(",").Append(r.Top).Append(",").Append(w).Append(",").Append(hh).Append("]");
            sb.Append(",\"hwnd\":").Append(h.ToInt64()).Append("}");
            return true;
        }, IntPtr.Zero);
        sb.Append("]");
        return sb.ToString();
    }

    public static string Active()
    {
        IntPtr h = GetForegroundWindow();
        int len = GetWindowTextLengthW(h);        StringBuilder t = new StringBuilder(len + 2);
        GetWindowText(h, t, t.Capacity);
        return "{\"title\":" + J(t.ToString()) + ",\"hwnd\":" + h.ToInt64() + "}";
    }

    public static bool Focus(long hwnd)
    {
        ShowWindow(new IntPtr(hwnd), 9);
        return SetForegroundWindow(new IntPtr(hwnd));
    }

    // ---- 屏幕捕获：把指定矩形存成 PNG ----
    [DllImport("user32.dll")] public static extern IntPtr GetDC(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern int ReleaseDC(IntPtr hWnd, IntPtr hDC);
    [DllImport("gdi32.dll")] public static extern IntPtr CreateCompatibleDC(IntPtr hdc);
    [DllImport("gdi32.dll")] public static extern IntPtr CreateCompatibleBitmap(IntPtr hdc, int w, int h);
    [DllImport("gdi32.dll")] public static extern IntPtr SelectObject(IntPtr hdc, IntPtr obj);
    [DllImport("gdi32.dll")] public static extern bool DeleteObject(IntPtr obj);
    [DllImport("gdi32.dll")] public static extern bool DeleteDC(IntPtr hdc);
    [DllImport("gdi32.dll")] public static extern bool BitBlt(IntPtr dst, int x, int y, int w, int h, IntPtr src, int sx, int sy, uint rop);

    // 放大截取：把 x,y,w,h 区域放大 zoom 倍后保存，便于精确定位小目标
    public static string CaptureScaled(int x, int y, int w, int h, int zoom, string path)
    {
        if (w <= 0 || h <= 0 || zoom <= 0) { return "ERR: invalid size/zoom"; }
        IntPtr screenDc = GetDC(IntPtr.Zero);
        IntPtr memDc = CreateCompatibleDC(screenDc);
        IntPtr bmp = CreateCompatibleBitmap(screenDc, w, h);
        IntPtr old = SelectObject(memDc, bmp);
        try
        {
            bool ok = BitBlt(memDc, 0, 0, w, h, screenDc, x, y, 0x00CC0020);
            if (!ok) { return "ERR: BitBlt failed"; }
            using (System.Drawing.Bitmap raw = System.Drawing.Image.FromHbitmap(bmp))
            using (System.Drawing.Bitmap scaled = new System.Drawing.Bitmap(w * zoom, h * zoom, System.Drawing.Imaging.PixelFormat.Format32bppArgb))
            {
                using (System.Drawing.Graphics g = System.Drawing.Graphics.FromImage(scaled))
                {
                    g.InterpolationMode = System.Drawing.Drawing2D.InterpolationMode.NearestNeighbor;
                    g.PixelOffsetMode = System.Drawing.Drawing2D.PixelOffsetMode.Half;
                    g.DrawImage(raw, 0, 0, w * zoom, h * zoom);
                    using (System.Drawing.Pen pen = new System.Drawing.Pen(System.Drawing.Color.FromArgb(90, 255, 0, 0), 1))
                    {
                        for (int gx = 100; gx < w; gx += 100) g.DrawLine(pen, gx * zoom, 0, gx * zoom, h * zoom);
                        for (int gy = 100; gy < h; gy += 100) g.DrawLine(pen, 0, gy * zoom, w * zoom, gy * zoom);
                    }
                }
                scaled.Save(path, System.Drawing.Imaging.ImageFormat.Png);
            }
            return "OK " + path + " " + w + "x" + h + " zoom=" + zoom;
        }
        finally
        {
            SelectObject(memDc, old);
            DeleteObject(bmp);
            DeleteDC(memDc);
            ReleaseDC(IntPtr.Zero, screenDc);
        }
    }
    // ---- DPI 感知：必须在任何坐标读取之前调用 ----
    [DllImport("user32.dll", SetLastError = true)] public static extern bool SetProcessDpiAwarenessContext(IntPtr value);
    [DllImport("shcore.dll")] public static extern int SetProcessDpiAwareness(int value);
    [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();

    public static string EnableDpiAwareness()
    {
        // PER_MONITOR_AWARE_V2 = -4
        try { if (SetProcessDpiAwarenessContext(new IntPtr(-4))) return "per-monitor-v2"; } catch { }
        try { if (SetProcessDpiAwareness(2) == 0) return "per-monitor"; } catch { }
        try { if (SetProcessDPIAware()) return "system"; } catch { }
        return "none";
    }

    public static string Capture(int x, int y, int w, int h, string path)
    {
        if (w <= 0 || h <= 0) { return "ERR: invalid size"; }
        IntPtr screenDc = GetDC(IntPtr.Zero);
        IntPtr memDc = CreateCompatibleDC(screenDc);
        IntPtr bmp = CreateCompatibleBitmap(screenDc, w, h);
        IntPtr old = SelectObject(memDc, bmp);
        try
        {
            bool ok = BitBlt(memDc, 0, 0, w, h, screenDc, x, y, 0x00CC0020); // SRCCOPY
            if (!ok) { return "ERR: BitBlt failed"; }
            using (System.Drawing.Bitmap image = System.Drawing.Image.FromHbitmap(bmp))
            {
                image.Save(path, System.Drawing.Imaging.ImageFormat.Png);
            }
            return "OK " + path + " " + w + "x" + h;
        }
        finally
        {
            SelectObject(memDc, old);
            DeleteObject(bmp);
            DeleteDC(memDc);
            ReleaseDC(IntPtr.Zero, screenDc);
        }
    }
}
'@

try { Add-Type -AssemblyName System.Drawing } catch { }


function Emit($obj) {
  Write-Output ($obj | ConvertTo-Json -Compress -Depth 8)
}

# 启用 DPI 感知（必须早于任何坐标读取），否则高缩放屏幕上坐标会整体偏移
$dpiMode = [HumanInput]::EnableDpiAwareness()

# Warm up: read once so the desktop handle is validated and the JIT has run.
[HumanInput]::Read()
Emit @{ ok = $true; ready = $true; dpi = $dpiMode; pos = "$([HumanInput]::CX),$([HumanInput]::CY)"; screen = "$([HumanInput]::GetSystemMetrics(0))x$([HumanInput]::GetSystemMetrics(1))" }

while ($true) {
  $line = if ($script:stdinReader) { $script:stdinReader.ReadLine() } else { [Console]::In.ReadLine() }
  if ($null -eq $line) { break }
  $line = $line.Trim()
  if ($line.Length -eq 0) { continue }

  try {
    $req = $line | ConvertFrom-Json
  } catch {
    Emit @{ ok = $false; error = "invalid json" }
    continue
  }

  $op = [string]$req.op
  if ($op -eq "quit") { Emit @{ ok = $true; bye = $true }; break }

  try {
    [HumanInput]::ResetEsc()
    switch ($op) {
      "ping" { Emit @{ ok = $true; pong = $true } }
      "trace" {
        if ($null -ne $req.enabled) { [HumanInput]::TraceEnabled = [bool]$req.enabled }
        Emit @{ ok = $true; result = [HumanInput]::GetTrace() }
      }
      "pos" {
        [HumanInput]::Read()
        Emit @{ ok = $true; result = "$([HumanInput]::CX),$([HumanInput]::CY)" }
      }
      "screen" {
        Emit @{ ok = $true; result = @{ width = [HumanInput]::GetSystemMetrics(0); height = [HumanInput]::GetSystemMetrics(1) } }
      }
      "move" {
        $ms = 350; if ($null -ne $req.ms) { $ms = [int]$req.ms }
        $r = [HumanInput]::MoveTo([int]$req.x, [int]$req.y, $ms)
        if ($r -eq "ESC") { Emit @{ ok = $false; aborted = $true; error = "aborted by ESC" } }
        else { Emit @{ ok = $true; result = $r } }
      }
      "move_by" {
        $ms = 300; if ($null -ne $req.ms) { $ms = [int]$req.ms }
        [HumanInput]::Read()
        $tx = [HumanInput]::CX + [int]$req.dx
        $ty = [HumanInput]::CY + [int]$req.dy
        $r = [HumanInput]::MoveTo($tx, $ty, $ms)
        if ($r -eq "ESC") { Emit @{ ok = $false; aborted = $true; error = "aborted by ESC" } }
        else { Emit @{ ok = $true; result = $r } }
      }      "rmove" {
        $ms = 300; if ($null -ne $req.ms) { $ms = [int]$req.ms }
        [HumanInput]::Read()
        $tx = [HumanInput]::CX + [int]$req.dx
        $ty = [HumanInput]::CY + [int]$req.dy
        $r = [HumanInput]::MoveTo($tx, $ty, $ms)
        if ($r -eq "ESC") { Emit @{ ok = $false; aborted = $true; error = "aborted by ESC" } }
        else { Emit @{ ok = $true; result = $r } }
      }
      "click_at" {
        $ms = 320; if ($null -ne $req.ms) { $ms = [int]$req.ms }
        $btn = "left"; if ($null -ne $req.button) { $btn = [string]$req.button }
        $cnt = 1; if ($null -ne $req.count) { $cnt = [int]$req.count }
        $r = [HumanInput]::MoveTo([int]$req.x, [int]$req.y, $ms)
        if ($r -eq "ESC") { Emit @{ ok = $false; aborted = $true; error = "aborted by ESC" } }
        else {
          Start-Sleep -Milliseconds 90
          [HumanInput]::Click($btn, $cnt)
          Emit @{ ok = $true; result = "clicked $btn x$cnt at $r" }
        }
      }      "click" {
        $btn = "left"; if ($null -ne $req.button) { $btn = [string]$req.button }
        $cnt = 1; if ($null -ne $req.count) { $cnt = [int]$req.count }
        [HumanInput]::Click($btn, $cnt)
        Emit @{ ok = $true; result = "$btn x$cnt" }
      }
      "down" {
        $btn = "left"; if ($null -ne $req.button) { $btn = [string]$req.button }
        [HumanInput]::Down($btn)
        Emit @{ ok = $true; result = "down $btn" }
      }
      "up" {
        $btn = "left"; if ($null -ne $req.button) { $btn = [string]$req.button }
        [HumanInput]::Up($btn)
        Emit @{ ok = $true; result = "up $btn" }
      }
      "drag" {
        $ms = 600; if ($null -ne $req.ms) { $ms = [int]$req.ms }
        $fx = [int]$req.from[0]; $fy = [int]$req.from[1]
        $tx = [int]$req.to[0]; $ty = [int]$req.to[1]
        [HumanInput]::MoveTo($fx, $fy, 250) | Out-Null
        Start-Sleep -Milliseconds 70
        [HumanInput]::Down("left")
        Start-Sleep -Milliseconds 80
        $r = [HumanInput]::MoveTo($tx, $ty, $ms)
        Start-Sleep -Milliseconds 80
        [HumanInput]::Up("left")
        if ($r -eq "ESC") { Emit @{ ok = $false; aborted = $true; error = "aborted by ESC" } }
        else { Emit @{ ok = $true; result = "dragged to $r" } }
      }
      "scroll" {
        $clicks = 3; if ($null -ne $req.clicks) { $clicks = [int]$req.clicks }
        [HumanInput]::Scroll($clicks)
        Emit @{ ok = $true; result = "scrolled $clicks" }
      }
      "key" {
        $ok = [HumanInput]::Key([string]$req.combo)
        if ($ok) { Emit @{ ok = $true; result = "key $($req.combo)" } }
        else { Emit @{ ok = $false; error = "unsupported key combo: $($req.combo)" } }
      }
      "type" {
        $delay = 35; if ($null -ne $req.delay) { $delay = [int]$req.delay }
        $n = [HumanInput]::TypeText([string]$req.text, $delay)
        Emit @{ ok = $true; result = "typed $n chars" }
      }
      "windows" {
        Emit @{ ok = $true; result = [HumanInput]::Windows() }
      }
      "active" {
        Emit @{ ok = $true; result = [HumanInput]::Active() }
      }
      "focus" {
        $ok = [HumanInput]::Focus([long]$req.hwnd)
        Start-Sleep -Milliseconds 140
        Emit @{ ok = $true; result = $ok }
      }
      "capture" {
        Add-Type -AssemblyName System.Drawing
        $path = [string]$req.path
        if ([string]::IsNullOrWhiteSpace($path)) { Emit @{ ok = $false; error = "capture 需要 path" } }
        else {
          $x = 0; if ($null -ne $req.x) { $x = [int]$req.x }
          $y = 0; if ($null -ne $req.y) { $y = [int]$req.y }
          $w = [HumanInput]::GetSystemMetrics(0); if ($null -ne $req.w) { $w = [int]$req.w }
          $h = [HumanInput]::GetSystemMetrics(1); if ($null -ne $req.h) { $h = [int]$req.h }
          $dir = Split-Path -Parent $path
          if ($dir -and -not (Test-Path $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
          $zoom = 1; if ($null -ne $req.zoom) { $zoom = [int]$req.zoom }
          if ($zoom -gt 1) { $r = [HumanInput]::CaptureScaled($x, $y, $w, $h, $zoom, $path) }
          else { $r = [HumanInput]::Capture($x, $y, $w, $h, $path) }
          if ($r.StartsWith("OK")) { Emit @{ ok = $true; result = @{ path = $path; width = $w; height = $h; zoom = $zoom } } }
          else { Emit @{ ok = $false; error = $r } }
        }
      }
      "wait_window" {
        $pattern = [string]$req.title
        $timeout = 15000; if ($null -ne $req.timeout) { $timeout = [int]$req.timeout }
        $deadline = (Get-Date).AddMilliseconds($timeout)
        $found = $false
        $matched = ""
        while ((Get-Date) -lt $deadline) {
          $wins = [HumanInput]::Windows() | ConvertFrom-Json
          foreach ($w in $wins) {
            if ($w.title -like "*$pattern*") { $found = $true; $matched = $w.title; break }
          }
          if ($found) { break }
          Start-Sleep -Milliseconds 250
        }
        if ($found) { Emit @{ ok = $true; result = @{ matched = $matched; waited = $true } } }
        else { Emit @{ ok = $false; error = "window not found within ${timeout}ms: $pattern" } }
      }
      "wait" {
        $ms = 200; if ($null -ne $req.ms) { $ms = [int]$req.ms }
        Start-Sleep -Milliseconds $ms
        Emit @{ ok = $true; result = "waited $ms" }
      }
      default {
        Emit @{ ok = $false; error = "unknown op: $op" }
      }
    }
  } catch {
    Emit @{ ok = $false; error = ($_.Exception.GetType().Name + ": " + $_.Exception.Message) }
  }
}
