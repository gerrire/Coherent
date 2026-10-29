!define COHERENT_IDENTITY_SOURCE "${__FILEDIR__}"

!macro NSIS_HOOK_PREINSTALL
  InitPluginsDir
  Push $OUTDIR
  SetOutPath "$PLUGINSDIR\coherent-identity"
  File /oname=Coherent.Identity.msix "${COHERENT_IDENTITY_SOURCE}\Coherent.Identity.msix"
  File /oname=register.ps1 "${COHERENT_IDENTITY_SOURCE}\register.ps1"
  CreateDirectory "$INSTDIR"
  nsExec::ExecToStack '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoLogo -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy RemoteSigned -File "$PLUGINSDIR\coherent-identity\register.ps1" -Action Register -InstallDirectory "$INSTDIR"'
  Pop $0
  Pop $1
  DetailPrint "$1"
  ${If} $0 != 0
    MessageBox MB_ICONSTOP|MB_OK "Windows could not register the Coherent application identity. Installation stopped before replacing the application." /SD IDOK
    SetErrorLevel 1
    Abort
  ${EndIf}
  Pop $0
  SetOutPath "$0"
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  nsExec::ExecToStack '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoLogo -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy RemoteSigned -File "$INSTDIR\windows-identity\register.ps1" -Action Unregister -InstallDirectory "$INSTDIR"'
  Pop $0
  Pop $1
  DetailPrint "$1"
  ${If} $0 != 0
    MessageBox MB_ICONSTOP|MB_OK "Windows could not remove the Coherent application identity. Close Coherent and retry." /SD IDOK
    SetErrorLevel 1
    Abort
  ${EndIf}
!macroend
