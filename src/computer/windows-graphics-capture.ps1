# HWND-scoped Windows Graphics Capture. No source enumeration or input.
# Caller owns application approval and must revalidate its identity contract.
# Native/driver calls are also bounded by the caller's helper-process deadline.
function Initialize-RelaiWgc {
  if ($script:RelaiWgcInitialized) { return }
  Add-Type -AssemblyName System.Runtime.WindowsRuntime
  Add-Type -AssemblyName Microsoft.CSharp
  Add-Type -AssemblyName System.Drawing
  $null = [Windows.Graphics.Capture.GraphicsCaptureItem,Windows.Graphics.Capture,ContentType=WindowsRuntime]
  $null = [Windows.Graphics.Capture.GraphicsCaptureSession,Windows.Graphics.Capture,ContentType=WindowsRuntime]
  $null = [Windows.Graphics.Capture.Direct3D11CaptureFramePool,Windows.Graphics.Capture,ContentType=WindowsRuntime]
  $null = [Windows.Graphics.DirectX.Direct3D11.IDirect3DDevice,Windows.Graphics,ContentType=WindowsRuntime]
  $null = [Windows.Graphics.DirectX.DirectXPixelFormat,Windows.Graphics,ContentType=WindowsRuntime]
  $null = [Windows.Graphics.Imaging.SoftwareBitmap,Windows.Graphics.Imaging,ContentType=WindowsRuntime]
  $null = [Windows.Storage.Streams.Buffer,Windows.Storage.Streams,ContentType=WindowsRuntime]
  $null = [Windows.Storage.Streams.DataReader,Windows.Storage.Streams,ContentType=WindowsRuntime]
  $null = [Windows.Foundation.Metadata.ApiInformation,Windows.Foundation,ContentType=WindowsRuntime]
  if (-not [Windows.Foundation.Metadata.ApiInformation]::IsApiContractPresent('Windows.Foundation.UniversalApiContract', 8) -or
      -not [Windows.Foundation.Metadata.ApiInformation]::IsMethodPresent('Windows.Graphics.Capture.Direct3D11CaptureFramePool', 'CreateFreeThreaded') -or
      -not [Windows.Graphics.Capture.GraphicsCaptureSession]::IsSupported()) {
    throw 'WGC_UNAVAILABLE: Window capture is not supported by this Windows session.'
  }
  if (-not ('RelaiWgcNative' -as [type])) {
    # Use metadata already supplied by Windows, not SDK/NuGet installations.
    $references = @([Windows.Graphics.Capture.GraphicsCaptureItem].Assembly.Location,
      [Windows.Foundation.Metadata.ApiInformation].Assembly.Location,
      [System.WindowsRuntimeSystemExtensions].Assembly.Location) | Select-Object -Unique
    $nativeSource = @'
using System;
using System.Runtime.InteropServices;
using System.Runtime.InteropServices.WindowsRuntime;
using Windows.Graphics;
using Windows.Graphics.Capture;
using Windows.Graphics.DirectX;
using Windows.Graphics.DirectX.Direct3D11;
using Windows.Graphics.Imaging;
public static class RelaiWgcNative {
  [StructLayout(LayoutKind.Sequential)]
  public struct Rect { public int Left, Top, Right, Bottom; }
  [ComImport, Guid("3628E81B-3CAC-4C60-B7F4-23CE0E0C3356"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  private interface ICaptureItemInterop {
    [PreserveSig] int CreateForWindow(IntPtr window, ref Guid iid, out IntPtr item);
  }
  [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr hwnd);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hwnd);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hwnd);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint processId);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hwnd, out Rect rect);
  [DllImport("user32.dll")] public static extern bool GetWindowDisplayAffinity(IntPtr hwnd, out uint affinity);
  [DllImport("user32.dll")] public static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);
  [DllImport("dwmapi.dll", EntryPoint="DwmGetWindowAttribute")]
  public static extern int GetFrameBounds(IntPtr hwnd, uint attribute, out Rect rect, int size);
  [DllImport("dwmapi.dll", EntryPoint="DwmGetWindowAttribute")]
  public static extern int GetWindowAttribute(IntPtr hwnd, uint attribute, out uint value, int size);
  [DllImport("d3d11.dll", CallingConvention=CallingConvention.StdCall)]
  private static extern int D3D11CreateDevice(IntPtr adapter, uint driverType, IntPtr software, uint flags,
    IntPtr levels, uint levelCount, uint sdkVersion, out IntPtr device, out uint level, out IntPtr context);
  [DllImport("d3d11.dll", CallingConvention=CallingConvention.StdCall)]
  private static extern int CreateDirect3D11DeviceFromDXGIDevice(IntPtr dxgi, out IntPtr inspectable);
  public static object CreateCaptureItem(Type captureType, IntPtr hwnd) {
    object factory = WindowsRuntimeMarshal.GetActivationFactory(captureType);
    var interop = (ICaptureItemInterop)factory;
    Guid iid = new Guid("79C3F95B-31F7-4EC2-A464-632EF5D30760");
    IntPtr pointer = IntPtr.Zero;
    try {
      Marshal.ThrowExceptionForHR(interop.CreateForWindow(hwnd, ref iid, out pointer));
      if (pointer == IntPtr.Zero) throw new InvalidOperationException("WGC_UNAVAILABLE: Empty capture item.");
      return Marshal.GetObjectForIUnknown(pointer);
    } finally { if (pointer != IntPtr.Zero) Marshal.Release(pointer); }
  }
  public static object CreateFramePool(object device, object size) {
    // The CLR performs WinRT QueryInterface here. PowerShell's general-purpose
    // conversion of System.__ComObject to a WinRT interface does not do so.
    return Direct3D11CaptureFramePool.CreateFreeThreaded((IDirect3DDevice)device,
      DirectXPixelFormat.B8G8R8A8UIntNormalized, 2, (SizeInt32)size);
  }
  public static object CopyFrame(object frame) {
    return SoftwareBitmap.CreateCopyFromSurfaceAsync(((Direct3D11CaptureFrame)frame).Surface);
  }
  public static void CloseDevice(object device) {
    ((IDisposable)(IDirect3DDevice)device).Dispose();
  }
  public static object CreateDevice() {
    IntPtr device = IntPtr.Zero, context = IntPtr.Zero, dxgi = IntPtr.Zero, projected = IntPtr.Zero;
    uint level;
    try {
      // D3D11_CREATE_DEVICE_BGRA_SUPPORT; do not require the optional debug layer.
      int result = D3D11CreateDevice(IntPtr.Zero, 1, IntPtr.Zero, 0x20, IntPtr.Zero, 0, 7, out device, out level, out context);
      if (result < 0 && result != unchecked((int)0x80070005)) {
        // This is device creation only, before any target capture or permission
        // decision. WARP supports sessions without a usable hardware device.
        if (context != IntPtr.Zero) { Marshal.Release(context); context = IntPtr.Zero; }
        if (device != IntPtr.Zero) { Marshal.Release(device); device = IntPtr.Zero; }
        result = D3D11CreateDevice(IntPtr.Zero, 5, IntPtr.Zero, 0x20, IntPtr.Zero, 0, 7, out device, out level, out context);
      }
      Marshal.ThrowExceptionForHR(result);
      Guid iid = new Guid("54ec77fa-1377-44e6-8c32-88fd5f44c84c");
      Marshal.ThrowExceptionForHR(Marshal.QueryInterface(device, ref iid, out dxgi));
      Marshal.ThrowExceptionForHR(CreateDirect3D11DeviceFromDXGIDevice(dxgi, out projected));
      return Marshal.GetObjectForIUnknown(projected);
    } finally {
      if (projected != IntPtr.Zero) Marshal.Release(projected);
      if (dxgi != IntPtr.Zero) Marshal.Release(dxgi);
      if (context != IntPtr.Zero) Marshal.Release(context);
      if (device != IntPtr.Zero) Marshal.Release(device);
    }
  }
}
'@
    # Add-Type treats WinMD paths as assembly names on some PowerShell 5 hosts.
    # Its built-in CodeDom compiler accepts explicit metadata file references.
    $compiler = [Microsoft.CSharp.CSharpCodeProvider]::new()
    try {
      $parameters = [System.CodeDom.Compiler.CompilerParameters]::new()
      $parameters.GenerateInMemory = $true
      $parameters.GenerateExecutable = $false
      $null = $parameters.ReferencedAssemblies.Add('System.dll')
      foreach ($reference in $references) {
        $resolvedReference = [System.IO.Path]::GetFullPath($reference)
        if (-not [System.IO.File]::Exists($resolvedReference)) { throw ('WGC_UNAVAILABLE: Installed WinRT metadata is missing: ' + $resolvedReference) }
        $null = $parameters.ReferencedAssemblies.Add($resolvedReference)
      }
      $runtimeFacade = [System.Reflection.Assembly]::Load('System.Runtime, Version=4.0.0.0, Culture=neutral, PublicKeyToken=b03f5f7f11d50a3a')
      $null = $parameters.ReferencedAssemblies.Add($runtimeFacade.Location)
      $facades = Join-Path ([System.Runtime.InteropServices.RuntimeEnvironment]::GetRuntimeDirectory()) 'Facades'
      foreach ($name in @('System.Runtime.dll', 'System.Runtime.InteropServices.WindowsRuntime.dll')) {
        $reference = Join-Path $facades $name
        if ([System.IO.File]::Exists($reference)) { $null = $parameters.ReferencedAssemblies.Add($reference) }
      }
      $compiled = $compiler.CompileAssemblyFromSource($parameters, $nativeSource)
      if ($compiled.Errors.HasErrors) {
        $details = (@($compiled.Errors | Where-Object { -not $_.IsWarning } | ForEach-Object { $_.ErrorText }) -join '; ')
        throw ('WGC_FAILED: Native projection compilation failed: ' + $details)
      }
      $null = $compiled.CompiledAssembly
    } finally { $compiler.Dispose() }
  }
  $script:RelaiWgcAsTask = @([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
    $_.Name -eq 'AsTask' -and $_.IsGenericMethodDefinition -and $_.GetGenericArguments().Count -eq 1 -and
    $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation' + [char]96 + '1'
  })[0]
  if ($null -eq $script:RelaiWgcAsTask) { throw 'WGC_UNAVAILABLE: WinRT async projection is missing.' }
  $script:RelaiWgcInitialized = $true
}

function Get-RelaiWgcSourceState([IntPtr]$Hwnd) {
  if ($Hwnd -eq [IntPtr]::Zero -or -not [RelaiWgcNative]::IsWindow($Hwnd) -or
      -not [RelaiWgcNative]::IsWindowVisible($Hwnd) -or [RelaiWgcNative]::IsIconic($Hwnd)) {
    throw 'WGC_SOURCE_CHANGED: Window is hidden, minimized, or closed.'
  }
  $ownerId = [uint32]0
  if ([RelaiWgcNative]::GetWindowThreadProcessId($Hwnd, [ref]$ownerId) -eq 0 -or $ownerId -eq 0) {
    throw 'WGC_SOURCE_CHANGED: Window owner is unavailable.'
  }
  $affinity = [uint32]0
  if ([RelaiWgcNative]::GetWindowDisplayAffinity($Hwnd, [ref]$affinity) -and $affinity -ne 0) {
    throw 'WGC_DENIED: The application has protected this window from capture.'
  }
  $cloaked = [uint32]0
  if ([RelaiWgcNative]::GetWindowAttribute($Hwnd, 14, [ref]$cloaked, 4) -eq 0 -and $cloaked -ne 0) {
    throw 'WGC_SOURCE_CHANGED: Window is cloaked.'
  }
  $window = [RelaiWgcNative+Rect]::new()
  if (-not [RelaiWgcNative]::GetWindowRect($Hwnd, [ref]$window)) {
    throw 'WGC_SOURCE_CHANGED: Window bounds are unavailable.'
  }
  $frame = [RelaiWgcNative+Rect]::new()
  $boundsSource = 'dwm-extended-frame'
  if ([RelaiWgcNative]::GetFrameBounds($Hwnd, 9, [ref]$frame, 16) -ne 0 -or
      $frame.Right -le $frame.Left -or $frame.Bottom -le $frame.Top) {
    $frame = $window
    $boundsSource = 'win32-window'
  }
  $owner = Get-Process -Id $ownerId -ErrorAction Stop
  return [pscustomobject]@{
    ProcessId = [int]$ownerId
    ProcessStartedAt = $owner.StartTime.ToUniversalTime().Ticks.ToString()
    Bounds = [System.Drawing.Rectangle]::FromLTRB($frame.Left, $frame.Top, $frame.Right, $frame.Bottom)
    WindowBounds = [System.Drawing.Rectangle]::FromLTRB($window.Left, $window.Top, $window.Right, $window.Bottom)
    BoundsSource = $boundsSource
  }
}

function Get-RelaiWgcRemaining([System.Diagnostics.Stopwatch]$Clock, [int]$TimeoutMs) {
  $remaining = $TimeoutMs - [int]$Clock.ElapsedMilliseconds
  if ($remaining -le 0) { throw 'WGC_TIMEOUT: No fresh window frame arrived before the capture deadline.' }
  return $remaining
}

function Wait-RelaiWgcOperation([object]$Operation, [type]$ResultType, [System.Diagnostics.Stopwatch]$Clock, [int]$TimeoutMs) {
  $task = $script:RelaiWgcAsTask.MakeGenericMethod($ResultType).Invoke($null, @($Operation))
  $remaining = Get-RelaiWgcRemaining $Clock $TimeoutMs
  if (-not $task.Wait($remaining)) {
    try { $Operation.Cancel() } catch {}
    # Keep the checked-out frame alive until the copy settles. If Windows never
    # settles cancellation, the caller must kill/reap this owned helper at its
    # complete-call deadline. Never reuse or publish an in-flight surface.
    try {
      $lateResult = $task.GetAwaiter().GetResult()
      if ($null -ne $lateResult) { $lateResult.Dispose() }
    } catch {
      $failure = $_.Exception
      $wasCanceled = $false
      while ($null -ne $failure) {
        if ($failure -is [System.OperationCanceledException]) { $wasCanceled = $true }
        $failure = $failure.InnerException
      }
      if (-not $wasCanceled) { throw }
    }
    throw 'WGC_TIMEOUT: Window pixel transfer exceeded the capture deadline.'
  }
  return $task.GetAwaiter().GetResult()
}

function Get-WgcWindowCapture([IntPtr]$Hwnd, [int]$TimeoutMs = 1500) {
  if ($TimeoutMs -lt 100 -or $TimeoutMs -gt 3000) { throw 'WGC_UNAVAILABLE: Capture timeout must be between 100 and 3000 milliseconds.' }
  $clock = [System.Diagnostics.Stopwatch]::StartNew()
  $device = $null; $item = $null; $pool = $null; $session = $null; $frame = $null
  $software = $null; $converted = $null; $reader = $null; $bitmap = $null; $locked = $null
  $previousDpi = [IntPtr]::Zero
  try {
    Initialize-RelaiWgc
    $initializationMs = $clock.ElapsedMilliseconds
    $previousDpi = [RelaiWgcNative]::SetThreadDpiAwarenessContext([IntPtr](-4))
    if ($previousDpi -eq [IntPtr]::Zero) { throw 'WGC_UNAVAILABLE: Physical window coordinates are unavailable.' }
    $before = Get-RelaiWgcSourceState $Hwnd
    $device = [RelaiWgcNative]::CreateDevice()
    $item = [Windows.Graphics.Capture.GraphicsCaptureItem][RelaiWgcNative]::CreateCaptureItem(
      [Windows.Graphics.Capture.GraphicsCaptureItem], $Hwnd)
    $size = $item.Size
    if ($size.Width -le 0 -or $size.Height -le 0 -or $size.Width -gt 8192 -or $size.Height -gt 8192 -or
        ([long]$size.Width * $size.Height) -gt 16777216) { throw 'WGC_UNAVAILABLE: Capture dimensions exceed the pixel limit.' }
    $pool = [RelaiWgcNative]::CreateFramePool($device, $size)
    $session = $pool.CreateCaptureSession($item)
    if ([Windows.Foundation.Metadata.ApiInformation]::IsPropertyPresent('Windows.Graphics.Capture.GraphicsCaptureSession', 'IsCursorCaptureEnabled')) {
      $session.IsCursorCaptureEnabled = $false
    }
    if ([Windows.Foundation.Metadata.ApiInformation]::IsPropertyPresent('Windows.Graphics.Capture.GraphicsCaptureSession', 'IncludeSecondaryWindows')) {
      $session.IncludeSecondaryWindows = $false
    }
    # QPC and TimeSpan use different units. Preserve compositor evidence honestly.
    $requestQpc = [long]([decimal][System.Diagnostics.Stopwatch]::GetTimestamp() * 10000000 / [System.Diagnostics.Stopwatch]::Frequency)
    $frameWaitStartedMs = $clock.ElapsedMilliseconds
    $session.StartCapture()
    while ($null -eq $frame) {
      $remaining = Get-RelaiWgcRemaining $clock $TimeoutMs
      $candidate = $pool.TryGetNextFrame()
      if ($null -ne $candidate) {
        if ($candidate.SystemRelativeTime.Ticks -ge $requestQpc) { $frame = $candidate }
        else { $candidate.Dispose() }
      } else { [System.Threading.Thread]::Sleep([Math]::Min(10, $remaining)) }
    }
    $frameWaitMs = $clock.ElapsedMilliseconds - $frameWaitStartedMs
    $copyStartedMs = $clock.ElapsedMilliseconds
    $content = $frame.ContentSize
    if ($content.Width -le 0 -or $content.Height -le 0 -or $content.Width -gt $size.Width -or $content.Height -gt $size.Height) {
      throw 'WGC_SOURCE_CHANGED: Window resized beyond the capture surface; retry this HWND after revalidation.'
    }
    $frameQpc = $frame.SystemRelativeTime.Ticks
    $software = Wait-RelaiWgcOperation ([RelaiWgcNative]::CopyFrame($frame)) ([Windows.Graphics.Imaging.SoftwareBitmap]) $clock $TimeoutMs
    $converted = [Windows.Graphics.Imaging.SoftwareBitmap]::Convert(
      $software, [Windows.Graphics.Imaging.BitmapPixelFormat]::Bgra8, [Windows.Graphics.Imaging.BitmapAlphaMode]::Premultiplied)
    $width = [int]$converted.PixelWidth
    $height = [int]$converted.PixelHeight
    if ($width -lt $content.Width -or $height -lt $content.Height -or $width -gt 8192 -or $height -gt 8192 -or
        ([long]$width * $height) -gt 16777216) { throw 'WGC_SOURCE_CHANGED: Invalid capture surface dimensions.' }
    $byteCount = [int]([long]$width * $height * 4)
    $buffer = [Windows.Storage.Streams.Buffer]::new([uint32]$byteCount)
    $converted.CopyToBuffer($buffer)
    if ($buffer.Length -ne $byteCount) { throw 'WGC_UNAVAILABLE: Unexpected pixel buffer layout.' }
    $pixels = [byte[]]::new($byteCount)
    $reader = [Windows.Storage.Streams.DataReader]::FromBuffer($buffer)
    $reader.ReadBytes($pixels)
    $bitmap = [System.Drawing.Bitmap]::new($content.Width, $content.Height, [System.Drawing.Imaging.PixelFormat]::Format32bppPArgb)
    $locked = $bitmap.LockBits([System.Drawing.Rectangle]::new(0, 0, $content.Width, $content.Height),
      [System.Drawing.Imaging.ImageLockMode]::WriteOnly, [System.Drawing.Imaging.PixelFormat]::Format32bppPArgb)
    # Copy only ContentSize, never undefined pixels outside the content rectangle.
    for ($row = 0; $row -lt $content.Height; $row++) {
      [System.Runtime.InteropServices.Marshal]::Copy($pixels, $row * $width * 4,
        [IntPtr]::Add($locked.Scan0, $row * $locked.Stride), $content.Width * 4)
    }
    $bitmap.UnlockBits($locked); $locked = $null
    $after = Get-RelaiWgcSourceState $Hwnd
    if ($after.ProcessId -ne $before.ProcessId -or $after.ProcessStartedAt -ne $before.ProcessStartedAt -or
        $after.Bounds -ne $before.Bounds -or $after.WindowBounds -ne $before.WindowBounds -or
        $after.BoundsSource -ne $before.BoundsSource) {
      throw 'WGC_SOURCE_CHANGED: Window identity or geometry changed during capture.'
    }
    $null = Get-RelaiWgcRemaining $clock $TimeoutMs
    $mappingReliable = $after.BoundsSource -eq 'dwm-extended-frame' -and
      $content.Width -eq $after.Bounds.Width -and $content.Height -eq $after.Bounds.Height
    $result = [pscustomobject]@{
      Bitmap = $bitmap; Bounds = $after.Bounds; BoundsSource = $after.BoundsSource
      InputMappingReliable = $mappingReliable
      FrameEvidence = [pscustomobject]@{
        method = 'windows-graphics-capture'; windowId = $Hwnd.ToInt64().ToString()
        processId = $after.ProcessId; processStartedAt = $after.ProcessStartedAt
        frameQpc100ns = $frameQpc.ToString(); requestQpc100ns = $requestQpc.ToString()
        receivedAt = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
        width = $content.Width; height = $content.Height; durationMs = $clock.ElapsedMilliseconds
        initializationMs = $initializationMs; frameWaitMs = $frameWaitMs
        pixelCopyAndValidationMs = $clock.ElapsedMilliseconds - $copyStartedMs
        durationIncludesCleanup = $false; processingBudgetMs = $TimeoutMs
        freshness = 'new-compositor-frame'; contentChanged = $null
      }
    }
    $bitmap = $null
    return $result
  } catch {
    $errorRecord = $_
    $exception = $_.Exception
    while ($null -ne $exception) {
      if ($exception.HResult -eq -2147024891) { throw 'WGC_DENIED: Windows denied capture of this window.' }
      if ($exception.Message -match 'WGC_(DENIED|UNAVAILABLE|TIMEOUT|SOURCE_CHANGED|FAILED):') { throw $exception.Message }
      $exception = $exception.InnerException
    }
    throw ('WGC_FAILED: ' + $errorRecord.Exception.Message)
  } finally {
    if ($null -ne $locked -and $null -ne $bitmap) { $bitmap.UnlockBits($locked) }
    if ($null -ne $bitmap) { $bitmap.Dispose() }
    foreach ($resource in @($reader, $converted, $software, $frame, $session, $pool)) {
      if ($null -ne $resource) { try { $resource.Dispose() } catch {} }
    }
    if ($null -ne $device) { try { [RelaiWgcNative]::CloseDevice($device) } catch {} }
    if ($previousDpi -ne [IntPtr]::Zero) { $null = [RelaiWgcNative]::SetThreadDpiAwarenessContext($previousDpi) }
    $clock.Stop()
  }
}
