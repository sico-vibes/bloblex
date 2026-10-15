; FIX11: installer hooks for the Bloblex -> Bitbots identity change.
;
; The generated NSIS installer (from tauri-bundler's installer.nsi) derives the
; install directory and the uninstall key from the product name:
;   * install dir (currentUser): $LOCALAPPDATA\${PRODUCTNAME}  -> %LOCALAPPDATA%\Bitbots
;   * uninstall key:             HKCU\Software\Microsoft\Windows\CurrentVersion\Uninstall\${PRODUCTNAME}
;
; The old app shipped as "Bloblex", so it registered its uninstall entry under
; ...\Uninstall\Bloblex. Bitbots registers under ...\Uninstall\Bitbots and the
; reinstall page therefore does not see the old install. This hook removes it
; before the new files are copied, so the two do not sit side by side each with
; its own "Start with Windows" entry.
;
; Best effort: every step ignores failures and the install always continues. The
; old uninstaller is run silently, which leaves app data in place (NSIS only
; deletes the app data folder when the user ticks "Delete app data" in the
; uninstaller).

!macro NSIS_HOOK_PREINSTALL
  ; Never touch anything while the installer is updating Bitbots in place.
  ${If} $UpdateMode <> 1
    ReadRegStr $R9 HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\Bloblex" "UninstallString"
    ${If} $R9 != ""
      DetailPrint "Removing the previous Bloblex install..."
      ; Stop the old app and its daemon and hook sidecars if they are running.
      nsExec::ExecToLog 'taskkill /F /IM Bloblex.exe /IM bloblexd.exe /IM bloblex-hook.exe /T'
      Pop $0
      ; $R9 already carries its own surrounding quotes from the registry.
      nsExec::ExecToLog '$R9 /S'
      Pop $0
      ${If} $0 != 0
        DetailPrint "The previous Bloblex uninstaller returned $0. Continuing."
      ${EndIf}
    ${EndIf}
  ${EndIf}
!macroend
