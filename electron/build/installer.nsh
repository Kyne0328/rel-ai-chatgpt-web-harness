; Electron Updater launches assisted NSIS updates with --updated /S. Do not
; create installer UI from customInit in that silent path: electron-builder's
; own template only uses SpiderBanner for non-silent installs.
;
; A manually opened Setup.exe does not receive --updated even when an older
; Rel.AI MCP installation already exists. Give that path an explicit update
; welcome page and keep the installer on the existing user/machine scope so it
; does not look like a second, unrelated installation.

!macro customWelcomePage
  Function RelAiManualUpdateWelcomePre
    StrCmp $hasPerUserInstallation "1" show_update
    StrCmp $hasPerMachineInstallation "1" show_update
    Abort

    show_update:
  FunctionEnd

  !define MUI_PAGE_CUSTOMFUNCTION_PRE RelAiManualUpdateWelcomePre
  !define MUI_WELCOMEPAGE_TITLE "Update Rel.AI MCP"
  !define MUI_WELCOMEPAGE_TEXT "Rel.AI MCP is already installed.$\r$\n$\r$\nSetup will update the existing installation to version ${VERSION} in place. Your settings and application data will be kept.$\r$\n$\r$\nClick Next to continue with the update."
  !insertmacro MUI_PAGE_WELCOME
!macroend

!macro customInstallMode
  ; If exactly one existing installation is present, keep that scope and skip
  ; the fresh-install "who should this be installed for?" choice. If both a
  ; per-user and per-machine install exist, electron-builder keeps its normal
  ; chooser so the user can select which existing installation to update.
  StrCmp $hasPerUserInstallation "1" 0 check_machine_install
  StrCmp $hasPerMachineInstallation "0" 0 install_mode_done
  StrCpy $isForceCurrentInstall "1"
  Goto install_mode_done

  check_machine_install:
    StrCmp $hasPerMachineInstallation "1" 0 install_mode_done
    StrCmp $hasPerUserInstallation "0" 0 install_mode_done
    StrCpy $isForceMachineInstall "1"

  install_mode_done:
!macroend

; In-app updates keep update-installing.json through file replacement so the
; detached status window can distinguish "files installed" from "updated app
; started successfully". The replacement app clears it only after startup.

Function .onInstFailed
  ; Installer failure must fail open: clearing the marker lets the existing
  ; shortcut start normally, while the detached status helper treats the
  ; pre-start disappearance as an interrupted update.
  Delete "$APPDATA\Rel.AI MCP\update-installing.json"
FunctionEnd
