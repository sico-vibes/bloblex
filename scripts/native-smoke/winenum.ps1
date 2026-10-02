# List visible top-level windows of a process (by id) with rects and extended styles.
param([int]$ProcId)
Add-Type @'
using System; using System.Text; using System.Collections.Generic; using System.Runtime.InteropServices;
public class WinEnum {
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc p, IntPtr l);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll", EntryPoint="GetWindowLongPtrW")] static extern IntPtr GetWindowLongPtr(IntPtr h, int i);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
  public static List<string> ForPid(uint pid) {
    var res = new List<string>();
    EnumWindows((h, l) => {
      uint p; GetWindowThreadProcessId(h, out p);
      if (p == pid && IsWindowVisible(h)) {
        var t = new StringBuilder(256); GetWindowText(h, t, 256);
        var c = new StringBuilder(128); GetClassName(h, c, 128);
        RECT r; GetWindowRect(h, out r);
        long ex = GetWindowLongPtr(h, -20).ToInt64();
        res.Add(string.Format("{0}|{1}|{2}|{3},{4},{5},{6}|{7}x{8}|exstyle=0x{9:X}", h.ToInt64(), c, t, r.L, r.T, r.R, r.B, r.R - r.L, r.B - r.T, ex));
      }
      return true;
    }, IntPtr.Zero);
    return res;
  }
}
'@
[WinEnum]::ForPid([uint32]$ProcId) | ForEach-Object { $_ }
