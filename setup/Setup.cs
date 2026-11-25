// Krugmosh Setup: one exe that installs (or removes) everything Krugmosh needs.
//   - the helper (Python scripts) -> %LOCALAPPDATA%\Krugmosh\helper, started hidden with Windows
//   - Python 3 + the two Python packages, and ffmpeg (through winget, only when missing)
//   - the Premiere Pro panel, through Adobe's own plugin installer (same as double-clicking a .ccx)
// The panel (krugmosh.ccx) and the helper files (helper.zip) are embedded resources.
// Command line: Krugmosh-Setup.exe [/install | /uninstall]  (starts that action straight away)
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.IO.Compression;
using System.Management;
using System.Net;
using System.Reflection;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Windows.Forms;

static class Program
{
    [STAThread]
    static void Main(string[] args)
    {
        Application.EnableVisualStyles();
        Application.SetCompatibleTextRenderingDefault(false);
        string auto = null;
        foreach (string a in args)
        {
            string l = a.ToLowerInvariant();
            if (l == "/install" || l == "/uninstall") auto = l.Substring(1);
        }
        Application.Run(new SetupForm(auto));
    }
}

class Installer
{
    public Action<string> Log;
    public Action<string> Status;

    static readonly string Local = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
    static readonly string Roaming = Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData);
    public static readonly string InstallDir = Path.Combine(Local, "Krugmosh", "helper");
    static readonly string HomeDir = Path.Combine(Roaming, "Krugmosh");
    static readonly string HomeFile = Path.Combine(HomeDir, "home.txt");
    static readonly string StartupDir = Environment.GetFolderPath(Environment.SpecialFolder.Startup);
    static readonly string Shortcut = Path.Combine(StartupDir, "Krugmosh helper.lnk");
    static readonly string OldShortcut = Path.Combine(StartupDir, "Datamosh helper.lnk");
    static readonly string OldHome = Path.Combine(Roaming, "Datamosh");
    static readonly string Upia = Path.Combine(
        Environment.GetEnvironmentVariable("CommonProgramFiles") ?? @"C:\Program Files\Common Files",
        @"Adobe\Adobe Desktop Common\RemoteComponents\UPI\UnifiedPluginInstallerAgent\UnifiedPluginInstallerAgent.exe");

    // ---- helpers ---------------------------------------------------------------------

    static byte[] Resource(string name)
    {
        using (Stream s = Assembly.GetExecutingAssembly().GetManifestResourceStream(name))
        {
            if (s == null) throw new InvalidOperationException("This setup file is damaged (missing " + name + ").");
            using (MemoryStream ms = new MemoryStream()) { s.CopyTo(ms); return ms.ToArray(); }
        }
    }

    public static string Version
    {
        get { return Encoding.UTF8.GetString(Resource("version.txt")).Trim(); }
    }

    // spinner/progress-bar noise from winget and pip is not worth logging
    static readonly Regex Noise = new Regex(@"^[\s\-\\|/█▒░\.]*$|^\s*[\d\.]+\s*[KMG]?B\s*/\s*[\d\.]+\s*[KMG]?B\s*$");

    /// <summary>Runs a program without a window; every output line goes to the log. Returns the exit code.</summary>
    int Run(string file, string args, string workDir = null)
    {
        ProcessStartInfo psi = new ProcessStartInfo(file, args);
        psi.UseShellExecute = false;
        psi.CreateNoWindow = true;
        psi.RedirectStandardOutput = true;
        psi.RedirectStandardError = true;
        psi.StandardOutputEncoding = Encoding.UTF8;
        psi.StandardErrorEncoding = Encoding.UTF8;
        if (workDir != null) psi.WorkingDirectory = workDir;
        using (Process p = Process.Start(psi))
        {
            DataReceivedEventHandler h = delegate (object s, DataReceivedEventArgs e)
            {
                if (e.Data == null) return;
                // winget redraws its progress with \r: keep the last non-empty piece
                string[] parts = e.Data.Split('\r');
                string line = parts[parts.Length - 1].Trim();
                if (line.Length > 1 && !Noise.IsMatch(line)) Log("    " + line);
            };
            p.OutputDataReceived += h;
            p.ErrorDataReceived += h;
            p.BeginOutputReadLine();
            p.BeginErrorReadLine();
            p.WaitForExit();
            return p.ExitCode;
        }
    }

    /// <summary>Same, but returns the output instead of logging it.</summary>
    static string Capture(string file, string args, out int exit)
    {
        ProcessStartInfo psi = new ProcessStartInfo(file, args);
        psi.UseShellExecute = false;
        psi.CreateNoWindow = true;
        psi.RedirectStandardOutput = true;
        psi.RedirectStandardError = true;
        using (Process p = Process.Start(psi))
        {
            string o = p.StandardOutput.ReadToEnd() + p.StandardError.ReadToEnd();
            if (!p.WaitForExit(30000)) { try { p.Kill(); } catch { } }
            exit = p.HasExited ? p.ExitCode : -1;
            return o;
        }
    }

    /// <summary>Programs installed a moment ago (winget) are not on this process's PATH yet: re-read it.</summary>
    static void RefreshPath()
    {
        string m = Environment.GetEnvironmentVariable("Path", EnvironmentVariableTarget.Machine) ?? "";
        string u = Environment.GetEnvironmentVariable("Path", EnvironmentVariableTarget.User) ?? "";
        Environment.SetEnvironmentVariable("Path", m + ";" + u);
    }

    static string FindOnPath(string exe)
    {
        foreach (string dir in (Environment.GetEnvironmentVariable("Path") ?? "").Split(';'))
        {
            try
            {
                if (dir.Trim().Length == 0) continue;
                string f = Path.Combine(dir.Trim().Trim('"'), exe);
                if (File.Exists(f)) return f;
            }
            catch { }
        }
        return null;
    }

    /// <summary>A working Python 3 (not the Microsoft Store stub). Returns python.exe or null.</summary>
    static string FindPython()
    {
        List<string> candidates = new List<string>();
        foreach (string dir in (Environment.GetEnvironmentVariable("Path") ?? "").Split(';'))
        {
            try { if (dir.Trim().Length > 0) candidates.Add(Path.Combine(dir.Trim().Trim('"'), "python.exe")); } catch { }
        }
        string[] roots = {
            Path.Combine(Local, "Programs", "Python"),
            Environment.GetEnvironmentVariable("ProgramFiles") ?? "",
        };
        foreach (string r in roots)
        {
            try
            {
                if (Directory.Exists(r))
                    foreach (string d in Directory.GetDirectories(r, "Python3*")) candidates.Add(Path.Combine(d, "python.exe"));
            }
            catch { }
        }
        foreach (string c in candidates)
        {
            try
            {
                if (!File.Exists(c) || !File.Exists(Path.Combine(Path.GetDirectoryName(c), "pythonw.exe"))) continue;
                int code;
                string o = Capture(c, "--version", out code);
                if (code == 0 && Regex.IsMatch(o, @"Python 3\.\d+")) return c;
            }
            catch { }
        }
        return null;
    }

    static string FindFfmpeg()
    {
        string f = FindOnPath("ffmpeg.exe");
        if (f != null) return f;
        // winget puts ffmpeg here without needing a new shell (the helper looks here too)
        string wg = Path.Combine(Local, @"Microsoft\WinGet\Packages");
        try
        {
            if (Directory.Exists(wg))
                foreach (string d in Directory.GetDirectories(wg, "Gyan.FFmpeg*"))
                {
                    string[] hit = Directory.GetFiles(d, "ffmpeg.exe", SearchOption.AllDirectories);
                    if (hit.Length > 0) return hit[0];
                }
        }
        catch { }
        return null;
    }

    static bool HasWinget() { return FindOnPath("winget.exe") != null; }

    static bool PremiereRunning()
    {
        return Process.GetProcessesByName("Adobe Premiere Pro").Length > 0;
    }

    /// <summary>Stops any running helper (python running krugmosh_helper.pyw / mosh_server.py).</summary>
    static int StopHelper()
    {
        int n = 0;
        try
        {
            using (ManagementObjectSearcher s = new ManagementObjectSearcher(
                "SELECT ProcessId, CommandLine FROM Win32_Process WHERE Name LIKE 'python%'"))
            foreach (ManagementObject o in s.Get())
            {
                string cl = Convert.ToString(o["CommandLine"]) ?? "";
                if (Regex.IsMatch(cl, @"(krugmosh|datamosh)_helper\.pyw|mosh_server\.py", RegexOptions.IgnoreCase))
                {
                    try { Process.GetProcessById(Convert.ToInt32(o["ProcessId"])).Kill(); n++; } catch { }
                }
            }
        }
        catch { }
        if (n > 0) Thread.Sleep(600);
        return n;
    }

    static void MakeShortcut(string path, string target, string args, string workDir, string description)
    {
        Type t = Type.GetTypeFromProgID("WScript.Shell");
        object shell = Activator.CreateInstance(t);
        object lnk = t.InvokeMember("CreateShortcut", BindingFlags.InvokeMethod, null, shell, new object[] { path });
        Type lt = lnk.GetType();
        lt.InvokeMember("TargetPath", BindingFlags.SetProperty, null, lnk, new object[] { target });
        lt.InvokeMember("Arguments", BindingFlags.SetProperty, null, lnk, new object[] { args });
        lt.InvokeMember("WorkingDirectory", BindingFlags.SetProperty, null, lnk, new object[] { workDir });
        lt.InvokeMember("Description", BindingFlags.SetProperty, null, lnk, new object[] { description });
        lt.InvokeMember("Save", BindingFlags.InvokeMethod, null, lnk, null);
    }

    static void ExtractZip(byte[] zip, string dest)
    {
        using (ZipArchive za = new ZipArchive(new MemoryStream(zip), ZipArchiveMode.Read))
        {
            foreach (ZipArchiveEntry e in za.Entries)
            {
                if (e.FullName.EndsWith("/") || e.FullName.EndsWith("\\")) continue;
                string rel = e.FullName.Replace('/', Path.DirectorySeparatorChar);
                string target = Path.GetFullPath(Path.Combine(dest, rel));
                if (!target.StartsWith(Path.GetFullPath(dest), StringComparison.OrdinalIgnoreCase)) continue;   // no path escapes
                Directory.CreateDirectory(Path.GetDirectoryName(target));
                e.ExtractToFile(target, true);
            }
        }
    }

    static void WriteUtf8(string path, string text)
    {
        Directory.CreateDirectory(Path.GetDirectoryName(path));
        File.WriteAllText(path, text, new UTF8Encoding(false));
    }

    static void DeleteDir(string dir)
    {
        // retry briefly: a just-stopped Python can still hold a file for a moment
        for (int i = 0; i < 5; i++)
        {
            try { if (Directory.Exists(dir)) Directory.Delete(dir, true); return; }
            catch { Thread.Sleep(500); }
        }
    }

    static void RemoveOldNames()
    {
        try { if (File.Exists(OldShortcut)) File.Delete(OldShortcut); } catch { }
        DeleteDir(OldHome);
    }

    // ---- install ---------------------------------------------------------------------

    public bool Install()
    {
        try
        {
            Log("Krugmosh " + Version);
            bool haveUpia = File.Exists(Upia);
            if (!haveUpia)
                Log("Adobe's plugin installer wasn't found (is the Creative Cloud app installed?). The helper will still be set up.");
            if (PremiereRunning())
                Log("Premiere Pro is open. Close it if the panel install below fails.");

            // 1. helper files
            Status("Copying the helper…");
            Log("[1/5] Helper files");
            int stopped = StopHelper();
            if (stopped > 0) Log("    stopped " + stopped + " running helper(s)");
            Directory.CreateDirectory(InstallDir);
            ExtractZip(Resource("helper.zip"), InstallDir);
            Log("    " + InstallDir);

            // 2. python
            Status("Checking Python…");
            Log("[2/5] Python");
            string python = FindPython();
            if (python == null)
            {
                if (!HasWinget())
                    throw new Exception("Python 3 wasn't found and winget isn't available. Install Python 3 from https://www.python.org/downloads/ (tick \"Add python.exe to PATH\"), then run this again.");
                Status("Installing Python (winget)…");
                Log("    Python 3 not found, installing it with winget…");
                int c = Run("winget", "install -e --id Python.Python.3.12 --scope user --silent --accept-package-agreements --accept-source-agreements");
                RefreshPath();
                python = FindPython();
                if (python == null) throw new Exception("Installing Python failed (winget exit code " + c + "). Install Python 3 from https://www.python.org/downloads/ and run this again.");
            }
            Log("    " + python);
            Status("Installing Python packages…");
            int pip = Run(python, "-m pip install --disable-pip-version-check -r \"" + Path.Combine(InstallDir, "requirements.txt") + "\"");
            if (pip != 0) throw new Exception("Installing the Python packages failed (see above).");

            // 3. ffmpeg
            Status("Checking ffmpeg…");
            Log("[3/5] ffmpeg");
            string ff = FindFfmpeg();
            if (ff == null)
            {
                if (!HasWinget())
                    throw new Exception("ffmpeg wasn't found and winget isn't available. Get it from https://www.gyan.dev/ffmpeg/builds/ and put its bin folder on PATH, then run this again.");
                Status("Installing ffmpeg (winget)…");
                Log("    ffmpeg not found, installing it with winget…");
                int c = Run("winget", "install -e --id Gyan.FFmpeg --silent --accept-package-agreements --accept-source-agreements");
                RefreshPath();
                ff = FindFfmpeg();
                if (ff == null) throw new Exception("Installing ffmpeg failed (winget exit code " + c + "). Get it from https://www.gyan.dev/ffmpeg/builds/ and run this again.");
            }
            Log("    " + ff);

            // 4. start the helper now and with Windows
            Status("Starting the helper…");
            Log("[4/5] Helper autostart");
            string pythonw = Path.Combine(Path.GetDirectoryName(python), "pythonw.exe");
            string pyw = Path.Combine(InstallDir, "krugmosh_helper.pyw");
            MakeShortcut(Shortcut, pythonw, "\"" + pyw + "\"", InstallDir, "Krugmosh helper for Premiere Pro (runs hidden)");
            RemoveOldNames();
            WriteUtf8(HomeFile, InstallDir);     // tells the panel where the helper is
            Log("    added to Windows startup");
            ProcessStartInfo hp = new ProcessStartInfo(pythonw, "\"" + pyw + "\"");
            hp.WorkingDirectory = InstallDir;
            hp.UseShellExecute = false;
            hp.CreateNoWindow = true;
            Process.Start(hp);
            bool up = false;
            for (int i = 0; i < 20 && !up; i++)
            {
                Thread.Sleep(500);
                try
                {
                    HttpWebRequest rq = (HttpWebRequest)WebRequest.Create("http://127.0.0.1:8765/health");
                    rq.Timeout = 1000;
                    using (rq.GetResponse()) up = true;
                }
                catch { }
            }
            Log(up ? "    helper is running" : "    helper didn't answer yet, see " + Path.Combine(InstallDir, "helper.log"));

            // 5. the Premiere panel
            Status("Installing the Premiere panel…");
            Log("[5/5] Premiere Pro panel");
            if (!haveUpia)
            {
                string keep = Path.Combine(Path.GetDirectoryName(InstallDir), "krugmosh.ccx");
                File.WriteAllBytes(keep, Resource("krugmosh.ccx"));
                throw new Exception("The helper is installed, but the Premiere panel was not: Adobe's plugin installer wasn't found. " +
                    "Install the Creative Cloud app (with Premiere Pro), then run this setup again" +
                    " (or double-click " + keep + ").");
            }
            string ccx = Path.Combine(Path.GetTempPath(), "krugmosh.ccx");
            File.WriteAllBytes(ccx, Resource("krugmosh.ccx"));
            try
            {
                int code;
                Capture(Upia, "/remove \"Datamosh\"", out code);      // the old name, if still installed
                string o = Capture(Upia, "/install \"" + ccx + "\"", out code);
                foreach (string l in o.Split('\n')) if (l.Trim().Length > 0) Log("    " + l.Trim());
                // the installer exits 0 even when it fails, so read what it says
                if (code != 0 || Regex.IsMatch(o, "Failed", RegexOptions.IgnoreCase))
                    throw new Exception("Adobe's installer couldn't install the panel (see above). If Premiere Pro is open, close it and click Install again.");
            }
            finally { try { File.Delete(ccx); } catch { } }

            Log("");
            Log("Done. Restart Premiere Pro, then open Window > UXP Plugins > Krugmosh.");
            Status("Installed.");
            return true;
        }
        catch (Exception e)
        {
            Log("");
            Log("ERROR: " + e.Message);
            Status("Failed.");
            return false;
        }
    }

    // ---- uninstall -------------------------------------------------------------------

    public bool Uninstall()
    {
        try
        {
            Log("Krugmosh " + Version + " - removing");
            Status("Removing…");
            if (File.Exists(Upia))
            {
                int code;
                Capture(Upia, "/remove \"Krugmosh\"", out code);
                Capture(Upia, "/remove \"Datamosh\"", out code);
                Log("Removed the Premiere panel (restart Premiere Pro).");
            }
            int n = StopHelper();
            Log("Stopped " + n + " running helper(s).");
            try { if (File.Exists(Shortcut)) { File.Delete(Shortcut); Log("Removed from Windows startup."); } } catch { }
            RemoveOldNames();
            DeleteDir(HomeDir);
            DeleteDir(Path.Combine(Local, "Krugmosh"));
            Log("Deleted " + Path.Combine(Local, "Krugmosh"));
            Log("");
            Log("Done. Python and ffmpeg were left installed (other programs may use them).");
            Status("Removed.");
            return true;
        }
        catch (Exception e)
        {
            Log("");
            Log("ERROR: " + e.Message);
            Status("Failed.");
            return false;
        }
    }
}

class SetupForm : Form
{
    readonly TextBox log = new TextBox();
    readonly Label status = new Label();
    readonly ProgressBar bar = new ProgressBar();
    readonly Button btnInstall = new Button();
    readonly Button btnUninstall = new Button();
    readonly Button btnClose = new Button();
    readonly Installer inst = new Installer();
    readonly string auto;
    bool busy;

    public SetupForm(string autoAction)
    {
        auto = autoAction;
        Text = "Krugmosh Setup " + Installer.Version;
        ClientSize = new Size(560, 430);
        FormBorderStyle = FormBorderStyle.FixedDialog;
        MaximizeBox = false;
        StartPosition = FormStartPosition.CenterScreen;
        Font = new Font("Segoe UI", 9f);

        Label title = new Label();
        title.Text = "Krugmosh for Premiere Pro";
        title.Font = new Font("Segoe UI Semibold", 14f);
        title.SetBounds(16, 12, 528, 30);
        Controls.Add(title);

        Label info = new Label();
        info.Text = "Installs the Krugmosh panel into Premiere Pro and the small helper that does the encoding. " +
                    "Python and ffmpeg are installed too if they're missing.";
        info.SetBounds(16, 46, 528, 38);
        Controls.Add(info);

        log.Multiline = true;
        log.ReadOnly = true;
        log.ScrollBars = ScrollBars.Vertical;
        log.Font = new Font("Consolas", 9f);
        log.BackColor = Color.White;
        log.SetBounds(16, 90, 528, 235);
        Controls.Add(log);

        status.SetBounds(16, 333, 528, 20);
        status.Text = "Ready.";
        Controls.Add(status);

        bar.Style = ProgressBarStyle.Marquee;
        bar.MarqueeAnimationSpeed = 0;
        bar.SetBounds(16, 356, 528, 8);
        Controls.Add(bar);

        btnInstall.Text = "Install";
        btnInstall.SetBounds(16, 380, 110, 32);
        btnInstall.Click += delegate { Start(true); };
        Controls.Add(btnInstall);

        btnUninstall.Text = "Uninstall";
        btnUninstall.SetBounds(134, 380, 110, 32);
        btnUninstall.Click += delegate { Start(false); };
        Controls.Add(btnUninstall);

        btnClose.Text = "Close";
        btnClose.SetBounds(434, 380, 110, 32);
        btnClose.Click += delegate { Close(); };
        Controls.Add(btnClose);

        AcceptButton = btnInstall;
        inst.Log = delegate (string s) { Ui(delegate { log.AppendText(s + "\r\n"); }); };
        inst.Status = delegate (string s) { Ui(delegate { status.Text = s; }); };
    }

    protected override void OnShown(EventArgs e)
    {
        base.OnShown(e);
        if (auto == "install") Start(true);
        else if (auto == "uninstall") Start(false);
    }

    protected override void OnFormClosing(FormClosingEventArgs e)
    {
        if (busy)
        {
            e.Cancel = true;
            MessageBox.Show(this, "Wait until it's finished.", Text, MessageBoxButtons.OK, MessageBoxIcon.Information);
        }
        base.OnFormClosing(e);
    }

    void Ui(MethodInvoker a)
    {
        if (IsHandleCreated && !IsDisposed) BeginInvoke(a);
    }

    void Start(bool install)
    {
        if (busy) return;
        if (!install && auto == null &&
            MessageBox.Show(this, "Remove Krugmosh from Premiere Pro and delete the helper?", Text,
                            MessageBoxButtons.OKCancel, MessageBoxIcon.Question) != DialogResult.OK) return;
        busy = true;
        btnInstall.Enabled = btnUninstall.Enabled = btnClose.Enabled = false;
        bar.MarqueeAnimationSpeed = 30;
        log.Clear();
        Thread t = new Thread(delegate ()
        {
            bool ok = install ? inst.Install() : inst.Uninstall();
            Ui(delegate
            {
                busy = false;
                bar.MarqueeAnimationSpeed = 0;
                bar.Style = ProgressBarStyle.Continuous;
                bar.Value = ok ? 100 : 0;
                btnInstall.Enabled = btnUninstall.Enabled = btnClose.Enabled = true;
                btnInstall.Text = install && ok ? "Reinstall" : "Install";
                if (auto != null && ok) Close();
            });
        });
        t.IsBackground = true;
        t.Start();
    }
}
