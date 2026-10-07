param([Parameter(Mandatory=$true)][string]$OutputPath, [switch]$CompileOnly)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
. (Join-Path $PSScriptRoot '../../src/computer/windows-graphics-capture.ps1')
$receipt = [ordered]@{ compiled = $false; nativePixels = $false; processId = $PID; cases = @(); cleanup = @() }
$target = $null; $occluder = $null
$targetHandle = [IntPtr]::Zero; $otherHandle = [IntPtr]::Zero
$failed = $false
try {
  $initializationClock = [System.Diagnostics.Stopwatch]::StartNew()
  Initialize-RelaiWgc
  $initializationClock.Stop()
  $receipt.providerInitializationMs = $initializationClock.ElapsedMilliseconds
  $receipt.compiled = $true
  if (-not $CompileOnly) {
    Add-Type -ReferencedAssemblies System.Windows.Forms,System.Drawing -TypeDefinition @'
using System;
using System.Drawing;
using System.Windows.Forms;
using System.Runtime.InteropServices;
public class RelaiNoPrintFixture : Form {
  public int Phase = 0;
  public int PrintRequests = 0;
  public bool Black = false;
  public bool Occluder = false;
  protected override bool ShowWithoutActivation { get { return true; } }
  protected override CreateParams CreateParams {
    get { var value = base.CreateParams; value.ExStyle |= 0x08000000; return value; }
  }
  protected override void WndProc(ref Message message) {
    if (message.Msg == 0x0317 || message.Msg == 0x0318) {
      PrintRequests++; message.Result = new IntPtr(1); return;
    }
    base.WndProc(ref message);
  }
  protected override void OnPaint(PaintEventArgs args) {
    Color fill = Black ? Color.Black : (Occluder ? Color.FromArgb(20,210,30) :
      (Phase == 0 ? Color.FromArgb(210,20,30) : Color.FromArgb(30,180,190)));
    args.Graphics.Clear(fill);
    if (!Black) {
      using (var brush = new SolidBrush(Color.FromArgb(25,40,220)))
        args.Graphics.FillRectangle(brush, ClientSize.Width-48, ClientSize.Height-48, 48, 48);
      using (var font = new Font("Arial", 24, FontStyle.Bold))
        args.Graphics.DrawString(Occluder ? "OTHERONLY" : ("APPONLY " + Phase), font, Brushes.White, 15, 15);
    }
  }
}
public static class RelaiWgcFixtureNative {
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr hwnd, IntPtr hdc, uint flags);
  [DllImport("user32.dll")] public static extern IntPtr SendMessage(IntPtr hwnd, uint message, IntPtr wparam, IntPtr lparam);
  [DllImport("user32.dll")] public static extern bool SetWindowDisplayAffinity(IntPtr hwnd, uint affinity);
}
'@
    $area = [System.Windows.Forms.Screen]::PrimaryScreen.WorkingArea
    $target = [RelaiNoPrintFixture]::new()
    $target.Text = 'RelAI owned WGC no-print fixture'
    $target.FormBorderStyle = [System.Windows.Forms.FormBorderStyle]::None
    $target.StartPosition = [System.Windows.Forms.FormStartPosition]::Manual
    $target.Location = [System.Drawing.Point]::new($area.Left + 70, $area.Top + 90)
    $target.ClientSize = [System.Drawing.Size]::new(340, 200)
    $target.ShowInTaskbar = $false
    $target.TopMost = $true
    $target.Show()
    $target.Refresh()
    [System.Windows.Forms.Application]::DoEvents()
    $targetHandle = $target.Handle
    # Record PrintWindow separately: newer Windows may obtain compositor pixels
    # without sending WM_PRINT. Then prove the owned WndProc ignores WM_PRINT.
    $probe = [System.Drawing.Bitmap]::new(340,200)
    $graphics = [System.Drawing.Graphics]::FromImage($probe)
    $graphics.Clear([System.Drawing.Color]::Magenta)
    $dc = $graphics.GetHdc()
    try { $printResult = [RelaiWgcFixtureNative]::PrintWindow($targetHandle,$dc,0) }
    finally { $graphics.ReleaseHdc($dc); $graphics.Dispose() }
    $unchanged = $probe.GetPixel(170,100)
    $probe.Dispose()
    $receipt.printWindowObserved = [pscustomobject]@{ returned = $printResult; messages = $target.PrintRequests; rgb = @($unchanged.R,$unchanged.G,$unchanged.B) }
    $probe = [System.Drawing.Bitmap]::new(340,200)
    $graphics = [System.Drawing.Graphics]::FromImage($probe)
    $graphics.Clear([System.Drawing.Color]::Magenta)
    $dc = $graphics.GetHdc()
    try { $null = [RelaiWgcFixtureNative]::SendMessage($targetHandle,0x0317,$dc,[IntPtr](0x06)) }
    finally { $graphics.ReleaseHdc($dc); $graphics.Dispose() }
    $unchanged = $probe.GetPixel(170,100)
    $probe.Dispose()
    $receipt.wmPrintNoOp = $target.PrintRequests -gt 0 -and $unchanged.R -eq 255 -and $unchanged.G -eq 0 -and $unchanged.B -eq 255
    if (-not $receipt.wmPrintNoOp) { throw 'The fixture must prove a WM_PRINT no-op.' }

    function Assert-WgcPixels([string]$Name,[int[]]$Expected,[switch]$Black) {
      $capture = Get-WgcWindowCapture $script:targetHandle 3000
      try {
        $pixel = $capture.Bitmap.GetPixel([int]($capture.Bitmap.Width/2),[int]($capture.Bitmap.Height/2))
        $marker = $capture.Bitmap.GetPixel($capture.Bitmap.Width-10,$capture.Bitmap.Height-10)
        $passed = $pixel.R -eq $Expected[0] -and $pixel.G -eq $Expected[1] -and $pixel.B -eq $Expected[2]
        if (-not $Black) { $passed = $passed -and $marker.R -eq 25 -and $marker.G -eq 40 -and $marker.B -eq 220 }
        $passed = $passed -and $capture.FrameEvidence.windowId -eq $script:targetHandle.ToInt64().ToString() -and
          $capture.FrameEvidence.processId -eq $PID -and $capture.InputMappingReliable -eq $true -and
          [long]$capture.FrameEvidence.frameQpc100ns -ge [long]$capture.FrameEvidence.requestQpc100ns
        $script:receipt.cases += [pscustomobject]@{
          name=$Name; passed=$passed; rgb=@($pixel.R,$pixel.G,$pixel.B)
          width=$capture.Bitmap.Width; height=$capture.Bitmap.Height
          evidence=$capture.FrameEvidence; boundsSource=$capture.BoundsSource
        }
        if (-not $passed) { throw ($Name + ': WGC pixels, source mapping, or frame provenance failed.') }
      } finally { $capture.Bitmap.Dispose() }
    }

    Assert-WgcPixels 'visible-no-print-target' @(210,20,30)
    $occluder = [RelaiNoPrintFixture]::new()
    $occluder.Occluder = $true
    $occluder.Text = 'RelAI owned WGC occluder'
    $occluder.FormBorderStyle = [System.Windows.Forms.FormBorderStyle]::None
    $occluder.StartPosition = [System.Windows.Forms.FormStartPosition]::Manual
    $occluder.Location = $target.Location
    $occluder.ClientSize = $target.ClientSize
    $occluder.ShowInTaskbar = $false
    $occluder.TopMost = $true
    $occluder.Show()
    $occluder.Refresh()
    [System.Windows.Forms.Application]::DoEvents()
    $otherHandle = $occluder.Handle
    Assert-WgcPixels 'occluded-no-print-target' @(210,20,30)
    $target.Phase = 1
    $target.Refresh()
    [System.Windows.Forms.Application]::DoEvents()
    Assert-WgcPixels 'new-phase-under-occlusion' @(30,180,190)
    $target.Black = $true
    $target.Refresh()
    [System.Windows.Forms.Application]::DoEvents()
    Assert-WgcPixels 'legitimate-black-target' @(0,0,0) -Black
    $target.Black = $false
    $target.ClientSize = [System.Drawing.Size]::new(380,220)
    $target.Refresh()
    [System.Windows.Forms.Application]::DoEvents()
    Assert-WgcPixels 'resized-target' @(30,180,190)
    $target.WindowState = [System.Windows.Forms.FormWindowState]::Minimized
    [System.Windows.Forms.Application]::DoEvents()
    $minimized = $false
    try { $unexpected = Get-WgcWindowCapture $targetHandle 1000; $unexpected.Bitmap.Dispose() }
    catch { $minimized = $_.Exception.Message -match 'WGC_SOURCE_CHANGED:' }
    $receipt.cases += [pscustomobject]@{name='minimized-specific-state';passed=$minimized}
    if (-not $minimized) { throw 'Minimized target was not identified accurately.' }
    $target.WindowState = [System.Windows.Forms.FormWindowState]::Normal
    $target.Refresh()
    [System.Windows.Forms.Application]::DoEvents()
    Assert-WgcPixels 'restored-target' @(30,180,190)
    if (-not [RelaiWgcFixtureNative]::SetWindowDisplayAffinity($targetHandle,0x11)) { throw 'Could not set capture protection on the owned fixture.' }
    $denied = $false
    try { $unexpected = Get-WgcWindowCapture $targetHandle 1000; $unexpected.Bitmap.Dispose() }
    catch { $denied = $_.Exception.Message -match 'WGC_DENIED:' }
    $receipt.cases += [pscustomobject]@{name='owned-capture-protection';passed=$denied}
    if (-not $denied) { throw 'Capture-protected fixture must report WGC_DENIED.' }
    $null = [RelaiWgcFixtureNative]::SetWindowDisplayAffinity($targetHandle,0)
    $target.Close()
    [System.Windows.Forms.Application]::DoEvents()
    $closed = $false
    try { $unexpected = Get-WgcWindowCapture $targetHandle 1000; $unexpected.Bitmap.Dispose() }
    catch { $closed = $_.Exception.Message -match 'WGC_SOURCE_CHANGED:' }
    $receipt.cases += [pscustomobject]@{name='closed-owned-window';passed=$closed}
    if (-not $closed) { throw 'Closed fixture must report WGC_SOURCE_CHANGED.' }
    $receipt.nativePixels = $true
  }
} catch {
  $failed = $true
  $receipt.error = $_.Exception.ToString()
  $receipt.position = $_.InvocationInfo.PositionMessage
} finally {
  if ($null -ne $occluder) { $occluder.Close(); $occluder.Dispose() }
  if ($null -ne $target) { $target.Close(); $target.Dispose() }
  [System.Windows.Forms.Application]::DoEvents()
  foreach ($handle in @($targetHandle,$otherHandle)) {
    if ($handle -eq [IntPtr]::Zero) { continue }
    $gone = -not [RelaiWgcNative]::IsWindow($handle)
    $receipt.cleanup += [pscustomobject]@{windowId=$handle.ToInt64().ToString();destroyed=$gone}
    if (-not $gone) { $failed = $true }
  }
  $receipt | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath $OutputPath -Encoding UTF8
}
if ($failed) { exit 1 }
