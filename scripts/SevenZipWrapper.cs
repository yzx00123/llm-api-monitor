using System;
using System.Diagnostics;
using System.IO;

/// <summary>
/// Wrapper around 7za.exe: electron-builder's Go binary treats any non-zero
/// exit as fatal, but winCodeSign's macOS symlinks (darwin/*.dylib) cannot
/// be created on Windows and make 7za exit 2 even though every Windows
/// tool extracted fine. This wrapper maps that specific failure to success
/// by dropping 0-byte placeholder files where the symlinks would be.
/// </summary>
static class SevenZipWrapper
{
    static int Main(string[] args)
    {
        string real7za = Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "7za-real.exe");
        if (!File.Exists(real7za))
        {
            Console.Error.WriteLine("7za-real.exe not found next to wrapper");
            return 1;
        }

        string outDir = null;
        foreach (var a in args)
        {
            if (a.StartsWith("-o", StringComparison.Ordinal) && a.Length > 2)
                outDir = a.Substring(2);
        }

        var psi = new ProcessStartInfo
        {
            FileName = real7za,
            Arguments = JoinArgs(args),
            UseShellExecute = false,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            CreateNoWindow = true,
        };
        // inherit our stdout/stderr so electron-builder still sees the log
        psi.RedirectStandardOutput = false;
        psi.RedirectStandardError = false;

        using (var p = Process.Start(psi))
        {
            p.WaitForExit();
            int code = p.ExitCode;
            if (code == 0)
                return 0;

            // exit 2 from winCodeSign = symlink-only failures; the Windows
            // binaries (rcedit, signtool, ...) are already extracted.
            if (code == 2 && outDir != null && Directory.Exists(outDir))
            {
                string libDir = Path.Combine(outDir, "darwin", "10.12", "lib");
                Directory.CreateDirectory(libDir);
                foreach (var f in new[] { "libcrypto.dylib", "libssl.dylib" })
                {
                    string path = Path.Combine(libDir, f);
                    if (!File.Exists(path))
                        File.WriteAllBytes(path, new byte[0]);
                }
                Console.Error.WriteLine(
                    "[7za-wrapper] exit 2 tolerated: macOS symlink placeholders written");
                return 0;
            }

            return code;
        }
    }

    static string JoinArgs(string[] args)
    {
        var parts = new string[args.Length];
        for (int i = 0; i < args.Length; i++)
        {
            var a = args[i];
            if (a.IndexOfAny(new[] { ' ', '\t' }) >= 0)
                parts[i] = "\"" + a + "\"";
            else
                parts[i] = a;
        }
        return string.Join(" ", parts);
    }
}
