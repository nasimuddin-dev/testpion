; The User Installer (TestPion-<version>-windows-x64-setup.exe) installs for the person who runs it, without administrator
; rights and without asking "only for me or anyone?". The System Installer (…-system-setup.exe) is the same program built
; with nsis.perMachine=true, where this hook is not used.
;
; One exception keeps updates working: a computer that already has TestPion installed for all users (by the System
; Installer, or by an installer from before 0.58 where "Anyone who uses this computer" was chosen) and has no copy of
; its own for this person gets that installation updated, with Windows asking for approval, instead of a second copy.
!macro customInstallMode
  !ifndef BUILD_UNINSTALLER
    ReadRegStr $0 HKCU "${INSTALL_REGISTRY_KEY}" InstallLocation
    ReadRegStr $1 HKLM "${INSTALL_REGISTRY_KEY}" InstallLocation
    ${if} $0 == ""
    ${andIf} $1 != ""
      StrCpy $isForceMachineInstall "1"
    ${else}
      StrCpy $isForceCurrentInstall "1"
    ${endIf}
  !endif
!macroend
