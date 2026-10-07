param([Parameter(Mandatory=$true)][string]$OutputPath, [switch]$CompileOnly, [string]$DispatchReadyPath, [string]$DispatchStopPath)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
. (Join-Path $PSScriptRoot '../../src/computer/windows-app-capture.ps1')
. (Join-Path $PSScriptRoot '../../src/computer/windows-app-targets.ps1')
function Normalize-Text([object]$Value) { return ([string]$Value).Trim().ToLowerInvariant() }
function Compact-Text([object]$Value) { return (Normalize-Text $Value) -replace '[^a-z0-9]', '' }
$receipt = [ordered]@{ processId = $PID; compiled = $true; nativePixels = $false; cases = @(); cleanup = @() }
if ($CompileOnly) {
  $receipt.mode = 'compile-only'
  $receipt | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $OutputPath -Encoding UTF8
  exit 0
}
# Import the actual helper definitions and OCR initialization, but never run its
# stdin dispatcher. The native helper is already loaded above; omit only that
# duplicate dot-source line because this fixture has a different PSScriptRoot.
$helperPath = Join-Path $PSScriptRoot '../../src/computer/windows-uia-helper.ps1'
$helperSource = [System.IO.File]::ReadAllText($helperPath)
$dispatchAt = $helperSource.IndexOf('while (($line = [Console]::In.ReadLine()) -ne $null)')
if ($dispatchAt -lt 0) { throw 'The fixture could not locate the helper dispatch boundary.' }
$helperLibrary = $helperSource.Substring(0, $dispatchAt).Replace(". (Join-Path `$PSScriptRoot 'windows-app-capture.ps1')", '').Replace(". (Join-Path `$PSScriptRoot 'windows-app-targets.ps1')", '')
. ([ScriptBlock]::Create($helperLibrary))

$target = $null
$occluder = $null
$targetHandle = [IntPtr]::Zero
$occluderHandle = [IntPtr]::Zero
$failed = $false
function Get-FixtureCapture([string]$App, [object]$Match) {
  $watch = [System.Diagnostics.Stopwatch]::StartNew()
  $capture = Get-AppPixelCapture $App $Match
  $capture | Add-Member -NotePropertyName FixtureCaptureMs -NotePropertyValue $watch.ElapsedMilliseconds
  return $capture
}
function Assert-TargetPixels([object]$Capture, [string]$Case) {
  try {
    $width = $Capture.Bitmap.Width
    $height = $Capture.Bitmap.Height
    $red = $Capture.Bitmap.GetPixel([int]($width / 2), [int]($height / 2))
    $blue = $Capture.Bitmap.GetPixel($width - 10, $height - 10)
    $passed = $red.R -eq 210 -and $red.G -eq 20 -and $red.B -eq 30 -and
      $blue.R -eq 25 -and $blue.G -eq 40 -and $blue.B -eq 220
    $script:receipt.cases += [pscustomobject]@{
      name = $Case; passed = $passed; width = $width; height = $height
      method = $Capture.Provenance.method; fallbackReason = $Capture.Provenance.fallbackReason; captureMs = $Capture.FixtureCaptureMs
      centerRgb = @($red.R, $red.G, $red.B); markerRgb = @($blue.R, $blue.G, $blue.B)
      sourceWindow = $Capture.Provenance.windowId; sourceProcess = $Capture.Provenance.processId
    }
    if (-not $passed) { throw "$Case did not return the synthetic target's red and blue marker pixels." }
    if ($Capture.Provenance.windowId -ne $script:targetHandle.ToInt64().ToString() -or $Capture.Provenance.processId -ne $PID) {
      throw 'Capture provenance did not match the explicitly owned fixture window.'
    }
  } finally { $Capture.Bitmap.Dispose() }
}
try {
  $target = [System.Windows.Forms.Form]::new()
  $target.Text = 'RelAI synthetic target only'
  $target.FormBorderStyle = [System.Windows.Forms.FormBorderStyle]::None
  $target.StartPosition = [System.Windows.Forms.FormStartPosition]::Manual
  $area = [System.Windows.Forms.Screen]::PrimaryScreen.WorkingArea
  $target.Location = [System.Drawing.Point]::new($area.Left + 40, $area.Top + 80)
  $target.ClientSize = [System.Drawing.Size]::new(320, 180)
  $target.BackColor = [System.Drawing.Color]::FromArgb(210, 20, 30)
  $marker = [System.Windows.Forms.Panel]::new()
  $marker.Size = [System.Drawing.Size]::new(64, 64)
  $marker.Location = [System.Drawing.Point]::new(256, 116)
  $marker.BackColor = [System.Drawing.Color]::FromArgb(25, 40, 220)
  $marker.Anchor = [System.Windows.Forms.AnchorStyles]::Right -bor [System.Windows.Forms.AnchorStyles]::Bottom
  $target.Controls.Add($marker)
  $textLabel = [System.Windows.Forms.Label]::new()
  $textLabel.Text = 'APPONLY'
  $textLabel.Location = [System.Drawing.Point]::new(20, 20)
  $textLabel.Size = [System.Drawing.Size]::new(260, 50)
  $textLabel.Font = [System.Drawing.Font]::new('Arial', 28, [System.Drawing.FontStyle]::Bold)
  $textLabel.BackColor = [System.Drawing.Color]::White
  $textLabel.ForeColor = [System.Drawing.Color]::Black
  $target.Controls.Add($textLabel)
  $target.TopMost = $true
  $target.Show()
  [System.Windows.Forms.Application]::DoEvents()
  $targetHandle = $target.Handle
  $ownProcess = Get-Process -Id $PID
  $match = [pscustomobject]@{
    Element = [System.Windows.Automation.AutomationElement]::FromHandle($targetHandle)
    Process = $ownProcess
  }
  # Explicit HWND metadata path only: never enumerate user windows.
  $discovery = Get-AppWindowCandidates $null $targetHandle.ToInt64().ToString()
  if (@($discovery.candidates).Count -ne 1 -or $discovery.candidates[0].processId -ne $PID) { throw 'Explicit owned target identity resolution failed.' }
  $ownedIdentity = $discovery.candidates[0]
  $match | Add-Member -NotePropertyName Identity -NotePropertyValue $ownedIdentity
  $verifiedMatch = Get-VerifiedAppWindow $ownedIdentity
  if ($verifiedMatch.Process.Id -ne $PID) { throw 'Canonical verification did not preserve fixture ownership.' }
  $reused = Get-AppWindowCandidates $ownedIdentity ''
  if (-not $reused.reused -or $reused.candidates[0].windowId -ne $ownedIdentity.windowId) { throw 'Pinned target reuse failed.' }
  $receipt.cases += [pscustomobject]@{ name = 'explicit-owned-identity-and-binding'; passed = $true; processName = $ownedIdentity.processName }
  Assert-TargetPixels (Get-FixtureCapture 'Synthetic friendly product alias' $match) 'verified-identity-alias-capture'
  # No root-window enumeration: capture only this process's explicit fixture HWND.
  $visibleCapture = Get-FixtureCapture $ownProcess.ProcessName $match
  $inputTarget = [pscustomobject]@{
    provenance = $visibleCapture.Provenance; width = $visibleCapture.Bitmap.Width; height = $visibleCapture.Bitmap.Height
    points = @([pscustomobject]@{ x = $visibleCapture.Provenance.originX + 160; y = $visibleCapture.Provenance.originY + 90 })
    requiresFocus = $false
  }
  Assert-TargetPixels $visibleCapture 'visible-control'
  $visibleInput = Assert-AppInputTarget $ownProcess.ProcessName $inputTarget
  $receipt.inputGuards = [ordered]@{ visiblePointer = ($visibleInput.verified -eq $true) }
  $occluder = [System.Windows.Forms.Form]::new()
  $occluder.Text = 'RelAI synthetic occluder only'
  $occluder.FormBorderStyle = [System.Windows.Forms.FormBorderStyle]::None
  $occluder.StartPosition = [System.Windows.Forms.FormStartPosition]::Manual
  $occluder.Location = $target.Location
  $occluder.ClientSize = $target.ClientSize
  $occluder.BackColor = [System.Drawing.Color]::FromArgb(20, 210, 30)
  $occluder.TopMost = $true
  $otherLabel = [System.Windows.Forms.Label]::new()
  $otherLabel.Text = 'OTHERONLY'
  $otherLabel.Location = [System.Drawing.Point]::new(20, 20)
  $otherLabel.Size = [System.Drawing.Size]::new(290, 50)
  $otherLabel.Font = [System.Drawing.Font]::new('Arial', 28, [System.Drawing.FontStyle]::Bold)
  $otherLabel.BackColor = [System.Drawing.Color]::White
  $otherLabel.ForeColor = [System.Drawing.Color]::Black
  $occluder.Controls.Add($otherLabel)
  $occluder.Show()
  [System.Windows.Forms.Application]::DoEvents()
  $occluderHandle = $occluder.Handle
  if ($DispatchReadyPath) {
    # Paint text without an accessibility label so the real hybrid observation
    # must read it through OCR, still confined to this explicit owned HWND.
    $target.Controls.Remove($textLabel)
    $textLabel.Dispose()
    $script:dispatchFont = [System.Drawing.Font]::new('Arial', 28, [System.Drawing.FontStyle]::Bold)
    $target.Add_Paint({
      param($sender, $eventArgs)
      $eventArgs.Graphics.FillRectangle([System.Drawing.Brushes]::White, 20, 20, 260, 50)
      $eventArgs.Graphics.DrawString('APPONLY', $script:dispatchFont, [System.Drawing.Brushes]::Black, 20, 20)
    })
    $target.Refresh()
    [System.Windows.Forms.Application]::DoEvents()
    [pscustomobject]@{ windowId = $targetHandle.ToInt64().ToString(); processId = $PID; app = $ownProcess.ProcessName; title = $target.Text; occluderWindowId = $occluderHandle.ToInt64().ToString() } |
      ConvertTo-Json -Compress | Set-Content -LiteralPath $DispatchReadyPath -Encoding UTF8
    $until = [DateTime]::UtcNow.AddSeconds(18)
    while (-not (Test-Path -LiteralPath $DispatchStopPath)) {
      if ([DateTime]::UtcNow -gt $until) { throw 'Owned dispatch fixture exceeded its 18-second lifetime.' }
      [System.Windows.Forms.Application]::DoEvents()
      Start-Sleep -Milliseconds 10
    }
    $receipt.mode = 'dispatch-bridge'
    return
  }
  Assert-TargetPixels (Get-FixtureCapture $ownProcess.ProcessName $match) 'fully-occluded-target'
  $occlusionBlocked = $false
  try { $null = Assert-AppInputTarget $ownProcess.ProcessName $inputTarget } catch { $occlusionBlocked = [string]$_.Exception.Message -match 'occluded' }
  $receipt.inputGuards.occludedPointerBlocked = $occlusionBlocked
  if (-not $occlusionBlocked) { throw 'Occluded target must fail pre-input ownership validation.' }
  $inputTarget.requiresFocus = $true
  $focusBlocked = $false
  try { $null = Assert-AppInputTarget $ownProcess.ProcessName $inputTarget } catch { $focusBlocked = [string]$_.Exception.Message -match 'not foreground' }
  $receipt.inputGuards.occludedFocusBlocked = $focusBlocked
  if (-not $focusBlocked) { throw 'An observation cannot authorize keyboard input to another foreground window.' }
  $inputTarget.requiresFocus = $false
  $ocrTargets = @(Get-OcrTargets $ownProcess.ProcessName $match 120)
  $ocrText = (@($ocrTargets | ForEach-Object { $_.name }) -join ' ')
  $normalizedOcr = $ocrText -replace '[^A-Za-z]', ''
  if ($script:OcrAvailable) {
    $ocrPassed = $normalizedOcr.Contains('APPONLY') -and -not $normalizedOcr.Contains('OTHERONLY') -and
      $script:OcrProvenance.windowId -eq $targetHandle.ToInt64().ToString() -and $script:OcrProvenance.processId -eq $PID
    $receipt.ocr = [pscustomobject]@{ available = $true; passed = $ocrPassed; text = $ocrText; error = $script:OcrError; sourceWindow = $script:OcrProvenance.windowId; sourceProcess = $script:OcrProvenance.processId }
    if (-not $ocrPassed) { throw 'OCR did not read only the explicit synthetic target under occlusion.' }
  } else {
    $receipt.ocr = [pscustomobject]@{ available = $false; passed = ($ocrTargets.Count -eq 0); outcome = 'unavailable-fail-closed'; reason = $script:OcrError }
    if ($ocrTargets.Count -ne 0) { throw 'Unavailable OCR returned unproven targets.' }
  }
  $originalLocation = $target.Location
  $target.Location = [System.Drawing.Point]::new($originalLocation.X + 4, $originalLocation.Y)
  [System.Windows.Forms.Application]::DoEvents()
  $geometryBlocked = $false
  try { $null = Assert-AppInputTarget $ownProcess.ProcessName $inputTarget } catch { $geometryBlocked = [string]$_.Exception.Message -match 'moved|resized|changed displays' }
  $receipt.inputGuards.staleGeometryBlocked = $geometryBlocked
  if (-not $geometryBlocked) { throw 'Moved target must fail stale observation geometry validation.' }
  $target.Location = $originalLocation
  [System.Windows.Forms.Application]::DoEvents()
  $oldStart = $inputTarget.provenance.processStartedAt
  $inputTarget.provenance.processStartedAt = '1'
  $identityBlocked = $false
  try { $null = Assert-AppInputTarget $ownProcess.ProcessName $inputTarget } catch { $identityBlocked = [string]$_.Exception.Message -match 'identity changed' }
  $inputTarget.provenance.processStartedAt = $oldStart
  $receipt.inputGuards.staleIdentityBlocked = $identityBlocked
  if (-not $identityBlocked) { throw 'Changed process identity must fail input validation.' }
  $target.WindowState = [System.Windows.Forms.FormWindowState]::Minimized
  [System.Windows.Forms.Application]::DoEvents()
  $minimizedRejected = $false
  try {
    $unexpected = Get-FixtureCapture $ownProcess.ProcessName $match
    $unexpected.Bitmap.Dispose()
  } catch {
    $receipt.minimizedReason = [string]$_.Exception.Message
    $minimizedRejected = $receipt.minimizedReason -match 'hidden|minimized|stale'
  }
  $receipt.cases += [pscustomobject]@{ name = 'minimized-fails-closed'; passed = $minimizedRejected }
  if (-not $minimizedRejected) { throw 'Minimized synthetic target did not fail closed.' }
  $target.WindowState = [System.Windows.Forms.FormWindowState]::Normal
  [System.Windows.Forms.Application]::DoEvents()
  $savedProvider = (Get-Item Function:Get-WgcWindowCapture).ScriptBlock
  try {
    Set-Item Function:Get-WgcWindowCapture -Value { param([IntPtr]$Hwnd, [int]$TimeoutMs) throw 'WGC_UNAVAILABLE: controlled fixture provider unavailable' }
    $legacy = Get-FixtureCapture $ownProcess.ProcessName $match
    if ($legacy.Provenance.method -ne 'win32-print-window' -or $legacy.Provenance.fallbackReason -ne 'compositor-unavailable') { $legacy.Bitmap.Dispose(); throw 'Known-unavailable provider did not use the declared app-owned fallback.' }
    Assert-TargetPixels $legacy 'known-unavailable-owner-rendered-fallback'
    Set-Item Function:Get-WgcWindowCapture -Value { param([IntPtr]$Hwnd, [int]$TimeoutMs) throw 'WGC_DENIED: controlled fixture denied' }
    $denied = $false
    try { $unexpected = Get-FixtureCapture $ownProcess.ProcessName $match; $unexpected.Bitmap.Dispose() } catch { $denied = [string]$_.Exception.Message -match 'APP_CAPTURE_DENIED' }
    $receipt.cases += [pscustomobject]@{ name = 'denial-does-not-switch-provider'; passed = $denied }
    if (-not $denied) { throw 'Provider denial was not terminal.' }
  } finally { Set-Item Function:Get-WgcWindowCapture -Value $savedProvider }
  $receipt.nativePixels = $true
} catch {
  $failed = $true
  $receipt.error = [string]$_.Exception.Message
} finally {
  if ($null -ne $script:dispatchFont) { $script:dispatchFont.Dispose() }
  if ($null -ne $occluder) { $occluder.Close(); $occluder.Dispose() }
  if ($null -ne $target) { $target.Close(); $target.Dispose() }
  [System.Windows.Forms.Application]::DoEvents()
  foreach ($handle in @($targetHandle, $occluderHandle)) {
    if ($handle -eq [IntPtr]::Zero) { continue }
    $gone = -not [RelaiAppCaptureNative]::IsWindow($handle)
    $receipt.cleanup += [pscustomobject]@{ windowId = $handle.ToInt64().ToString(); destroyed = $gone }
    if (-not $gone) { $failed = $true }
  }
  $receipt | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $OutputPath -Encoding UTF8
}
if ($failed) { exit 1 }
