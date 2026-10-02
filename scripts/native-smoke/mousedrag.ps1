# Synthesize a left-button drag from (x1,y1) to (x2,y2) in virtual-screen coordinates.
param([int]$X1, [int]$Y1, [int]$X2, [int]$Y2, [int]$Steps = 25)
Add-Type @'
using System; using System.Runtime.InteropServices;
public class MouseSim {
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint f, uint dx, uint dy, uint d, UIntPtr e);
  public const uint DOWN = 0x0002, UP = 0x0004;
}
'@
[MouseSim]::SetCursorPos($X1, $Y1) | Out-Null
Start-Sleep -Milliseconds 300
[MouseSim]::mouse_event([MouseSim]::DOWN, 0, 0, 0, [UIntPtr]::Zero)
Start-Sleep -Milliseconds 200
for ($i = 1; $i -le $Steps; $i++) {
  $x = [int]($X1 + ($X2 - $X1) * $i / $Steps); $y = [int]($Y1 + ($Y2 - $Y1) * $i / $Steps)
  [MouseSim]::SetCursorPos($x, $y) | Out-Null
  Start-Sleep -Milliseconds 20
}
Start-Sleep -Milliseconds 200
[MouseSim]::mouse_event([MouseSim]::UP, 0, 0, 0, [UIntPtr]::Zero)
Write-Host "dragged ($X1,$Y1) -> ($X2,$Y2)"
