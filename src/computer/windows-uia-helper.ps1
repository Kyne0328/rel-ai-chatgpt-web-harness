$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::InputEncoding = [System.Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)

Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
. (Join-Path $PSScriptRoot 'windows-app-capture.ps1')
. (Join-Path $PSScriptRoot 'windows-app-targets.ps1')

$script:OcrAvailable = $false
$script:OcrEngine = $null
$script:WinRtAwaiter = $null
$script:OcrError = ''
try {
  Add-Type -AssemblyName System.Runtime.WindowsRuntime
  $null = [Windows.Media.Ocr.OcrEngine,Windows.Foundation,ContentType=WindowsRuntime]
  $null = [Windows.Storage.StorageFile,Windows.Storage,ContentType=WindowsRuntime]
  $null = [Windows.Storage.Streams.IRandomAccessStream,Windows.Storage.Streams,ContentType=WindowsRuntime]
  $null = [Windows.Graphics.Imaging.BitmapDecoder,Windows.Foundation,ContentType=WindowsRuntime]
  $null = [Windows.Graphics.Imaging.SoftwareBitmap,Windows.Foundation,ContentType=WindowsRuntime]
  $script:WinRtAwaiter = [System.WindowsRuntimeSystemExtensions].GetMember('GetAwaiter').Where({
    $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
  }, 'First')[0]
  $script:OcrEngine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages()
  $script:OcrAvailable = $null -ne $script:OcrEngine -and $null -ne $script:WinRtAwaiter
} catch {
  $script:OcrAvailable = $false
  $script:OcrEngine = $null
  $script:WinRtAwaiter = $null
  $script:OcrError = [string]$_.Exception.Message
  if ($script:OcrError.Length -gt 500) { $script:OcrError = $script:OcrError.Substring(0, 500) }
}

function Normalize-Text([object]$Value) {
  if ($null -eq $Value) { return '' }
  return ([string]$Value).Trim().ToLowerInvariant()
}

function Compact-Text([object]$Value) {
  return (Normalize-Text $Value) -replace '[^a-z0-9]', ''
}

function Safe-Text([object]$Value, [int]$MaxLength) {
  if ($null -eq $Value) { return '' }
  $text = ([string]$Value).Trim()
  if ($text.Length -le $MaxLength) { return $text }
  return $text.Substring(0, $MaxLength)
}

function Await-WinRt([object]$Operation, [type]$ResultType) {
  if ($null -eq $script:WinRtAwaiter) { throw 'Windows OCR runtime is unavailable.' }
  return $script:WinRtAwaiter.MakeGenericMethod($ResultType).Invoke($null, @($Operation)).GetResult()
}

function Find-AppWindow([string]$App) {
  $normalized = Normalize-Text $App
  $compact = Compact-Text $App
  if (-not $normalized) { throw 'app is required' }

  $root = [System.Windows.Automation.AutomationElement]::RootElement
  $windows = $root.FindAll(
    [System.Windows.Automation.TreeScope]::Children,
    [System.Windows.Automation.Condition]::TrueCondition
  )
  $best = $null
  $bestScore = -1
  $bestProcess = $null

  foreach ($window in $windows) {
    try {
      $current = $window.Current
      if ($current.IsOffscreen) { continue }
      $title = Normalize-Text $current.Name
      $titleCompact = Compact-Text $current.Name
      $process = Get-Process -Id $current.ProcessId -ErrorAction SilentlyContinue
      $processName = if ($process) { Normalize-Text $process.ProcessName } else { '' }
      $processCompact = Compact-Text $processName
      $score = -1
      if ($processName -eq $normalized -or ($compact -and $processCompact -eq $compact)) { $score = 100 }
      elseif ($title -eq $normalized -or ($compact -and $titleCompact -eq $compact)) { $score = 95 }
      elseif ($processName -and ($processName.Contains($normalized) -or $normalized.Contains($processName))) { $score = 85 }
      elseif ($compact -and $processCompact -and ($processCompact.Contains($compact) -or $compact.Contains($processCompact))) { $score = 82 }
      elseif ($title -and ($title.Contains($normalized) -or $normalized.Contains($title))) { $score = 75 }
      elseif ($compact -and $titleCompact -and ($titleCompact.Contains($compact) -or $compact.Contains($titleCompact))) { $score = 72 }
      if ($score -gt $bestScore) {
        $best = $window
        $bestScore = $score
        $bestProcess = $process
      }
    } catch {}
  }

  if ($null -eq $best -or $bestScore -lt 0) { return $null }
  return [pscustomobject]@{ Element = $best; Process = $bestProcess; Score = $bestScore }
}

function Screen-Geometry([System.Windows.Rect]$Rect) {
  $centerX = [int][Math]::Round($Rect.Left + ($Rect.Width / 2))
  $centerY = [int][Math]::Round($Rect.Top + ($Rect.Height / 2))
  $screens = [System.Windows.Forms.Screen]::AllScreens
  $screen = $null
  foreach ($candidate in $screens) {
    if ($candidate.Bounds.Contains($centerX, $centerY)) { $screen = $candidate; break }
  }
  if ($null -eq $screen) {
    foreach ($candidate in $screens) {
      if ($candidate.Bounds.IntersectsWith([System.Drawing.Rectangle]::FromLTRB(
        [int][Math]::Floor($Rect.Left),
        [int][Math]::Floor($Rect.Top),
        [int][Math]::Ceiling($Rect.Right),
        [int][Math]::Ceiling($Rect.Bottom)
      ))) { $screen = $candidate; break }
    }
  }
  if ($null -eq $screen) { return $null }

  $left = [int][Math]::Round($Rect.Left - $screen.Bounds.Left)
  $top = [int][Math]::Round($Rect.Top - $screen.Bounds.Top)
  $width = [Math]::Max(1, [int][Math]::Round($Rect.Width))
  $height = [Math]::Max(1, [int][Math]::Round($Rect.Height))
  return [pscustomobject]@{
    displayId = $screen.DeviceName
    x = $left
    y = $top
    width = $width
    height = $height
    centerX = [Math]::Max(0, [Math]::Min($screen.Bounds.Width - 1, $left + [int][Math]::Floor($width / 2)))
    centerY = [Math]::Max(0, [Math]::Min($screen.Bounds.Height - 1, $top + [int][Math]::Floor($height / 2)))
  }
}

function Supported-Patterns([System.Windows.Automation.AutomationElement]$Element) {
  $patterns = [System.Collections.Generic.List[string]]::new()
  foreach ($entry in @(
    [pscustomobject]@{ Name = 'invoke'; Pattern = [System.Windows.Automation.InvokePattern]::Pattern },
    [pscustomobject]@{ Name = 'selection'; Pattern = [System.Windows.Automation.SelectionItemPattern]::Pattern },
    [pscustomobject]@{ Name = 'toggle'; Pattern = [System.Windows.Automation.TogglePattern]::Pattern },
    [pscustomobject]@{ Name = 'expand'; Pattern = [System.Windows.Automation.ExpandCollapsePattern]::Pattern },
    [pscustomobject]@{ Name = 'value'; Pattern = [System.Windows.Automation.ValuePattern]::Pattern }
  )) {
    try {
      $patternObject = $null
      if ($Element.TryGetCurrentPattern($entry.Pattern, [ref]$patternObject)) { $patterns.Add($entry.Name) }
    } catch {}
  }
  return $patterns
}

function New-UiaTarget([System.Windows.Automation.AutomationElement]$Element, [string]$TargetId) {
  $current = $Element.Current
  $rect = $current.BoundingRectangle
  if ($current.IsOffscreen -or $rect.Width -le 0 -or $rect.Height -le 0) { return $null }
  $name = Safe-Text $current.Name 500
  $automationId = Safe-Text $current.AutomationId 300
  if (-not $name -and -not $automationId) { return $null }
  $geometry = Screen-Geometry $rect
  if ($null -eq $geometry) { return $null }
  return [pscustomobject]@{
    targetId = $TargetId
    source = 'uia'
    role = Safe-Text ($current.ControlType.ProgrammaticName -replace '^ControlType\.', '') 100
    name = $name
    automationId = $automationId
    className = Safe-Text $current.ClassName 300
    enabled = [bool]$current.IsEnabled
    displayId = $geometry.displayId
    x = $geometry.x
    y = $geometry.y
    width = $geometry.width
    height = $geometry.height
    centerX = $geometry.centerX
    centerY = $geometry.centerY
    patterns = @(Supported-Patterns $Element)
  }
}

function Get-UiaTargetEntries([System.Windows.Automation.AutomationElement]$Window, [int]$MaxElements) {
  $walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker
  $queue = [System.Collections.Generic.Queue[System.Windows.Automation.AutomationElement]]::new()
  $queue.Enqueue($Window)
  $entries = [System.Collections.Generic.List[object]]::new()
  $visited = 0
  $visitLimit = [Math]::Max($MaxElements * 8, 256)

  while ($queue.Count -gt 0 -and $entries.Count -lt $MaxElements -and $visited -lt $visitLimit) {
    $parent = $queue.Dequeue()
    $child = $null
    try { $child = $walker.GetFirstChild($parent) } catch {}
    while ($null -ne $child -and $entries.Count -lt $MaxElements -and $visited -lt $visitLimit) {
      $visited += 1
      try {
        $queue.Enqueue($child)
        $target = New-UiaTarget $child ''
        if ($null -ne $target) {
          $entries.Add([pscustomobject]@{ Target = $target; Element = $child })
        }
      } catch {}
      $next = $null
      try { $next = $walker.GetNextSibling($child) } catch {}
      $child = $next
    }
  }

  return [pscustomobject]@{
    Entries = $entries
    Truncated = ($queue.Count -gt 0 -or $visited -ge $visitLimit)
  }
}

function Get-OcrTargets([string]$App, [object]$Match, [int]$MaxElements) {
  $targets = [System.Collections.Generic.List[object]]::new()
  if (-not $script:OcrAvailable -or $MaxElements -le 0) { return $targets }
  $script:OcrError = ''

  $script:OcrProvenance = $null
  $tempPath = Join-Path ([System.IO.Path]::GetTempPath()) ('relai-ocr-' + [guid]::NewGuid().ToString('N') + '.png')
  $bitmap = $null
  $graphics = $null
  $stream = $null
  try {
    $nativeCapture = Get-AppPixelCapture $App $Match
    $bitmap = $nativeCapture.Bitmap
    $capture = $nativeCapture.Bounds
    $script:OcrProvenance = $nativeCapture.Provenance
    if ($capture.Width -gt [Windows.Media.Ocr.OcrEngine]::MaxImageDimension -or $capture.Height -gt [Windows.Media.Ocr.OcrEngine]::MaxImageDimension) { throw 'Application window exceeds the OCR size limit.' }
    $bitmap.Save($tempPath, [System.Drawing.Imaging.ImageFormat]::Png)
    $bitmap.Dispose(); $bitmap = $null

    $storageFile = Await-WinRt ([Windows.Storage.StorageFile]::GetFileFromPathAsync($tempPath)) ([Windows.Storage.StorageFile])
    $stream = Await-WinRt ($storageFile.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])
    $decoder = Await-WinRt ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
    $softwareBitmap = Await-WinRt ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])
    $result = Await-WinRt ($script:OcrEngine.RecognizeAsync($softwareBitmap)) ([Windows.Media.Ocr.OcrResult])

    foreach ($line in $result.Lines) {
      if ($targets.Count -ge $MaxElements) { break }
      $lineText = Safe-Text $line.Text 500
      if (-not $lineText -or $line.Words.Count -eq 0) { continue }
      $left = [double]::PositiveInfinity
      $top = [double]::PositiveInfinity
      $right = [double]::NegativeInfinity
      $bottom = [double]::NegativeInfinity
      foreach ($word in $line.Words) {
        $rect = $word.BoundingRect
        $left = [Math]::Min($left, $rect.X)
        $top = [Math]::Min($top, $rect.Y)
        $right = [Math]::Max($right, $rect.X + $rect.Width)
        $bottom = [Math]::Max($bottom, $rect.Y + $rect.Height)
      }
      if ([double]::IsNaN($left) -or [double]::IsInfinity($left) -or $right -le $left -or $bottom -le $top) { continue }
      $absoluteRect = [System.Windows.Rect]::new(
        $capture.Left + $left,
        $capture.Top + $top,
        $right - $left,
        $bottom - $top
      )
      $geometry = Screen-Geometry $absoluteRect
      if ($null -eq $geometry) { continue }
      $targets.Add([pscustomobject]@{
        targetId = ''
        source = 'ocr'
        role = 'Text'
        name = $lineText
        automationId = ''
        className = 'Windows.Media.Ocr'
        enabled = $true
        displayId = $geometry.displayId
        x = $geometry.x
        y = $geometry.y
        width = $geometry.width
        height = $geometry.height
        centerX = $geometry.centerX
        centerY = $geometry.centerY
        patterns = @()
      })
    }
  } catch {
    $script:OcrError = Safe-Text $_.Exception.Message 500
  } finally {
    if ($null -ne $graphics) { try { $graphics.Dispose() } catch {} }
    if ($null -ne $bitmap) { try { $bitmap.Dispose() } catch {} }
    if ($null -ne $stream) { try { $stream.Dispose() } catch {} }
    Remove-Item -LiteralPath $tempPath -Force -ErrorAction SilentlyContinue
  }
  return $targets
}

function Target-IoU([object]$A, [object]$B) {
  if ([string]$A.displayId -ne [string]$B.displayId) { return 0.0 }
  $left = [Math]::Max([double]$A.x, [double]$B.x)
  $top = [Math]::Max([double]$A.y, [double]$B.y)
  $right = [Math]::Min([double]$A.x + [double]$A.width, [double]$B.x + [double]$B.width)
  $bottom = [Math]::Min([double]$A.y + [double]$A.height, [double]$B.y + [double]$B.height)
  $intersection = [Math]::Max(0.0, $right - $left) * [Math]::Max(0.0, $bottom - $top)
  if ($intersection -le 0) { return 0.0 }
  $union = ([double]$A.width * [double]$A.height) + ([double]$B.width * [double]$B.height) - $intersection
  if ($union -le 0) { return 0.0 }
  return $intersection / $union
}

function Copy-TargetWithId([object]$Target, [string]$TargetId) {
  return [pscustomobject]@{
    targetId = $TargetId
    source = Safe-Text $Target.source 20
    role = Safe-Text $Target.role 100
    name = Safe-Text $Target.name 500
    automationId = Safe-Text $Target.automationId 300
    className = Safe-Text $Target.className 300
    enabled = [bool]$Target.enabled
    displayId = Safe-Text $Target.displayId 200
    x = [int]$Target.x
    y = [int]$Target.y
    width = [int]$Target.width
    height = [int]$Target.height
    centerX = [int]$Target.centerX
    centerY = [int]$Target.centerY
    patterns = @($Target.patterns)
  }
}

function Merge-Targets([object[]]$UiaTargets, [object[]]$OcrTargets, [int]$MaxElements) {
  $merged = [System.Collections.Generic.List[object]]::new()
  foreach ($target in $UiaTargets) {
    if ($merged.Count -ge $MaxElements) { break }
    $merged.Add($target)
  }
  foreach ($target in $OcrTargets) {
    if ($merged.Count -ge $MaxElements) { break }
    $duplicate = $false
    foreach ($existing in $merged) {
      if ((Target-IoU $existing $target) -gt 0.1) { $duplicate = $true; break }
    }
    if (-not $duplicate) { $merged.Add($target) }
  }

  $result = [System.Collections.Generic.List[object]]::new()
  for ($index = 0; $index -lt $merged.Count; $index += 1) {
    $result.Add((Copy-TargetWithId $merged[$index] ('e' + ($index + 1))))
  }
  return $result
}

function Normalize-Perception([object]$Value) {
  $perception = (Safe-Text $Value 20).ToLowerInvariant()
  if (-not $perception) { return 'auto' }
  if ($perception -notin @('auto', 'semantic', 'hybrid')) { throw 'perception must be auto, semantic, or hybrid' }
  return $perception
}

function Observe-App([string]$App, [int]$MaxElements, [string]$Perception, [object]$AppTarget) {
  $match = if ($AppTarget) { Get-VerifiedAppWindow $AppTarget } else { Find-AppWindow $App }
  if ($null -eq $match) {
    return [pscustomobject]@{ supported = $true; available = $false; reason = 'No matching visible application window was found.' }
  }

  $perception = Normalize-Perception $Perception
  $window = $match.Element
  $currentWindow = $window.Current
  $windowGeometry = Screen-Geometry $currentWindow.BoundingRectangle
  $uiaLimit = if ($perception -eq 'hybrid') { [Math]::Max(1, [int][Math]::Floor($MaxElements * 0.8)) } else { $MaxElements }
  $uia = Get-UiaTargetEntries $window $uiaLimit
  $uiaTargets = @($uia.Entries | ForEach-Object { $_.Target })
  $ocrTargets = @()
  $script:OcrProvenance = $null
  $script:OcrError = ''
  if ($perception -eq 'hybrid' -or ($perception -eq 'auto' -and $uiaTargets.Count -eq 0)) {
    $ocrTargets = @(Get-OcrTargets $App $match $MaxElements)
  }
  $elements = Merge-Targets $uiaTargets $ocrTargets $MaxElements

  $processName = if ($match.Process) { Safe-Text $match.Process.ProcessName 200 } else { '' }
  $windowResult = [pscustomobject]@{
    title = Safe-Text $currentWindow.Name 500
    processName = $processName
    processId = [int]$currentWindow.ProcessId
    className = Safe-Text $currentWindow.ClassName 300
    displayId = if ($windowGeometry) { $windowGeometry.displayId } else { $null }
  }
  return [pscustomobject]@{
    supported = $true
    available = $true
    perception = $perception
    ocrAvailable = [bool]($script:OcrAvailable -and -not $script:OcrError)
    ocrReason = $script:OcrError
    pixelProvenance = $script:OcrProvenance
    window = $windowResult
    elements = $elements
    count = $elements.Count
    truncated = [bool]$uia.Truncated
  }
}

function Find-UiaTargetEntry([System.Windows.Automation.AutomationElement]$Window, [object]$Target, [int]$MaxElements) {
  $uia = Get-UiaTargetEntries $Window ([Math]::Max($MaxElements, 120))
  $role = Normalize-Text $Target.role
  $automationId = Normalize-Text $Target.automationId
  $name = Normalize-Text $Target.name
  $className = Normalize-Text $Target.className
  $candidates = @($uia.Entries | Where-Object {
    $current = $_.Target
    if ((Normalize-Text $current.role) -ne $role) { return $false }
    if ($automationId) { return (Normalize-Text $current.automationId) -eq $automationId }
    return (Normalize-Text $current.name) -eq $name -and (Normalize-Text $current.className) -eq $className
  })
  if ($automationId -and $candidates.Count -gt 1 -and $className) {
    $candidates = @($candidates | Where-Object { (Normalize-Text $_.Target.className) -eq $className })
  }
  if ($automationId -and $candidates.Count -gt 1 -and $name) {
    $candidates = @($candidates | Where-Object { (Normalize-Text $_.Target.name) -eq $name })
  }
  if ($candidates.Count -ne 1) { return $null }
  return $candidates[0]
}

function Find-OcrTarget([object[]]$Elements, [object]$Target) {
  $name = Normalize-Text $Target.name
  $displayId = [string]$Target.displayId
  $candidates = @($Elements | Where-Object {
    $_.source -eq 'ocr' -and (Normalize-Text $_.name) -eq $name -and [string]$_.displayId -eq $displayId
  })
  if ($candidates.Count -eq 0) { return $null }
  $ranked = @($candidates | Sort-Object @{ Expression = {
    $dx = [double]$_.centerX - [double]$Target.centerX
    $dy = [double]$_.centerY - [double]$Target.centerY
    ($dx * $dx) + ($dy * $dy)
  } })
  $best = $ranked[0]
  $bestDx = [double]$best.centerX - [double]$Target.centerX
  $bestDy = [double]$best.centerY - [double]$Target.centerY
  $bestDistance = [Math]::Sqrt(($bestDx * $bestDx) + ($bestDy * $bestDy))
  $targetWidth = [double]$Target.width
  $targetHeight = [double]$Target.height
  $maxDistance = [Math]::Max(80.0, [Math]::Sqrt(($targetWidth * $targetWidth) + ($targetHeight * $targetHeight)) * 2.0)
  if ($bestDistance -gt $maxDistance) { return $null }
  if ($ranked.Count -gt 1) {
    $second = $ranked[1]
    $secondDx = [double]$second.centerX - [double]$Target.centerX
    $secondDy = [double]$second.centerY - [double]$Target.centerY
    $secondDistance = [Math]::Sqrt(($secondDx * $secondDx) + ($secondDy * $secondDy))
    if (($secondDistance - $bestDistance) -lt 24.0) { return $null }
  }
  return $best
}

function Invoke-NativeTarget([System.Windows.Automation.AutomationElement]$Element, [object]$Target) {
  if (-not $Element.Current.IsEnabled) { return [pscustomobject]@{ handled = $false; method = ''; reason = 'Target is disabled.' } }

  $patternObject = $null
  if ($Element.TryGetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern, [ref]$patternObject)) {
    ([System.Windows.Automation.InvokePattern]$patternObject).Invoke()
    return [pscustomobject]@{ handled = $true; method = 'uia-invoke'; reason = '' }
  }
  $patternObject = $null
  if ($Element.TryGetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern, [ref]$patternObject)) {
    ([System.Windows.Automation.SelectionItemPattern]$patternObject).Select()
    return [pscustomobject]@{ handled = $true; method = 'uia-select'; reason = '' }
  }
  $patternObject = $null
  if ($Element.TryGetCurrentPattern([System.Windows.Automation.TogglePattern]::Pattern, [ref]$patternObject)) {
    ([System.Windows.Automation.TogglePattern]$patternObject).Toggle()
    return [pscustomobject]@{ handled = $true; method = 'uia-toggle'; reason = '' }
  }
  if ((Normalize-Text $Target.role) -eq 'combobox') {
    $patternObject = $null
    if ($Element.TryGetCurrentPattern([System.Windows.Automation.ExpandCollapsePattern]::Pattern, [ref]$patternObject)) {
      $expand = [System.Windows.Automation.ExpandCollapsePattern]$patternObject
      if ($expand.Current.ExpandCollapseState -eq [System.Windows.Automation.ExpandCollapseState]::Collapsed) {
        $expand.Expand()
      } else {
        $expand.Collapse()
      }
      return [pscustomobject]@{ handled = $true; method = 'uia-expand-collapse'; reason = '' }
    }
  }
  return [pscustomobject]@{ handled = $false; method = 'semantic-center-click'; reason = 'No safe native activation pattern is available.' }
}

function Activate-App([string]$App, [int]$MaxElements, [string]$Perception, [object]$Target, [object]$AppTarget) {
  $match = if ($AppTarget) { Get-VerifiedAppWindow $AppTarget } else { Find-AppWindow $App }
  if ($null -eq $match) {
    return [pscustomobject]@{ supported = $true; available = $false; handled = $false; reason = 'No matching visible application window was found.' }
  }
  if ((Safe-Text $Target.source 20).ToLowerInvariant() -eq 'ocr') {
    $observation = Observe-App $App $MaxElements 'hybrid' $AppTarget
    $current = Find-OcrTarget @($observation.elements) $Target
    if ($null -eq $current) {
      return [pscustomobject]@{ supported = $true; available = $false; handled = $false; reason = 'OCR target is stale or ambiguous.' }
    }
    $null = Assert-AppInputTarget $App ([pscustomobject]@{
      provenance = $observation.pixelProvenance; width = $observation.pixelProvenance.windowWidth; height = $observation.pixelProvenance.windowHeight
      points = @([pscustomobject]@{ x = $current.centerX; y = $current.centerY }); requiresFocus = $false
    })
    return [pscustomobject]@{ supported = $true; available = $true; handled = $false; method = 'ocr-center-click'; target = $current }
  }

  $entry = Find-UiaTargetEntry $match.Element $Target $MaxElements
  if ($null -eq $entry) {
    return [pscustomobject]@{ supported = $true; available = $false; handled = $false; reason = 'UIA target is stale or ambiguous.' }
  }
  $currentTarget = Copy-TargetWithId $entry.Target (Safe-Text $Target.targetId 100)
  $native = Invoke-NativeTarget $entry.Element $currentTarget
  return [pscustomobject]@{
    supported = $true
    available = $true
    handled = [bool]$native.handled
    method = $native.method
    reason = $native.reason
    target = $currentTarget
  }
}

function Set-AppValue([string]$App, [int]$MaxElements, [object]$Target, [string]$Text, [object]$AppTarget) {
  $match = if ($AppTarget) { Get-VerifiedAppWindow $AppTarget } else { Find-AppWindow $App }
  if ($null -eq $match) {
    return [pscustomobject]@{ supported = $true; available = $false; handled = $false; reason = 'No matching visible application window was found.' }
  }
  if ((Safe-Text $Target.source 20).ToLowerInvariant() -eq 'ocr') {
    return [pscustomobject]@{ supported = $true; available = $true; handled = $false; reason = 'OCR targets do not expose a native value pattern.'; target = $Target }
  }
  $entry = Find-UiaTargetEntry $match.Element $Target $MaxElements
  if ($null -eq $entry) {
    return [pscustomobject]@{ supported = $true; available = $false; handled = $false; reason = 'UIA target is stale or ambiguous.' }
  }
  $currentTarget = Copy-TargetWithId $entry.Target (Safe-Text $Target.targetId 100)
  $patternObject = $null
  if (-not $entry.Element.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$patternObject)) {
    return [pscustomobject]@{ supported = $true; available = $true; handled = $false; reason = 'Target does not expose UIA ValuePattern.'; target = $currentTarget }
  }
  $valuePattern = [System.Windows.Automation.ValuePattern]$patternObject
  if ($valuePattern.Current.IsReadOnly) {
    return [pscustomobject]@{ supported = $true; available = $true; handled = $false; reason = 'Target value is read-only.'; target = $currentTarget }
  }
  $valuePattern.SetValue($Text)
  return [pscustomobject]@{ supported = $true; available = $true; handled = $true; method = 'uia-set-value'; target = $currentTarget }
}

while (($line = [Console]::In.ReadLine()) -ne $null) {
  if (-not $line.Trim()) { continue }
  $requestId = $null
  try {
    $request = $line | ConvertFrom-Json
    $requestId = [string]$request.id
    $action = Safe-Text $request.action 40
    if ($action -eq 'warmup') {
      $null = [System.Windows.Automation.AutomationElement]::RootElement
      $result = [pscustomobject]@{ supported = $true; available = $true; ocrAvailable = [bool]$script:OcrAvailable; ocrReason = $script:OcrError }
    } elseif ($action -eq 'app_targets') {
      $result = Get-AppWindowCandidates $request.binding ([string]$request.windowId)
    } elseif ($action -eq 'verify_input_target') {
      $result = Assert-AppInputTarget ([string]$request.app) $request.target
    } elseif ($action -eq 'screenshot_app') {
      $result = Get-AppScreenshot ([string]$request.app) ([string]$request.displayId) $request.appTarget
    } elseif ($action -eq 'observe') {
      $maxElements = [Math]::Max(1, [Math]::Min(300, [int]$request.maxElements))
      $result = Observe-App ([string]$request.app) $maxElements (Normalize-Perception $request.perception) $request.appTarget
    } elseif ($action -eq 'activate') {
      $maxElements = [Math]::Max(1, [Math]::Min(300, [int]$request.maxElements))
      $result = Activate-App ([string]$request.app) $maxElements (Normalize-Perception $request.perception) $request.target $request.appTarget
    } elseif ($action -eq 'set_value') {
      $maxElements = [Math]::Max(1, [Math]::Min(300, [int]$request.maxElements))
      $result = Set-AppValue ([string]$request.app) $maxElements $request.target ([string]$request.text) $request.appTarget
    } else {
      throw "Unsupported UIA helper action '$action'."
    }
    [pscustomobject]@{ id = $requestId; ok = $true; result = $result } | ConvertTo-Json -Compress -Depth 10
  } catch {
    [pscustomobject]@{ id = $requestId; ok = $false; error = (Safe-Text $_.Exception.Message 1000) } | ConvertTo-Json -Compress -Depth 4
  }
}
