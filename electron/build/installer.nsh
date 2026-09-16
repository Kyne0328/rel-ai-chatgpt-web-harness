; Rel.AI in-app updates run the assisted NSIS installer silently. Keep a small
; installer-owned surface visible while the Electron application is closed so
; users know the update is still progressing and do not relaunch the shortcut.

!macro customInit
  ${if} ${isUpdated}
  ${andIf} ${Silent}
    SpiderBanner::Show /MODERN
    FindWindow $0 "#32770" "" $hwndparent
    FindWindow $0 "#32770" "" $hwndparent $0
    GetDlgItem $0 $0 1000
    SendMessage $0 ${WM_SETTEXT} 0 "STR:Updating Rel.AI MCP... Please keep this window open. Rel.AI will restart automatically."
  ${endif}
!macroend

!macro customInstall
  ${if} ${isUpdated}
    Delete "$APPDATA\Rel.AI MCP\update-installing.json"
  ${endif}
!macroend

Function .onInstFailed
  ; Safe for manual installs too: deleting a missing update marker is a no-op.
  Delete "$APPDATA\Rel.AI MCP\update-installing.json"
FunctionEnd
