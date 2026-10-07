# App-owned pixels only. Never use a desktop/screen device context here.
$wgcProvider = Join-Path $PSScriptRoot 'windows-graphics-capture.ps1'
if (Test-Path -LiteralPath $wgcProvider) { . $wgcProvider }
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class RelaiAppCaptureNative {
  [StructLayout(LayoutKind.Sequential)]
  public struct Rect { public int Left, Top, Right, Bottom; }
  [StructLayout(LayoutKind.Sequential)] public struct Point { public int X, Y; }
  [DllImport("user32.dll")] public static extern IntPtr WindowFromPoint(Point point);
  [DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr hwnd, uint flags);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr hwnd);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hwnd);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hwnd);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hwnd, out Rect rect);
  [DllImport("user32.dll", SetLastError=true)] public static extern bool GetWindowDisplayAffinity(IntPtr hwnd, out uint affinity);
  [DllImport("dwmapi.dll", EntryPoint="DwmGetWindowAttribute")] public static extern int DwmWindowFlags(IntPtr hwnd, uint attribute, out uint value, int size);
  [DllImport("dwmapi.dll", EntryPoint="DwmGetWindowAttribute")] public static extern int DwmWindowBounds(IntPtr hwnd, uint attribute, out Rect value, int size);
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr hwnd, IntPtr hdc, uint flags);
  [DllImport("user32.dll")] public static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);
}
'@

function Get-AppPixelCapture([string]$App, [object]$Match, [string]$DisplayId = '') {
  if ($null -eq $Match -or $null -eq $Match.Process) { throw 'APP_TARGET_STALE: App-only capture requires a verified application process.' }
  if ($Match.Identity) {
    $selectedHandle = [IntPtr]([long]$Match.Identity.windowId)
    if ([RelaiAppCaptureNative]::IsIconic($selectedHandle)) { throw 'APP_CAPTURE_UNAVAILABLE: The approved window is minimized. Restore it yourself or use available structured app controls.' }
    $null = Get-VerifiedAppWindow $Match.Identity
  }
  else {
    $expectedName = Compact-Text ($App -replace '\.exe$', '')
    if (-not $expectedName -or (Compact-Text $Match.Process.ProcessName) -ne $expectedName) {
      throw 'APP_TARGET_STALE: Resolve the application executable/product identity before using a title alias.'
    }
  }
  $current = $Match.Element.Current
  $hwnd = [IntPtr]$current.NativeWindowHandle
  $expectedPid = [uint32]$current.ProcessId
  $expectedStart = $Match.Process.StartTime.ToUniversalTime().Ticks
  if ($hwnd -eq [IntPtr]::Zero -or -not [RelaiAppCaptureNative]::IsWindow($hwnd) -or
      -not [RelaiAppCaptureNative]::IsWindowVisible($hwnd) -or [RelaiAppCaptureNative]::IsIconic($hwnd)) {
    throw 'APP_CAPTURE_UNAVAILABLE: The approved window is hidden or minimized. Restore it yourself or use available structured app controls.'
  }
  $actualPid = [uint32]0
  $null = [RelaiAppCaptureNative]::GetWindowThreadProcessId($hwnd, [ref]$actualPid)
  if ($actualPid -ne $expectedPid) { throw 'APP_TARGET_STALE: Application window identity changed before capture.' }
  $affinity = [uint32]0
  if ([RelaiAppCaptureNative]::GetWindowDisplayAffinity($hwnd, [ref]$affinity) -and $affinity -ne 0) {
    throw 'APP_CAPTURE_DENIED: The application protects this window from capture. No alternate provider will be used.'
  }
  $cloaked = [uint32]0
  if ([RelaiAppCaptureNative]::DwmWindowFlags($hwnd, 14, [ref]$cloaked, 4) -eq 0 -and $cloaked -ne 0) {
    throw 'APP_CAPTURE_UNAVAILABLE: This application window is not presented on the current desktop.'
  }
  $previousDpi = [RelaiAppCaptureNative]::SetThreadDpiAwarenessContext([IntPtr](-4))
  if ($previousDpi -eq [IntPtr]::Zero) { throw 'APP_CAPTURE_UNAVAILABLE: Physical window coordinates could not be established.' }
  $bitmap = $null; $graphics = $null; $hdc = [IntPtr]::Zero
  try {
    $rect = [RelaiAppCaptureNative+Rect]::new()
    if (-not [RelaiAppCaptureNative]::GetWindowRect($hwnd, [ref]$rect)) { throw 'APP_TARGET_STALE: Application window bounds are unavailable.' }
    $windowBounds = [System.Drawing.Rectangle]::FromLTRB($rect.Left, $rect.Top, $rect.Right, $rect.Bottom)
    if ($windowBounds.Width -le 1 -or $windowBounds.Height -le 1 -or $windowBounds.Width -gt 8192 -or $windowBounds.Height -gt 8192 -or
        ([long]$windowBounds.Width * $windowBounds.Height) -gt 16777216) { throw 'APP_CAPTURE_UNAVAILABLE: Application window dimensions exceed the capture limit.' }
    $method = 'win32-print-window'; $bounds = $windowBounds; $boundsSource = 'get-window-rect'
    $mappingReliable = $true; $frameEvidence = $null; $fallbackReason = ''
    if (Get-Command Get-WgcWindowCapture -ErrorAction SilentlyContinue) {
      try {
        $native = Get-WgcWindowCapture $hwnd 1500
        $bitmap = $native.Bitmap; $bounds = $native.Bounds; $boundsSource = $native.BoundsSource
        $mappingReliable = $native.InputMappingReliable; $frameEvidence = $native.FrameEvidence
        $method = 'windows-graphics-capture'
      } catch {
        $message = [string]$_.Exception.Message
        if ($message -match 'WGC_DENIED') { throw 'APP_CAPTURE_DENIED: Windows denied this capture. No alternate provider will be used.' }
        if ($message -match 'WGC_SOURCE_CHANGED') { throw 'APP_TARGET_STALE: Window identity or geometry changed during capture.' }
        $fallbackReason = if ($message -match 'WGC_TIMEOUT') { 'compositor-frame-timeout' } elseif ($message -match 'WGC_UNAVAILABLE') { 'compositor-unavailable' } else { 'compositor-failed' }
      }
    } else { $fallbackReason = 'compositor-provider-unavailable' }
    if ($null -eq $bitmap) {
      # Owner-rendered compatibility only; never switch to a desktop copy.
      if ($Match.Identity) { $null = Get-VerifiedAppWindow $Match.Identity }
      $bitmap = [System.Drawing.Bitmap]::new($bounds.Width, $bounds.Height)
      $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
      $graphics.Clear([System.Drawing.Color]::Black)
      $hdc = $graphics.GetHdc()
      $printed = [RelaiAppCaptureNative]::PrintWindow($hwnd, $hdc, 0)
      $graphics.ReleaseHdc($hdc); $hdc = [IntPtr]::Zero
      $graphics.Dispose(); $graphics = $null
      if (-not $printed) { throw 'APP_CAPTURE_UNAVAILABLE: Neither compositor nor owner-rendered app pixels are available. Use structured app observation, or relai_browser for browser content.' }
    }
    $after = [RelaiAppCaptureNative+Rect]::new()
    $actualPid = [uint32]0
    $null = [RelaiAppCaptureNative]::GetWindowThreadProcessId($hwnd, [ref]$actualPid)
    $processAfter = Get-Process -Id $expectedPid -ErrorAction Stop
    if (-not [RelaiAppCaptureNative]::IsWindow($hwnd) -or -not [RelaiAppCaptureNative]::IsWindowVisible($hwnd) -or
        [RelaiAppCaptureNative]::IsIconic($hwnd) -or $actualPid -ne $expectedPid -or
        $processAfter.StartTime.ToUniversalTime().Ticks -ne $expectedStart -or
        -not [RelaiAppCaptureNative]::GetWindowRect($hwnd, [ref]$after) -or
        $after.Left -ne $rect.Left -or $after.Top -ne $rect.Top -or $after.Right -ne $rect.Right -or $after.Bottom -ne $rect.Bottom) {
      throw 'APP_TARGET_STALE: Application identity, visibility, or geometry changed during capture.'
    }
    if ($Match.Identity) { $null = Get-VerifiedAppWindow $Match.Identity }
    $screen = [System.Windows.Forms.Screen]::FromHandle($hwnd)
    if ($DisplayId) {
      $selected = @([System.Windows.Forms.Screen]::AllScreens | Where-Object { $_.DeviceName -eq $DisplayId -and $_.Bounds.IntersectsWith($bounds) })
      if ($selected.Count -ne 1) { throw 'APP_CAPTURE_UNAVAILABLE: The selected application window does not intersect that display.' }
      $screen = $selected[0]
    }
    $mappingReliable = $mappingReliable -and $screen.Bounds.Contains($bounds)
    $provenance = [pscustomobject]@{
      scope = 'app-window'; method = $method; app = (Normalize-Text $App)
      windowId = $hwnd.ToInt64().ToString(); processId = [int]$expectedPid
      processStartedAt = $expectedStart.ToString(); displayId = $screen.DeviceName
      capturedAt = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
      windowWidth = $bitmap.Width; windowHeight = $bitmap.Height
      coordinateSpace = 'window-local-pixels'; boundsSource = $boundsSource
      originX = $bounds.Left - $screen.Bounds.Left; originY = $bounds.Top - $screen.Bounds.Top
      inputMappingReliable = [bool]$mappingReliable; targetIdentity = $Match.Identity
      freshness = if ($method -eq 'windows-graphics-capture') { 'fresh-compositor-frame' } else { 'owner-rendered-request' }
      fallbackReason = $fallbackReason
      frameQpc100ns = if ($frameEvidence) { [double]$frameEvidence.frameQpc100ns } else { $null }
      requestQpc100ns = if ($frameEvidence) { [double]$frameEvidence.requestQpc100ns } else { $null }
    }
    $result = [pscustomobject]@{ Bitmap = $bitmap; Bounds = $bounds; Provenance = $provenance }
    $bitmap = $null
    return $result
  } finally {
    if ($hdc -ne [IntPtr]::Zero -and $null -ne $graphics) { $graphics.ReleaseHdc($hdc) }
    if ($null -ne $graphics) { $graphics.Dispose() }
    if ($null -ne $bitmap) { $bitmap.Dispose() }
    $null = [RelaiAppCaptureNative]::SetThreadDpiAwarenessContext($previousDpi)
  }
}

# Read-only pre-input validation. This function never sends input or captures pixels.
function Assert-AppInputTarget([string]$App, [object]$Target) {
  $proof = $Target.provenance
  if ($null -eq $proof -or $proof.scope -ne 'app-window' -or $proof.method -notin @('win32-print-window', 'windows-graphics-capture') -or
      (Normalize-Text $proof.app) -ne (Normalize-Text $App) -or
      [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() - [long]$proof.capturedAt -gt 30000) {
    throw 'The app-window observation is missing, expired, or mismatched.'
  }
  if ($proof.inputMappingReliable -eq $false) { throw 'This app image is valid, but its coordinates do not map safely into one display. Use structured app controls.' }
  if ($proof.targetIdentity) { $null = Get-VerifiedAppWindow $proof.targetIdentity }
  $hwnd = [IntPtr]([long]$proof.windowId)
  $expectedPid = [uint32]$proof.processId
  $actualPid = [uint32]0
  $null = [RelaiAppCaptureNative]::GetWindowThreadProcessId($hwnd, [ref]$actualPid)
  if ($hwnd -eq [IntPtr]::Zero -or -not [RelaiAppCaptureNative]::IsWindow($hwnd) -or
      -not [RelaiAppCaptureNative]::IsWindowVisible($hwnd) -or [RelaiAppCaptureNative]::IsIconic($hwnd) -or
      $actualPid -ne $expectedPid) { throw 'The approved window is hidden, minimized, closed, or no longer owned by the captured process.' }
  $owner = Get-Process -Id $expectedPid -ErrorAction Stop
  if ($owner.StartTime.ToUniversalTime().Ticks.ToString() -ne [string]$proof.processStartedAt -or
      (-not $proof.targetIdentity -and (Compact-Text $owner.ProcessName) -ne (Compact-Text ($App -replace '\.exe$', '')))) {
    throw 'The application process identity changed after observation.'
  }
  $previousDpi = [RelaiAppCaptureNative]::SetThreadDpiAwarenessContext([IntPtr](-4))
  if ($previousDpi -eq [IntPtr]::Zero) { throw 'Physical input coordinates could not be established.' }
  try {
    $rect = [RelaiAppCaptureNative+Rect]::new()
    if (-not [RelaiAppCaptureNative]::GetWindowRect($hwnd, [ref]$rect)) { throw 'Approved window bounds are unavailable.' }
    if ($proof.boundsSource -eq 'dwm-extended-frame' -and [RelaiAppCaptureNative]::DwmWindowBounds($hwnd, 9, [ref]$rect, 16) -ne 0) { throw 'Current compositor frame bounds are unavailable.' }
    $bounds = [System.Drawing.Rectangle]::FromLTRB($rect.Left, $rect.Top, $rect.Right, $rect.Bottom)
    $screen = [System.Windows.Forms.Screen]::FromHandle($hwnd)
    if ($screen.DeviceName -ne [string]$proof.displayId -or -not $screen.Bounds.Contains($bounds) -or
        $bounds.Left - $screen.Bounds.Left -ne [int]$proof.originX -or $bounds.Top - $screen.Bounds.Top -ne [int]$proof.originY -or
        $bounds.Width -ne [int]$Target.width -or $bounds.Height -ne [int]$Target.height) {
      throw 'The approved window moved, resized, or changed displays; take a new observation.'
    }
    if ($Target.requiresFocus -eq $true) {
      $foreground = [RelaiAppCaptureNative]::GetForegroundWindow()
      if ($foreground -eq [IntPtr]::Zero -or [RelaiAppCaptureNative]::GetAncestor($foreground, 2) -ne $hwnd) {
        throw 'The approved window is not foreground; no keyboard input is authorized by this observation.'
      }
    } else {
      if ($null -eq $Target.points -or @($Target.points).Count -eq 0) { throw 'Observation-based pointer input requires explicit coordinates.' }
      foreach ($point in @($Target.points)) {
        $physical = [RelaiAppCaptureNative+Point]::new()
        $physical.X = [int]$point.x + $screen.Bounds.Left
        $physical.Y = [int]$point.y + $screen.Bounds.Top
        if (-not $bounds.Contains($physical.X, $physical.Y)) { throw 'The input point is outside the observed window.' }
        $hit = [RelaiAppCaptureNative]::WindowFromPoint($physical)
        if ($hit -eq [IntPtr]::Zero -or [RelaiAppCaptureNative]::GetAncestor($hit, 2) -ne $hwnd) {
          throw 'The approved window is occluded at the input point; no input was sent.'
        }
      }
    }
    $actualPid = [uint32]0
    $null = [RelaiAppCaptureNative]::GetWindowThreadProcessId($hwnd, [ref]$actualPid)
    if ($actualPid -ne $expectedPid -or -not [RelaiAppCaptureNative]::IsWindow($hwnd)) { throw 'Window identity changed during input validation.' }
    return [pscustomobject]@{ verified = $true; windowId = [string]$proof.windowId; processId = [int]$expectedPid }
  } finally {
    $null = [RelaiAppCaptureNative]::SetThreadDpiAwarenessContext($previousDpi)
  }
}

function Get-AppScreenshot([string]$App, [string]$DisplayId, [object]$AppTarget) {
  $capture = Get-AppPixelCapture $App (Get-VerifiedAppWindow $AppTarget) $DisplayId
  $stream = [System.IO.MemoryStream]::new()
  try {
    if ($DisplayId -and $capture.Provenance.displayId -ne $DisplayId) { throw 'Approved application is on a different display.' }
    $capture.Bitmap.Save($stream, [System.Drawing.Imaging.ImageFormat]::Png)
    $bytes = $stream.ToArray()
    if ($bytes.Length -gt 4194304) { throw 'App-only screenshot exceeds the 4194304-byte image limit.' }
    return [pscustomobject]@{
      mimeType = 'image/png'; data = [Convert]::ToBase64String($bytes); bytes = $bytes.Length
      width = $capture.Bitmap.Width; height = $capture.Bitmap.Height; provenance = $capture.Provenance
    }
  } finally {
    $capture.Bitmap.Dispose()
    $stream.Dispose()
  }
}
