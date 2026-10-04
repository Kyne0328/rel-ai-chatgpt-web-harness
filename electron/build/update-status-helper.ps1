param(
  [Parameter(Mandatory = $true)]
  [string]$MarkerPath
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$createdNew = $false
$mutex = [System.Threading.Mutex]::new($true, 'Local\RelAiMcpUpdateStatus', [ref]$createdNew)
if (-not $createdNew) {
  $mutex.Dispose()
  exit 0
}

try {
  Add-Type -AssemblyName System.Windows.Forms
  Add-Type -AssemblyName System.Drawing
  [System.Windows.Forms.Application]::EnableVisualStyles()

  $form = New-Object System.Windows.Forms.Form
  $form.Text = 'Rel.AI MCP Update'
  $form.StartPosition = 'CenterScreen'
  $form.FormBorderStyle = 'FixedDialog'
  $form.MaximizeBox = $false
  $form.MinimizeBox = $true
  $form.ClientSize = New-Object System.Drawing.Size(500, 210)
  $form.ShowInTaskbar = $true
  $form.TopMost = $true

  $title = New-Object System.Windows.Forms.Label
  $title.Location = New-Object System.Drawing.Point(24, 22)
  $title.Size = New-Object System.Drawing.Size(450, 28)
  $title.Font = New-Object System.Drawing.Font('Segoe UI', 12, [System.Drawing.FontStyle]::Bold)
  $title.Text = 'Updating Rel.AI MCP'
  $form.Controls.Add($title)

  $status = New-Object System.Windows.Forms.Label
  $status.Location = New-Object System.Drawing.Point(24, 60)
  $status.Size = New-Object System.Drawing.Size(450, 24)
  $status.Font = New-Object System.Drawing.Font('Segoe UI', 9)
  $status.Text = 'Preparing update...'
  $form.Controls.Add($status)

  $progress = New-Object System.Windows.Forms.ProgressBar
  $progress.Location = New-Object System.Drawing.Point(24, 94)
  $progress.Size = New-Object System.Drawing.Size(450, 20)
  $progress.Style = [System.Windows.Forms.ProgressBarStyle]::Marquee
  $progress.MarqueeAnimationSpeed = 24
  $form.Controls.Add($progress)

  $elapsed = New-Object System.Windows.Forms.Label
  $elapsed.Location = New-Object System.Drawing.Point(24, 128)
  $elapsed.Size = New-Object System.Drawing.Size(450, 22)
  $elapsed.Font = New-Object System.Drawing.Font('Segoe UI', 8.5)
  $elapsed.Text = 'Elapsed: 0s'
  $form.Controls.Add($elapsed)

  $hint = New-Object System.Windows.Forms.Label
  $hint.Location = New-Object System.Drawing.Point(24, 158)
  $hint.Size = New-Object System.Drawing.Size(450, 36)
  $hint.Font = New-Object System.Drawing.Font('Segoe UI', 8.5)
  $hint.Text = 'Rel.AI will restart automatically. You may close this window; the update will continue in the background.'
  $form.Controls.Add($hint)

  # Timer delegates run in child scopes. Keep state for this single-instance
  # helper process in script scope so later ticks retain phase/timing evidence.
  $script:lastPhase = ''
  $script:startedAt = $null
  $script:completeAt = $null
  $script:failedAt = $null
  $script:missingSince = $null

  function Read-UpdateMarker {
    if (-not (Test-Path -LiteralPath $MarkerPath)) { return $null }
    try {
      return Get-Content -LiteralPath $MarkerPath -Raw -Encoding UTF8 | ConvertFrom-Json
    } catch {
      return $null
    }
  }

  function Format-Elapsed([TimeSpan]$duration) {
    if ($duration.TotalHours -ge 1) {
      return ('{0}h {1}m {2}s' -f [Math]::Floor($duration.TotalHours), $duration.Minutes, $duration.Seconds)
    }
    if ($duration.TotalMinutes -ge 1) {
      return ('{0}m {1}s' -f [Math]::Floor($duration.TotalMinutes), $duration.Seconds)
    }
    return ('{0}s' -f [Math]::Max(0, [int]$duration.TotalSeconds))
  }

  $timer = New-Object System.Windows.Forms.Timer
  $timer.Interval = 400
  $timer.Add_Tick({
    $state = Read-UpdateMarker
    $now = [DateTimeOffset]::UtcNow

    if ($null -eq $state) {
      if ($null -eq $script:missingSince) { $script:missingSince = $now }
      $missingFor = ($now - $script:missingSince).TotalSeconds
      if ($script:lastPhase -eq 'starting' -or $script:lastPhase -eq 'complete') {
        $status.Text = 'Update complete. Rel.AI MCP has restarted.'
        $progress.Style = [System.Windows.Forms.ProgressBarStyle]::Continuous
        $progress.MarqueeAnimationSpeed = 0
        $progress.Value = 100
        $hint.Text = 'Rel.AI MCP is ready to use.'
        if ($missingFor -ge 2.5) { $form.Close() }
      } elseif ($script:lastPhase) {
        $status.Text = 'The update did not finish normally. Open Rel.AI MCP to continue or retry.'
        $progress.Style = [System.Windows.Forms.ProgressBarStyle]::Blocks
        $progress.MarqueeAnimationSpeed = 0
        $progress.Value = 0
        $hint.Text = 'The update lock was cleared, so Rel.AI can be opened normally.'
        if ($missingFor -ge 15) { $form.Close() }
      } elseif ($missingFor -ge 2) {
        $form.Close()
      }
      return
    }

    $script:missingSince = $null
    $phase = [string]$state.phase
    $script:lastPhase = $phase

    if ($state.targetVersion) {
      $title.Text = ('Updating Rel.AI MCP to v{0}' -f [string]$state.targetVersion)
    }

    if ($null -eq $script:startedAt -and $state.startedAt) {
      try { $script:startedAt = [DateTimeOffset]::Parse([string]$state.startedAt) } catch {}
    }
    if ($null -ne $script:startedAt) {
      $elapsed.Text = ('Elapsed: {0}' -f (Format-Elapsed ($now - $script:startedAt)))
    }

    switch ($phase) {
      'preparing' {
        $status.Text = 'Preparing the update...'
      }
      'stopping' {
        $status.Text = 'Closing Rel.AI MCP safely...'
      }
      'closing' {
        $status.Text = 'Closing application windows and background services...'
      }
      'installing' {
        $status.Text = 'Installing Rel.AI MCP...'
      }
      'starting' {
        $status.Text = 'Starting the updated version...'
      }
      'complete' {
        $status.Text = 'Update complete. Rel.AI MCP has restarted.'
        $progress.Style = [System.Windows.Forms.ProgressBarStyle]::Continuous
        $progress.MarqueeAnimationSpeed = 0
        $progress.Value = 100
        $hint.Text = 'Rel.AI MCP is ready to use.'
        if ($null -eq $script:completeAt) { $script:completeAt = $now }
        if (($now - $script:completeAt).TotalSeconds -ge 2.5) {
          $form.Close()
        }
      }
      'failed' {
        $status.Text = if ($state.message) { [string]$state.message } else { 'The update could not be completed. Rel.AI recovered the current version.' }
        $progress.Style = [System.Windows.Forms.ProgressBarStyle]::Blocks
        $progress.MarqueeAnimationSpeed = 0
        $progress.Value = 0
        $hint.Text = 'You can retry the update from Settings > App Updates.'
        if ($null -eq $script:failedAt) { $script:failedAt = $now }
        if (($now - $script:failedAt).TotalSeconds -ge 15) {
          $form.Close()
        }
      }
      default {
        $status.Text = 'Updating Rel.AI MCP...'
      }
    }
  })

  $form.Add_Shown({
    $form.Activate()
    $form.TopMost = $false
    $timer.Start()
  })
  $form.Add_FormClosed({
    $timer.Stop()
    $timer.Dispose()
  })

  [void]$form.ShowDialog()
}
finally {
  if ($null -ne $mutex) {
    try { $mutex.ReleaseMutex() } catch {}
    $mutex.Dispose()
  }
}
