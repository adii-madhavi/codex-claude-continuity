# Demo-only desktop operation for live tests (not part of the integration).
# No computer-use tool is available in this environment, and the ChatGPT and Claude
# windows expose no UI Automation content, so this uses Win32 input: it brings a
# named app's main window to the front and sends keys or clicks ONLY after checking
# that window is in the foreground; otherwise it aborts without sending anything.
# It is never used on permission dialogs, tool approvals or edit approvals.
# Observed 2026-10-23: Claude Code's auto-mode permission check DENIED a coordinate click
# with this script, so in that mode only "focus" and "shot" are usable; clicks need a
# user-added permission rule or the user's own hand.
#   desktop.ps1 shot <png> [scale]            screenshot of the whole screen
#   desktop.ps1 focus <ChatGPT|claude>        bring the app window to the front, print its rect
#   desktop.ps1 keys <ChatGPT|claude> <keys>  SendKeys syntax, e.g. "{ENTER}", "{ESC}", "^v"
#   desktop.ps1 click <ChatGPT|claude> <x> <y> left click at screen coordinates
param([string]$Action, [string]$A1, [string]$A2, [string]$A3)
$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Windows.Forms, System.Drawing
Add-Type @"
using System; using System.Runtime.InteropServices;
public static class W {
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int c);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr h);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, IntPtr p);
  [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
  [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint a, uint b, bool f);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint f, uint x, uint y, uint d, UIntPtr e);
  [DllImport("user32.dll")] public static extern void keybd_event(byte k, byte s, uint f, UIntPtr e);
  public struct RECT { public int L, T, R, B; }
}
"@

function Get-Hwnd([string]$proc) {
  $p = Get-Process -Name $proc -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 -and $_.MainWindowTitle } | Select-Object -First 1
  if (-not $p) { throw "No visible $proc window" }
  return $p.MainWindowHandle
}
function Focus([string]$proc) {
  $h = Get-Hwnd $proc
  if ([W]::IsIconic($h)) { [W]::ShowWindow($h, 9) | Out-Null }
  $fg = [W]::GetForegroundWindow()
  $a = [W]::GetWindowThreadProcessId($fg, [IntPtr]::Zero); $b = [W]::GetCurrentThreadId()
  # No Alt tap: it opened Claude Desktop's File menu. AttachThreadInput is enough here.
  [W]::AttachThreadInput($b, $a, $true) | Out-Null
  [W]::BringWindowToTop($h) | Out-Null; [W]::SetForegroundWindow($h) | Out-Null
  [W]::AttachThreadInput($b, $a, $false) | Out-Null
  Start-Sleep -Milliseconds 400
  if ([W]::GetForegroundWindow() -ne $h) { throw "Could not bring $proc to the foreground; nothing sent" }
  $r = New-Object W+RECT; [W]::GetWindowRect($h, [ref]$r) | Out-Null
  return @{ Hwnd = $h; Rect = $r }
}
function Assert-Front([string]$proc) {
  $h = Get-Hwnd $proc
  if ([W]::GetForegroundWindow() -ne $h) { throw "$proc is not in the foreground; nothing sent" }
}

switch ($Action) {
  "shot" {
    $scale = if ($A2) { [double]$A2 } else { 0.5 }
    $s = [System.Windows.Forms.SystemInformation]::VirtualScreen
    $bmp = New-Object System.Drawing.Bitmap $s.Width, $s.Height
    [System.Drawing.Graphics]::FromImage($bmp).CopyFromScreen($s.Left, $s.Top, 0, 0, $bmp.Size)
    $out = New-Object System.Drawing.Bitmap $bmp, ([int]($s.Width * $scale)), ([int]($s.Height * $scale))
    $out.Save($A1, [System.Drawing.Imaging.ImageFormat]::Png); "saved $A1 ($($s.Width)x$($s.Height) at scale $scale)"
  }
  "focus" { $f = Focus $A1; "focused $A1 rect L=$($f.Rect.L) T=$($f.Rect.T) R=$($f.Rect.R) B=$($f.Rect.B)" }
  "keys" { Focus $A1 | Out-Null; Assert-Front $A1; [System.Windows.Forms.SendKeys]::SendWait($A2); "sent keys to $A1" }
  "click" {
    Focus $A1 | Out-Null; Assert-Front $A1
    [W]::SetCursorPos([int]$A2, [int]$A3) | Out-Null; Start-Sleep -Milliseconds 120
    [W]::mouse_event(2, 0, 0, 0, [UIntPtr]::Zero); [W]::mouse_event(4, 0, 0, 0, [UIntPtr]::Zero); "clicked $A1 at $A2,$A3"
  }
  default { throw "unknown action $Action" }
}
