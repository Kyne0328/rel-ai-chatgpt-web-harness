; Electron Updater launches assisted NSIS updates with --updated /S. Do not
; create installer UI from customInit in that silent path: electron-builder's
; own template only uses SpiderBanner for non-silent installs.

!macro customInstall
  ; Safe for manual installs too: deleting a missing update marker is a no-op.
  Delete "$APPDATA\Rel.AI MCP\update-installing.json"
!macroend

Function .onInstFailed
  ; Safe for manual installs too: deleting a missing update marker is a no-op.
  Delete "$APPDATA\Rel.AI MCP\update-installing.json"
FunctionEnd
