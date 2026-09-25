; NSIS hooks for the Cophyla installer (Tauri's bundler inserts these four macros). The
; running app is versions\<v>\cophyla-ui.exe, not the main binary the bundler checks, so it
; is checked here; and what the daemon staged after the install is removed at uninstall,
; the tether command's folder and its entry on the user's PATH with it.

!macro NSIS_HOOK_PREINSTALL
  !insertmacro CheckIfAppIsRunning "cophyla-ui.exe" "${PRODUCTNAME}"
!macroend

!macro NSIS_HOOK_POSTINSTALL
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  !insertmacro CheckIfAppIsRunning "cophyla-ui.exe" "${PRODUCTNAME}"
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  ; Versions the daemon staged, the bundled brain, the pointers and the launcher's log:
  ; none of them is a file the installer wrote as it is, so the bundler leaves them.
  RMDir /r "$INSTDIR\versions"
  RMDir /r "$INSTDIR\brain"
  Delete "$INSTDIR\current"
  Delete "$INSTDIR\previous"
  Delete "$INSTDIR\staged"
  Delete "$INSTDIR\launcher"
  Delete "$INSTDIR\launcher.log"
  ; The tether command: its folder (a host still running from it keeps its file), and the
  ; folder's entry on the user's PATH, removed alone and the value's kind kept.
  RMDir /r "$INSTDIR\bin"
  System::Call 'Kernel32::SetEnvironmentVariable(t "COPHYLA_BIN", t "$INSTDIR\bin")i'
  Push $0
  nsExec::Exec `powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "$$k = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment', $$true); if ($$k -and $$k.GetValueNames() -contains 'Path') { $$v = [string]$$k.GetValue('Path', '', 'DoNotExpandEnvironmentNames'); $$want = $$env:COPHYLA_BIN.TrimEnd('\'); $$n = @($$v -split ';' | Where-Object { -not $$_ -or [Environment]::ExpandEnvironmentVariables($$_).TrimEnd('\') -ne $$want }) -join ';'; if ($$n -ne $$v) { $$k.SetValue('Path', $$n, $$k.GetValueKind('Path')); [Environment]::SetEnvironmentVariable('COPHYLA_PATH_CHANGED', $$null, 'User') } }"`
  Pop $0
  Pop $0
  RMDir "$INSTDIR"
!macroend
