# Metadata-only application discovery and identity binding. No pixels or input.
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
public static class RelaiAppTargetNative {
  [DllImport("kernel32.dll", SetLastError=true)] public static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
  [DllImport("kernel32.dll")] public static extern bool CloseHandle(IntPtr handle);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  public static extern bool QueryFullProcessImageName(IntPtr handle, uint flags, StringBuilder path, ref uint size);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode)] public static extern int GetPackageFamilyName(IntPtr process, ref uint length, StringBuilder value);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode)] public static extern int GetApplicationUserModelId(IntPtr process, ref uint length, StringBuilder value);
  private delegate bool EnumWindowProc(IntPtr hwnd, IntPtr parameter);
  [DllImport("user32.dll")] private static extern bool EnumChildWindows(IntPtr hwnd, EnumWindowProc callback, IntPtr parameter);
  public static IntPtr[] Descendants(IntPtr root) {
    var values = new List<IntPtr>();
    EnumWindowProc callback = (hwnd, parameter) => { values.Add(hwnd); return values.Count < 128; };
    EnumChildWindows(root, callback, IntPtr.Zero);
    GC.KeepAlive(callback);
    return values.ToArray();
  }
}
'@

function Get-AppProcessIdentity([uint32]$ProcessId) {
  $handle = [RelaiAppTargetNative]::OpenProcess(0x1000, $false, $ProcessId)
  if ($handle -eq [IntPtr]::Zero) { return $null }
  try {
    $length = [uint32]32768
    $image = [System.Text.StringBuilder]::new([int]$length)
    if (-not [RelaiAppTargetNative]::QueryFullProcessImageName($handle, 0, $image, [ref]$length)) { return $null }
    $process = Get-Process -Id $ProcessId -ErrorAction Stop
    $family = ''
    $applicationId = ''
    $size = [uint32]0
    $status = [RelaiAppTargetNative]::GetPackageFamilyName($handle, [ref]$size, $null)
    if ($status -eq 122 -and $size -gt 0 -and $size -le 4096) {
      $buffer = [System.Text.StringBuilder]::new([int]$size)
      if ([RelaiAppTargetNative]::GetPackageFamilyName($handle, [ref]$size, $buffer) -eq 0) { $family = $buffer.ToString() }
    }
    if ($family) {
      $size = [uint32]0
      $status = [RelaiAppTargetNative]::GetApplicationUserModelId($handle, [ref]$size, $null)
      if ($status -eq 122 -and $size -gt 0 -and $size -le 4096) {
        $buffer = [System.Text.StringBuilder]::new([int]$size)
        if ([RelaiAppTargetNative]::GetApplicationUserModelId($handle, [ref]$size, $buffer) -eq 0) { $applicationId = $buffer.ToString() }
      }
    }
    $version = $null
    try { $version = [System.Diagnostics.FileVersionInfo]::GetVersionInfo($image.ToString()) } catch {}
    return [pscustomobject]@{
      processId = [int]$ProcessId; processStartedAt = $process.StartTime.ToUniversalTime().Ticks.ToString()
      executablePath = $image.ToString(); processName = $process.ProcessName
      productName = if ($version) { Safe-Text $version.ProductName 200 } else { '' }
      fileDescription = if ($version) { Safe-Text $version.FileDescription 200 } else { '' }
      packageFamily = $family; applicationId = $applicationId
    }
  } catch { return $null } finally { $null = [RelaiAppTargetNative]::CloseHandle($handle) }
}

function Get-AppWindowCandidate([IntPtr]$Handle) {
  if ($Handle -eq [IntPtr]::Zero -or -not [RelaiAppCaptureNative]::IsWindow($Handle) -or
      -not [RelaiAppCaptureNative]::IsWindowVisible($Handle) -or
      [RelaiAppCaptureNative]::GetAncestor($Handle, 2) -ne $Handle) { return $null }
  $windowPid = [uint32]0
  $null = [RelaiAppCaptureNative]::GetWindowThreadProcessId($Handle, [ref]$windowPid)
  $owner = Get-AppProcessIdentity $windowPid
  if ($null -eq $owner) { return $null }
  $element = [System.Windows.Automation.AutomationElement]::FromHandle($Handle)
  $current = $element.Current
  $screen = [System.Windows.Forms.Screen]::FromHandle($Handle)
  $displayIds = @($screen.DeviceName)
  if (-not [RelaiAppCaptureNative]::IsIconic($Handle)) {
    try { $rectangle = [System.Drawing.Rectangle]::FromLTRB([int]$current.BoundingRectangle.Left, [int]$current.BoundingRectangle.Top, [int]$current.BoundingRectangle.Right, [int]$current.BoundingRectangle.Bottom)
      $displayIds = @([System.Windows.Forms.Screen]::AllScreens | Where-Object { $_.Bounds.IntersectsWith($rectangle) } | ForEach-Object { $_.DeviceName })
    } catch { $displayIds = @($screen.DeviceName) }
  }
  $content = $null
  if ((Normalize-Text $owner.processName) -eq 'applicationframehost') {
    $packages = @{}
    $descendants = [RelaiAppTargetNative]::Descendants($Handle)
    if ($descendants.Length -ge 128) { return $null }
    foreach ($child in $descendants) {
      if (-not [RelaiAppCaptureNative]::IsWindowVisible($child) -or [RelaiAppCaptureNative]::GetAncestor($child, 2) -ne $Handle) { continue }
      $childPid = [uint32]0
      $null = [RelaiAppCaptureNative]::GetWindowThreadProcessId($child, [ref]$childPid)
      if ($childPid -eq $windowPid) { continue }
      $identity = Get-AppProcessIdentity $childPid
      if ($null -eq $identity -or -not $identity.packageFamily) { return $null }
      $key = $identity.packageFamily + '|' + $identity.applicationId
      if (-not $packages.ContainsKey($key)) {
        $identity | Add-Member -NotePropertyName windowId -NotePropertyValue $child.ToInt64().ToString()
        $packages[$key] = $identity
      }
    }
    # An OS host is never generic app authority. Require one proven packaged
    # content identity rooted in this exact top-level HWND.
    if ($packages.Count -ne 1) { return $null }
    $content = @($packages.Values)[0]
  }
  return [pscustomobject]@{
    windowId = $Handle.ToInt64().ToString(); processId = $owner.processId; processStartedAt = $owner.processStartedAt
    executablePath = $owner.executablePath; processName = $owner.processName
    productName = $owner.productName; fileDescription = $owner.fileDescription
    packageFamily = $owner.packageFamily; applicationId = $owner.applicationId; content = $content
    title = Safe-Text $current.Name 500; foreground = ([RelaiAppCaptureNative]::GetAncestor([RelaiAppCaptureNative]::GetForegroundWindow(), 2) -eq $Handle)
    visible = $true; minimized = [RelaiAppCaptureNative]::IsIconic($Handle); displayId = $screen.DeviceName
    displayIds = $displayIds
  }
}

function Test-SameAppWindowIdentity([object]$Expected, [object]$Actual) {
  if ($null -eq $Expected -or $null -eq $Actual) { return $false }
  foreach ($field in @('windowId', 'processId', 'processStartedAt', 'executablePath')) {
    if ((Normalize-Text $Expected.$field) -ne (Normalize-Text $Actual.$field)) { return $false }
  }
  if ($null -ne $Expected.content) {
    if ($null -eq $Actual.content) { return $false }
    foreach ($field in @('windowId', 'processId', 'processStartedAt', 'executablePath', 'packageFamily', 'applicationId')) {
      if ((Normalize-Text $Expected.content.$field) -ne (Normalize-Text $Actual.content.$field)) { return $false }
    }
  } elseif ($null -ne $Actual.content) { return $false }
  return $true
}

function Get-AppWindowCandidates([object]$Binding, [string]$WindowId) {
  if ($Binding -and $Binding.windowId) {
    try {
      $current = Get-AppWindowCandidate ([IntPtr]([long]$Binding.windowId))
      if (Test-SameAppWindowIdentity $Binding $current) {
        return [pscustomobject]@{ candidates = @($current); truncated = $false; reused = $true }
      }
    } catch {}
  } elseif ($WindowId) {
    try { $current = Get-AppWindowCandidate ([IntPtr]([long]$WindowId)) } catch { $current = $null }
    return [pscustomobject]@{ candidates = @($current | Where-Object { $null -ne $_ }); truncated = $false; reused = $false }
  }
  $root = [System.Windows.Automation.AutomationElement]::RootElement
  $windows = $root.FindAll([System.Windows.Automation.TreeScope]::Children, [System.Windows.Automation.Condition]::TrueCondition)
  $candidates = [System.Collections.Generic.List[object]]::new()
  $limit = [Math]::Min(256, $windows.Count)
  for ($index = 0; $index -lt $limit; $index += 1) {
    try {
      $candidate = Get-AppWindowCandidate ([IntPtr]$windows[$index].Current.NativeWindowHandle)
      if ($null -ne $candidate) { $candidates.Add($candidate) }
    } catch {}
  }
  return [pscustomobject]@{ candidates = $candidates.ToArray(); truncated = ($windows.Count -gt $limit); reused = $false }
}

function Get-VerifiedAppWindow([object]$Target) {
  if ($null -eq $Target -or -not $Target.windowId) { throw 'APP_TARGET_STALE: an explicit resolved application target is required.' }
  $current = Get-AppWindowCandidate ([IntPtr]([long]$Target.windowId))
  if (-not (Test-SameAppWindowIdentity $Target $current)) { throw 'APP_TARGET_STALE: application window/process/package identity changed.' }
  return [pscustomobject]@{
    Element = [System.Windows.Automation.AutomationElement]::FromHandle([IntPtr]([long]$Target.windowId))
    Process = (Get-Process -Id ([int]$Target.processId) -ErrorAction Stop)
    Identity = $Target
  }
}
