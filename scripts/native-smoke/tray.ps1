# Find Bloblex tray icon via UI Automation; optionally right-click it and dump the context menu items.
param([switch]$Menu)
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
$root = [System.Windows.Automation.AutomationElement]::RootElement
$cond = New-Object System.Windows.Automation.PropertyCondition ([System.Windows.Automation.AutomationElement]::ControlTypeProperty), ([System.Windows.Automation.ControlType]::Button)
function Find-Tray($name) {
  $all = $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, $cond)
  foreach ($e in $all) { if ($e.Current.Name -like "*$name*") { return $e } }
  return $null
}
$btn = Find-Tray 'Bloblex'
if (-not $btn) {
  # try opening the hidden-icons overflow
  $chev = Find-Tray 'Show Hidden Icons'
  if ($chev) { try { ($chev.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern)).Invoke(); Start-Sleep -Milliseconds 700 } catch {} ; $btn = Find-Tray 'Bloblex' }
}
if (-not $btn) { Write-Host 'TRAY ICON NOT FOUND via UIA'; exit 3 }
$r = $btn.Current.BoundingRectangle
Write-Host ("tray button: '{0}' at {1},{2} {3}x{4}" -f $btn.Current.Name, [int]$r.X, [int]$r.Y, [int]$r.Width, [int]$r.Height)
if ($Menu) {
  Add-Type @'
using System; using System.Runtime.InteropServices;
public class TrayMouse { [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y); [DllImport("user32.dll")] public static extern void mouse_event(uint f, uint dx, uint dy, uint d, UIntPtr e); }
'@
  [TrayMouse]::SetCursorPos([int]($r.X + $r.Width / 2), [int]($r.Y + $r.Height / 2)) | Out-Null
  Start-Sleep -Milliseconds 300
  [TrayMouse]::mouse_event(0x0008, 0, 0, 0, [UIntPtr]::Zero); Start-Sleep -Milliseconds 80; [TrayMouse]::mouse_event(0x0010, 0, 0, 0, [UIntPtr]::Zero)
  Start-Sleep -Milliseconds 900
  $menuCond = New-Object System.Windows.Automation.PropertyCondition ([System.Windows.Automation.AutomationElement]::ControlTypeProperty), ([System.Windows.Automation.ControlType]::MenuItem)
  $items = $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, $menuCond)
  foreach ($i in $items) { Write-Host ("menu item: " + $i.Current.Name) }
  Write-Host ("menu items found: " + $items.Count)
}
