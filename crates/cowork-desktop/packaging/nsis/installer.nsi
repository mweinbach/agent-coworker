; Migration-aware NSIS installer template for Cowork (Rune desktop).
;
; Responsibilities:
; - Adopt a legitimate registered legacy Electron installation (AppId `com.cowork.desktop`,
;   electron-builder NSIS GUID `dd76376f-991d-5a9b-8b5f-cc05306dc019`) and its install scope
;   (HKCU per-user vs HKLM per-machine) instead of installing a duplicate copy.
; - Support both legacy electron-updater flags (`--updated`, `--force-run`, `--keep-shortcuts`,
;   `--no-desktop-shortcut`, `/allusers`, `--allusers`, `/currentuser`, `--currentuser`, `/S`, `/D=`)
;   and stock Rune follow-up flags (`/P`, `/R`, `/S`, `/NS`, `/D=`).
; - Never trust unvalidated, reparse-point, system, or cross-hive paths for privileged operations.
; - Never delete user data (`%APPDATA%\Cowork`, `%APPDATA%\desktop`, `%USERPROFILE%\.cowork`).
; - Tolerate retries after partial or interrupted installs, maintain a single uninstall registration,
;   preserve/update shortcuts with AppUserModelID `com.cowork.desktop`, and relaunch Rune once.

!if "{{compression}}" == ""
  SetCompressor /SOLID lzma
!else
  SetCompressor /SOLID "{{compression}}"
!endif

Unicode true

!include MUI2.nsh
!include LogicLib.nsh
!include FileFunc.nsh
!include x64.nsh
!include WordFunc.nsh
!include "FileAssociation.nsh"
!include "StrFunc.nsh"
${StrCase}
${StrLoc}
${StrStr}

!define MANUFACTURER "{{manufacturer}}"
!define PRODUCTNAME "{{product_name}}"
!define VERSION "{{version}}"
!define VERSIONWITHBUILD "{{version_with_build}}"
!define SHORTDESCRIPTION "{{short_description}}"
!define INSTALLMODE "{{install_mode}}"
!define LICENSE "{{license}}"
!define INSTALLERICON "{{installer_icon}}"
!define SIDEBARIMAGE "{{sidebar_image}}"
!define HEADERIMAGE "{{header_image}}"
!define MAINBINARYNAME "{{main_binary_name}}"
!define MAINBINARYSRCPATH "{{main_binary_path}}"
!define IDENTIFIER "{{identifier}}"
!define COPYRIGHT "{{copyright}}"
!define OUTFILE "{{out_file}}"
!define ARCH "{{arch}}"
!define PLUGINSPATH "{{additional_plugins_path}}"
!define ALLOWDOWNGRADES "{{allow_downgrades}}"
!define DISPLAYLANGUAGESELECTOR "{{display_language_selector}}"
!define UNINSTKEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\${PRODUCTNAME}"
!define MANUPRODUCTKEY "Software\${MANUFACTURER}\${PRODUCTNAME}"
!define UNINSTALLERSIGNCOMMAND "{{uninstaller_sign_cmd}}"
!define ESTIMATEDSIZE "{{estimated_size}}"

; Legacy Electron (electron-builder NSIS) ownership constants for `com.cowork.desktop`
; UUID.v5("com.cowork.desktop", "50e065bc-3134-11e6-9bab-38c9862bdaf3")
!define LEGACY_APP_GUID "dd76376f-991d-5a9b-8b5f-cc05306dc019"
!define LEGACY_INSTALL_KEY "Software\${LEGACY_APP_GUID}"
!define LEGACY_UNINST_KEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\${LEGACY_APP_GUID}"
!define LEGACY_EXECUTABLE_NAME "Cowork.exe"
!define LEGACY_UNINSTALLER_NAME "Uninstall Cowork.exe"

!if "${ARCH}" == "arm64"
  !define SIDECAR_PROC_NAME "cowork-server-aarch64-pc-windows-msvc.exe"
!else
  !define SIDECAR_PROC_NAME "cowork-server-x86_64-pc-windows-msvc.exe"
!endif

Name "${PRODUCTNAME}"
BrandingText "${COPYRIGHT}"
OutFile "${OUTFILE}"

VIProductVersion "${VERSIONWITHBUILD}"
VIAddVersionKey "ProductName" "${PRODUCTNAME}"
VIAddVersionKey "FileDescription" "${SHORTDESCRIPTION}"
VIAddVersionKey "LegalCopyright" "${COPYRIGHT}"
VIAddVersionKey "FileVersion" "${VERSION}"
VIAddVersionKey "ProductVersion" "${VERSION}"

; Plugins path, currently exists for non-Windows hosts only
!if "${PLUGINSPATH}" != ""
  !addplugindir "${PLUGINSPATH}"
!endif

!if "${UNINSTALLERSIGNCOMMAND}" != ""
  !uninstfinalize '${UNINSTALLERSIGNCOMMAND}'
!endif

; Default to per-user execution level so standard per-user installs and updates never
; require UAC. When an existing legitimate per-machine (HKLM) install is adopted or
; `/allusers` is explicitly requested, `.onInit` self-elevates via ShellExecuteW "runas"
; and strictly isolates HKLM operations from HKCU.
!if "${INSTALLMODE}" == "perMachine"
  RequestExecutionLevel highest
!else
  RequestExecutionLevel user
!endif

; Installer icons and graphics
!if "${INSTALLERICON}" != ""
  !define MUI_ICON "${INSTALLERICON}"
  !define MUI_UNICON "${INSTALLERICON}"
!endif

!if "${SIDEBARIMAGE}" != ""
  !define MUI_WELCOMEFINISHPAGE_BITMAP "${SIDEBARIMAGE}"
!endif

!if "${HEADERIMAGE}" != ""
  !define MUI_HEADERIMAGE
  !define MUI_HEADERIMAGE_BITMAP "${HEADERIMAGE}"
!endif

; Store installer language in HKCU
!define MUI_LANGDLL_REGISTRY_ROOT "HKCU"
!define MUI_LANGDLL_REGISTRY_KEY "${MANUPRODUCTKEY}"
!define MUI_LANGDLL_REGISTRY_VALUENAME "Installer Language"

; Store Start Menu folder in the active scope hive (HKCU or HKLM)
!define MUI_STARTMENU_REGISTRY_ROOT "SHCTX"
!define MUI_STARTMENU_REGISTRY_KEY "${MANUPRODUCTKEY}"
!define MUI_STARTMENU_REGISTRY_VALUENAME "StartMenuFolder"

; Global runtime state
Var CmdParams
Var PassiveMode
Var UpdatedFlag
Var ForceRunFlag
Var RelaunchFlag
Var ShouldRelaunch
Var NoShortcutsFlag
Var KeepShortcutsFlag
Var NoDesktopShortcutFlag
Var RequestedScope
Var ResolvedScope
Var AlreadyElevatedFlag
Var ExplicitInstDir
Var MigrationRetryFlag
Var IsUpgradeMode
Var ExistingRuneInstallDir
Var LegacyInstallDir
Var LegacyRegistryPresent
Var LegacyShortcutName
Var LegacyMenuDirectory
Var HadDesktopShortcut
Var HadStartMenuShortcut
Var AppStartMenuFolder
Var UnAlreadyElevated

; Installer pages
; 1. Welcome Page
!define MUI_PAGE_CUSTOMFUNCTION_PRE SkipIfPassive
!insertmacro MUI_PAGE_WELCOME

; 2. License Page (if defined)
!if "${LICENSE}" != ""
  !define MUI_PAGE_CUSTOMFUNCTION_PRE SkipIfPassive
  !insertmacro MUI_PAGE_LICENSE "${LICENSE}"
!endif

; 3. Custom page for interactive reinstall/upgrade of an existing Rune install
Var ReinstallPageCheck
Page custom PageReinstall PageLeaveReinstall
Function PageReinstall
  ; Skip in passive/silent or legacy-adoption flows (handled seamlessly in-place).
  Call SkipIfPassive
  IfSilent 0 +2
    Abort

  ; Check if a WiX installation exists under HKLM
  StrCpy $0 0
  StrCpy $R7 ""
  wix_loop:
    EnumRegKey $1 HKLM "SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall" $0
    StrCmp $1 "" wix_done
    IntOp $0 $0 + 1
    ReadRegStr $R0 HKLM "SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\$1" "DisplayName"
    ReadRegStr $R1 HKLM "SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\$1" "Publisher"
    StrCmp "$R0$R1" "${PRODUCTNAME}${MANUFACTURER}" 0 wix_loop
    ReadRegStr $R0 HKLM "SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\$1" "UninstallString"
    ${StrCase} $R1 $R0 "L"
    ${StrLoc} $R0 $R1 "msiexec" ">"
    StrCmp $R0 0 0 wix_done
    StrCpy $R7 "wix"
    StrCpy $R6 "SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\$1"
    Goto compare_version
  wix_done:

  ; Check if an existing Rune NSIS installation is registered in the resolved scope
  ReadRegStr $R0 SHCTX "${UNINSTKEY}" ""
  ReadRegStr $R1 SHCTX "${UNINSTKEY}" "UninstallString"
  ${IfThen} "$R0$R1" == "" ${|} Abort ${|}

  compare_version:
  StrCpy $R4 "$(older)"
  ${If} $R7 == "wix"
    ReadRegStr $R0 HKLM "$R6" "DisplayVersion"
  ${Else}
    ReadRegStr $R0 SHCTX "${UNINSTKEY}" "DisplayVersion"
  ${EndIf}
  ${IfThen} $R0 == "" ${|} StrCpy $R4 "$(unknown)" ${|}

  nsis_tauri_utils::SemverCompare "${VERSION}" $R0
  Pop $R0
  ${If} $R0 == 0
    StrCpy $R1 "$(alreadyInstalledLong)"
    StrCpy $R2 "$(addOrReinstall)"
    StrCpy $R3 "$(uninstallApp)"
    !insertmacro MUI_HEADER_TEXT "$(alreadyInstalled)" "$(chooseMaintenanceOption)"
    StrCpy $R5 "2"
  ${ElseIf} $R0 == 1
    StrCpy $R1 "$(olderOrUnknownVersionInstalled)"
    StrCpy $R2 "$(uninstallBeforeInstalling)"
    StrCpy $R3 "$(dontUninstall)"
    !insertmacro MUI_HEADER_TEXT "$(alreadyInstalled)" "$(choowHowToInstall)"
    StrCpy $R5 "1"
  ${ElseIf} $R0 == -1
    StrCpy $R1 "$(newerVersionInstalled)"
    StrCpy $R2 "$(uninstallBeforeInstalling)"
    !if "${ALLOWDOWNGRADES}" == "true"
      StrCpy $R3 "$(dontUninstall)"
    !else
      StrCpy $R3 "$(dontUninstallDowngrade)"
    !endif
    !insertmacro MUI_HEADER_TEXT "$(alreadyInstalled)" "$(choowHowToInstall)"
    StrCpy $R5 "1"
  ${Else}
    Abort
  ${EndIf}

  nsDialogs::Create 1018
  Pop $R4
  ${IfThen} $(^RTL) == 1 ${|} nsDialogs::SetRTL $(^RTL) ${|}

  ${NSD_CreateLabel} 0 0 100% 24u $R1
  Pop $R1

  ${NSD_CreateRadioButton} 30u 50u -30u 8u $R2
  Pop $R2
  ${NSD_OnClick} $R2 PageReinstallUpdateSelection

  ${NSD_CreateRadioButton} 30u 70u -30u 8u $R3
  Pop $R3
  !if "${ALLOWDOWNGRADES}" == "false"
    ${IfThen} $R0 == -1 ${|} EnableWindow $R3 0 ${|}
  !endif
  ${NSD_OnClick} $R3 PageReinstallUpdateSelection

  ${If} $ReinstallPageCheck != 2
    SendMessage $R2 ${BM_SETCHECK} ${BST_CHECKED} 0
  ${Else}
    SendMessage $R3 ${BM_SETCHECK} ${BST_CHECKED} 0
  ${EndIf}

  ${NSD_SetFocus} $R2
  nsDialogs::Show
FunctionEnd

Function PageReinstallUpdateSelection
  ${NSD_GetState} $R2 $R1
  ${If} $R1 == ${BST_CHECKED}
    StrCpy $ReinstallPageCheck 1
  ${Else}
    StrCpy $ReinstallPageCheck 2
  ${EndIf}
FunctionEnd

Function PageLeaveReinstall
  ${NSD_GetState} $R2 $R1

  StrCmp $R5 "1" 0 +2
    StrCmp $R1 "1" reinst_uninstall reinst_done
  StrCmp $R1 "1" reinst_done

  reinst_uninstall:
    HideWindow
    ClearErrors

    ${If} $R7 == "wix"
      ReadRegStr $R1 HKLM "$R6" "UninstallString"
      ExecWait '$R1' $0
    ${Else}
      ReadRegStr $4 SHCTX "${MANUPRODUCTKEY}" ""
      ReadRegStr $R1 SHCTX "${UNINSTKEY}" "UninstallString"
      ExecWait '$R1 /P _?=$4' $0
    ${EndIf}

    BringToFront

    ${IfThen} ${Errors} ${|} StrCpy $0 2 ${|}

    ${If} $0 <> 0
    ${OrIf} ${FileExists} "$INSTDIR\${MAINBINARYNAME}.exe"
      ${If} $0 = 1
        StrCmp $R5 "2" 0 +2
          Quit
        Abort
      ${EndIf}
      MessageBox MB_ICONEXCLAMATION "$(unableToUninstall)"
      Abort
    ${Else}
      StrCpy $0 $R1 1
      ${IfThen} $0 == '"' ${|} StrCpy $R1 $R1 -1 1 ${|}
      Delete $R1
      RMDir $INSTDIR
    ${EndIf}
  reinst_done:
FunctionEnd

; 4. Choose install directory page
!define MUI_PAGE_CUSTOMFUNCTION_PRE SkipIfPassive
!insertmacro MUI_PAGE_DIRECTORY

; 5. Start menu shortcut page
!define MUI_PAGE_CUSTOMFUNCTION_PRE SkipIfPassive
!insertmacro MUI_PAGE_STARTMENU Application $AppStartMenuFolder

; 6. Installation page
!insertmacro MUI_PAGE_INSTFILES

; 7. Finish page (interactive GUI only; skipped in passive/silent modes)
!define MUI_FINISHPAGE_NOAUTOCLOSE
!define MUI_FINISHPAGE_SHOWREADME
!define MUI_FINISHPAGE_SHOWREADME_TEXT "$(createDesktop)"
!define MUI_FINISHPAGE_SHOWREADME_FUNCTION CreateDesktopShortcut
!define MUI_FINISHPAGE_RUN "$INSTDIR\${MAINBINARYNAME}.exe"
!define MUI_PAGE_CUSTOMFUNCTION_PRE SkipIfPassive
!insertmacro MUI_PAGE_FINISH

; Uninstaller Pages
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES

; Languages
{{#each languages}}
!insertmacro MUI_LANGUAGE "{{this}}"
{{/each}}
!insertmacro MUI_RESERVEFILE_LANGDLL
{{#each language_files}}
  !include "{{this}}"
{{/each}}

; Always use 64-bit registry view for x64 and arm64 targets (matches legacy electron-builder)
!macro SetRegViewForTarget
  !if "${ARCH}" == "x64"
    SetRegView 64
  !else if "${ARCH}" == "arm64"
    SetRegView 64
  !else
    ${If} ${RunningX64}
      SetRegView 32
    ${EndIf}
  !endif
!macroend

; Helper: strip surrounding quotes and trailing backslash (preserving drive root length)
Function NormalizeDirPath
  Exch $R0
  Push $R1
  Push $R2

  ; Strip leading quote
  StrCpy $R1 $R0 1
  ${If} $R1 == '"'
    StrCpy $R0 $R0 "" 1
  ${EndIf}

  ; Strip trailing quote
  StrCpy $R1 $R0 1 -1
  ${If} $R1 == '"'
    StrCpy $R0 $R0 -1
  ${EndIf}

  ; Strip trailing backslashes while length > 3
  ${Do}
    StrLen $R2 $R0
    ${If} $R2 <= 3
      ${ExitDo}
    ${EndIf}
    StrCpy $R1 $R0 1 -1
    ${If} $R1 != "\"
      ${ExitDo}
    ${EndIf}
    StrCpy $R0 $R0 -1
  ${Loop}

  Pop $R2
  Pop $R1
  Exch $R0
FunctionEnd

; Helper: extract first quoted token from a command line (e.g., UninstallString)
Function ExtractQuotedPath
  Exch $R0
  Push $R1
  Push $R2
  Push $R3

  StrCpy $R1 0
  StrLen $R2 $R0
  ${Do}
    ${If} $R1 >= $R2
      StrCpy $R0 ""
      Goto eqp_done
    ${EndIf}
    StrCpy $R3 $R0 1 $R1
    ${If} $R3 == '"'
      IntOp $R1 $R1 + 1
      StrCpy $R0 $R0 "" $R1
      ${ExitDo}
    ${EndIf}
    IntOp $R1 $R1 + 1
  ${Loop}

  StrCpy $R1 0
  StrLen $R2 $R0
  ${Do}
    ${If} $R1 >= $R2
      StrCpy $R0 ""
      Goto eqp_done
    ${EndIf}
    StrCpy $R3 $R0 1 $R1
    ${If} $R3 == '"'
      StrCpy $R0 $R0 $R1
      Goto eqp_done
    ${EndIf}
    IntOp $R1 $R1 + 1
  ${Loop}

  eqp_done:
  Pop $R3
  Pop $R2
  Pop $R1
  Exch $R0
FunctionEnd

; Helper: return parent directory of a Windows path (or "" if none)
Function GetPathParent
  Exch $R0
  Push $R1
  Push $R2
  Push $R3

  StrLen $R2 $R0
  StrCpy $R1 1
  ${Do}
    ${If} $R1 > $R2
      StrCpy $R0 ""
      Goto gpp_done
    ${EndIf}
    StrCpy $R3 $R0 1 -$R1
    ${If} $R3 == "\"
      StrCpy $R0 $R0 -$R1
      Goto gpp_done
    ${EndIf}
    IntOp $R1 $R1 + 1
  ${Loop}

  gpp_done:
  Pop $R3
  Pop $R2
  Pop $R1
  Exch $R0
FunctionEnd

; Helper: validate that a directory path is safe (drive-rooted, no traversal, not system/root,
; and neither the directory nor its immediate parent is a reparse point / symlink / junction).
; Input: candidate path on stack. Output: normalized path on stack, or "" if rejected.
Function ValidateInstallDir
  Exch $R0
  Push $R1
  Push $R2
  Push $0
  Push $1
  Push $2

  Push $R0
  Call NormalizeDirPath
  Pop $R0

  ${If} $R0 == ""
    Goto vid_reject
  ${EndIf}

  ; Must be drive-rooted and deeper than drive root (e.g. `C:\x`, len >= 4)
  StrLen $R1 $R0
  ${If} $R1 < 4
    Goto vid_reject
  ${EndIf}
  StrCpy $R1 $R0 1 1
  StrCpy $R2 $R0 1 2
  ${If} $R1 != ":"
  ${OrIf} $R2 != "\"
    Goto vid_reject
  ${EndIf}

  ; Reject path traversal segments, forward slashes, or wildcards
  ${StrStr} $R1 $R0 "\..\"
  ${If} $R1 != ""
    Goto vid_reject
  ${EndIf}
  StrCpy $R1 $R0 3 -3
  ${If} $R1 == "\.."
    Goto vid_reject
  ${EndIf}
  ${StrStr} $R1 $R0 "/"
  ${If} $R1 != ""
    Goto vid_reject
  ${EndIf}
  ${StrStr} $R1 $R0 "*"
  ${If} $R1 != ""
    Goto vid_reject
  ${EndIf}
  ${StrStr} $R1 $R0 "?"
  ${If} $R1 != ""
    Goto vid_reject
  ${EndIf}

  ; Reject system and container roots
  ${If} $R0 == "$WINDIR"
  ${OrIf} $R0 == "$SYSDIR"
  ${OrIf} $R0 == "$PROGRAMFILES"
  ${OrIf} $R0 == "$PROGRAMFILES64"
  ${OrIf} $R0 == "$COMMONFILES"
  ${OrIf} $R0 == "$COMMONFILES64"
  ${OrIf} $R0 == "$LOCALAPPDATA"
  ${OrIf} $R0 == "$LOCALAPPDATA\Programs"
  ${OrIf} $R0 == "$APPDATA"
  ${OrIf} $R0 == "$PROFILE"
  ${OrIf} $R0 == "$TEMP"
  ${OrIf} $R0 == "$DESKTOP"
  ${OrIf} $R0 == "$SMPROGRAMS"
    Goto vid_reject
  ${EndIf}

  ; Reject anything inside Windows directory (`$WINDIR\...`), user AppData (`$APPDATA\...`),
  ; or shared server home (`$PROFILE\.cowork`) so user data/system dirs are never treated as app dirs.
  StrLen $R1 "$WINDIR\"
  StrCpy $R2 $R0 $R1
  ${If} $R2 == "$WINDIR\"
    Goto vid_reject
  ${EndIf}

  StrLen $R1 "$APPDATA\"
  StrCpy $R2 $R0 $R1
  ${If} $R2 == "$APPDATA\"
    Goto vid_reject
  ${EndIf}

  ${If} $R0 == "$PROFILE\.cowork"
    Goto vid_reject
  ${EndIf}
  StrLen $R1 "$PROFILE\.cowork\"
  StrCpy $R2 $R0 $R1
  ${If} $R2 == "$PROFILE\.cowork\"
    Goto vid_reject
  ${EndIf}

  ; If directory exists, verify it is a real directory and NOT a reparse point (0x400)
  StrCpy $0 $R0
  System::Call 'kernel32::GetFileAttributesW(w r0)i.r1'
  ${If} $1 != -1
    IntOp $2 $1 & 0x10
    ${If} $2 = 0
      Goto vid_reject
    ${EndIf}
    IntOp $2 $1 & 0x400
    ${If} $2 != 0
      Goto vid_reject
    ${EndIf}
  ${EndIf}

  ; Also verify immediate parent directory (if present) is NOT a reparse point (0x400)
  Push $R0
  Call GetPathParent
  Pop $R1
  ${If} $R1 != ""
    StrLen $R2 $R1
    ${If} $R2 > 2
      StrCpy $0 $R1
      System::Call 'kernel32::GetFileAttributesW(w r0)i.r1'
      ${If} $1 != -1
        IntOp $2 $1 & 0x400
        ${If} $2 != 0
          Goto vid_reject
        ${EndIf}
      ${EndIf}
    ${EndIf}
  ${EndIf}

  Goto vid_done

  vid_reject:
  StrCpy $R0 ""

  vid_done:
  Pop $2
  Pop $1
  Pop $0
  Pop $R2
  Pop $R1
  Exch $R0
FunctionEnd

; Helper: verify a registered path is safe AND belongs to Cowork (or is a known migration retry).
; Input: candidate path on stack. Output: normalized path on stack, or "" if rejected.
Function ValidateRegisteredCoworkDir
  Exch $R0
  Push $R0
  Call ValidateInstallDir
  Pop $R0
  ${If} $R0 == ""
    Goto vrc_done
  ${EndIf}

  ${If} $MigrationRetryFlag = 1
    Goto vrc_done
  ${EndIf}

  ${If} ${FileExists} "$R0\${LEGACY_EXECUTABLE_NAME}"
  ${OrIf} ${FileExists} "$R0\${LEGACY_UNINSTALLER_NAME}"
  ${OrIf} ${FileExists} "$R0\${MAINBINARYNAME}.exe"
  ${OrIf} ${FileExists} "$R0\uninstall.exe"
  ${OrIf} ${FileExists} "$R0\resources\app.asar"
    Goto vrc_done
  ${EndIf}

  StrCpy $R0 ""

  vrc_done:
  Exch $R0
FunctionEnd

; Probe a single registry hive (`HKCU` or `HKLM`) strictly in isolation.
; Populates:
;   $ExistingRuneInstallDir, $LegacyInstallDir, $LegacyRegistryPresent,
;   $LegacyShortcutName, $LegacyMenuDirectory, $MigrationRetryFlag
!macro ProbeInstallInHive HIVE
  StrCpy $ExistingRuneInstallDir ""
  StrCpy $LegacyInstallDir ""
  StrCpy $LegacyRegistryPresent 0
  StrCpy $LegacyShortcutName ""
  StrCpy $LegacyMenuDirectory ""
  StrCpy $MigrationRetryFlag 0

  ; Check for an interrupted migration retry in this hive
  ReadRegStr $R0 ${HIVE} "${MANUPRODUCTKEY}" "MigrationInProgress"
  ${If} $R0 == "1"
    StrCpy $MigrationRetryFlag 1
  ${EndIf}

  ; 1. Check existing Rune installation in this hive
  ReadRegStr $R0 ${HIVE} "${MANUPRODUCTKEY}" ""
  ${If} $R0 == ""
    ReadRegStr $R0 ${HIVE} "${MANUPRODUCTKEY}" "InstallLocation"
  ${EndIf}
  ${If} $R0 == ""
    ReadRegStr $R0 ${HIVE} "${UNINSTKEY}" "InstallLocation"
  ${EndIf}
  ${If} $R0 != ""
    Push $R0
    Call ValidateRegisteredCoworkDir
    Pop $ExistingRuneInstallDir
  ${EndIf}

  ; 2. Check legacy Electron installation in this hive (`dd76376f-991d-5a9b-8b5f-cc05306dc019`)
  ReadRegStr $R0 ${HIVE} "${LEGACY_INSTALL_KEY}" "InstallLocation"
  ReadRegStr $R1 ${HIVE} "${LEGACY_UNINST_KEY}" "UninstallString"
  ${If} $R0 != ""
  ${OrIf} $R1 != ""
    StrCpy $LegacyRegistryPresent 1
  ${EndIf}

  ${If} $R0 == ""
  ${AndIf} $R1 != ""
    Push $R1
    Call ExtractQuotedPath
    Pop $R2
    ${If} $R2 != ""
      Push $R2
      Call GetPathParent
      Pop $R0
    ${EndIf}
  ${EndIf}

  ${If} $R0 == ""
  ${AndIf} $MigrationRetryFlag = 1
    ReadRegStr $R0 ${HIVE} "${MANUPRODUCTKEY}" "MigratedFrom"
  ${EndIf}

  ${If} $R0 != ""
    Push $R0
    Call ValidateRegisteredCoworkDir
    Pop $LegacyInstallDir
  ${EndIf}

  ReadRegStr $LegacyShortcutName ${HIVE} "${LEGACY_INSTALL_KEY}" "ShortcutName"
  ReadRegStr $LegacyMenuDirectory ${HIVE} "${LEGACY_INSTALL_KEY}" "MenuDirectory"
!macroend

Function .onInit
  !insertmacro SetRegViewForTarget

  ; Initialize state variables
  StrCpy $PassiveMode 0
  StrCpy $UpdatedFlag 0
  StrCpy $ForceRunFlag 0
  StrCpy $RelaunchFlag 0
  StrCpy $ShouldRelaunch 0
  StrCpy $NoShortcutsFlag 0
  StrCpy $KeepShortcutsFlag 0
  StrCpy $NoDesktopShortcutFlag 0
  StrCpy $RequestedScope ""
  StrCpy $ResolvedScope "current"
  StrCpy $AlreadyElevatedFlag 0
  StrCpy $ExplicitInstDir 0
  StrCpy $MigrationRetryFlag 0
  StrCpy $IsUpgradeMode 0
  StrCpy $ExistingRuneInstallDir ""
  StrCpy $LegacyInstallDir ""
  StrCpy $LegacyRegistryPresent 0
  StrCpy $LegacyShortcutName ""
  StrCpy $LegacyMenuDirectory ""
  StrCpy $HadDesktopShortcut 0
  StrCpy $HadStartMenuShortcut 0
  StrCpy $AppStartMenuFolder ""

  ; Record whether `/D=<dir>` was passed before `.onInit` (NSIS sets `$INSTDIR` from `/D=`)
  ${If} $INSTDIR != ""
    StrCpy $ExplicitInstDir 1
  ${EndIf}

  ; Parse installer arguments (excluding the installer executable path)
  ${GetParameters} $CmdParams

  ; Stock Rune updater / NSIS flags
  ClearErrors
  ${GetOptions} $CmdParams "/P" $R0
  ${IfNot} ${Errors}
    StrCpy $PassiveMode 1
  ${EndIf}

  ClearErrors
  ${GetOptions} $CmdParams "/R" $R0
  ${IfNot} ${Errors}
    StrCpy $RelaunchFlag 1
  ${EndIf}

  ClearErrors
  ${GetOptions} $CmdParams "/NS" $R0
  ${IfNot} ${Errors}
    StrCpy $NoShortcutsFlag 1
  ${EndIf}

  ; Legacy electron-updater NSIS flags
  ClearErrors
  ${GetOptions} $CmdParams "--updated" $R0
  ${IfNot} ${Errors}
    StrCpy $UpdatedFlag 1
    StrCpy $PassiveMode 1
  ${EndIf}

  ClearErrors
  ${GetOptions} $CmdParams "--force-run" $R0
  ${IfNot} ${Errors}
    StrCpy $ForceRunFlag 1
  ${EndIf}

  ClearErrors
  ${GetOptions} $CmdParams "--keep-shortcuts" $R0
  ${IfNot} ${Errors}
    StrCpy $KeepShortcutsFlag 1
  ${EndIf}

  ClearErrors
  ${GetOptions} $CmdParams "--no-desktop-shortcut" $R0
  ${IfNot} ${Errors}
    StrCpy $NoDesktopShortcutFlag 1
  ${EndIf}

  ClearErrors
  ${GetOptions} $CmdParams "/allusers" $R0
  ${IfNot} ${Errors}
    StrCpy $RequestedScope "all"
  ${EndIf}

  ClearErrors
  ${GetOptions} $CmdParams "--allusers" $R0
  ${IfNot} ${Errors}
    StrCpy $RequestedScope "all"
  ${EndIf}

  ClearErrors
  ${GetOptions} $CmdParams "/currentuser" $R0
  ${IfNot} ${Errors}
    StrCpy $RequestedScope "current"
  ${EndIf}

  ClearErrors
  ${GetOptions} $CmdParams "--currentuser" $R0
  ${IfNot} ${Errors}
    StrCpy $RequestedScope "current"
  ${EndIf}

  ClearErrors
  ${GetOptions} $CmdParams "/COWORK_ELEVATED" $R0
  ${IfNot} ${Errors}
    StrCpy $AlreadyElevatedFlag 1
  ${EndIf}

  ; Compute single-relaunch policy for silent/passive modes:
  ; - `/R` (stock Rune) or `--force-run` (legacy Electron) -> relaunch once
  ; - `--updated` without `/S` (Electron oneClick Restart & Install) -> relaunch once
  ; - `--updated /S` without `--force-run` or `/R` -> silent update, do NOT relaunch
  ; - Interactive GUI (not silent and not passive) -> Finish page checkbox controls launch
  ${If} $RelaunchFlag = 1
  ${OrIf} $ForceRunFlag = 1
    StrCpy $ShouldRelaunch 1
  ${ElseIf} $UpdatedFlag = 1
    ${IfNot} ${Silent}
      StrCpy $ShouldRelaunch 1
    ${EndIf}
  ${EndIf}

  ; Resolve install scope strictly from registered ownership or explicit scope flag.
  ; Never mix HKCU and HKLM registrations.
  !if "${INSTALLMODE}" == "perMachine"
    ${If} $RequestedScope == ""
      StrCpy $RequestedScope "all"
    ${EndIf}
  !endif

  ${If} $RequestedScope == "all"
    StrCpy $ResolvedScope "all"
    !insertmacro ProbeInstallInHive HKLM
  ${ElseIf} $RequestedScope == "current"
    StrCpy $ResolvedScope "current"
    !insertmacro ProbeInstallInHive HKCU
  ${Else}
    ; Auto-detect scope: prefer legitimate per-user HKCU install, then per-machine HKLM install
    !insertmacro ProbeInstallInHive HKCU
    ${If} $ExistingRuneInstallDir != ""
    ${OrIf} $LegacyInstallDir != ""
    ${OrIf} $MigrationRetryFlag = 1
      StrCpy $ResolvedScope "current"
    ${Else}
      !insertmacro ProbeInstallInHive HKLM
      ${If} $ExistingRuneInstallDir != ""
      ${OrIf} $LegacyInstallDir != ""
      ${OrIf} $MigrationRetryFlag = 1
        StrCpy $ResolvedScope "all"
      ${Else}
        ; Fresh install defaults to per-user HKCU
        StrCpy $ResolvedScope "current"
        !insertmacro ProbeInstallInHive HKCU
      ${EndIf}
    ${EndIf}
  ${EndIf}

  ; If resolved scope is per-machine (HKLM), require administrator privileges.
  ; Never fall back to a duplicate per-user install if elevation is declined or unavailable.
  ${If} $ResolvedScope == "all"
    System::Call 'shell32::IsUserAnAdmin()i.r0'
    ${If} $0 = 0
      ${If} $AlreadyElevatedFlag = 1
        ${IfNot} ${Silent}
          MessageBox MB_ICONSTOP "Administrator privileges are required to update the per-machine ${PRODUCTNAME} installation."
        ${EndIf}
        SetErrorLevel 5
        Quit
      ${EndIf}

      ; Re-launch elevated, placing internal flags BEFORE `$CmdParams` so any `/D=` remains last
      StrCpy $2 "/COWORK_ELEVATED /allusers"
      ${If} $CmdParams != ""
        StrCpy $2 "$2 $CmdParams"
      ${EndIf}
      ${If} $ExplicitInstDir = 1
        ${StrLoc} $3 "$2" "/D=" ">"
        ${If} $3 == ""
          StrCpy $2 "$2 /D=$INSTDIR"
        ${EndIf}
      ${EndIf}
      StrCpy $1 "$EXEPATH"
      System::Call 'shell32::ShellExecuteW(p $HWNDPARENT, w "runas", w r1, w r2, w "", i 1)i.r0'
      ${If} $0 <= 32
        SetErrorLevel 1223
        Quit
      ${EndIf}
      SetErrorLevel 0
      Quit
    ${EndIf}
    SetShellVarContext all
  ${Else}
    SetShellVarContext current
  ${EndIf}

  !if "${DISPLAYLANGUAGESELECTOR}" == "true"
    ${If} $PassiveMode <> 1
      !insertmacro MUI_LANGDLL_DISPLAY
    ${EndIf}
  !endif

  ; Determine whether we are upgrading/adopting an existing installation
  ${If} $ExistingRuneInstallDir != ""
  ${OrIf} $LegacyInstallDir != ""
  ${OrIf} $MigrationRetryFlag = 1
    StrCpy $IsUpgradeMode 1
  ${EndIf}

  ; Resolve final target `$INSTDIR`
  ${If} $ExplicitInstDir = 1
    ; Validate explicit `/D=` directory so privileged or automated runs cannot target system/symlink paths
    Push $INSTDIR
    Call ValidateInstallDir
    Pop $R0
    ${If} $R0 == ""
      ${IfNot} ${Silent}
        MessageBox MB_ICONSTOP "The requested installation directory is invalid or unsafe."
      ${EndIf}
      SetErrorLevel 87
      Quit
    ${EndIf}
    StrCpy $INSTDIR $R0
  ${ElseIf} $ExistingRuneInstallDir != ""
    StrCpy $INSTDIR $ExistingRuneInstallDir
  ${ElseIf} $LegacyInstallDir != ""
    StrCpy $INSTDIR $LegacyInstallDir
  ${ElseIf} $ResolvedScope == "all"
    StrCpy $INSTDIR "$PROGRAMFILES64\${PRODUCTNAME}"
  ${Else}
    StrCpy $INSTDIR "$LOCALAPPDATA\${PRODUCTNAME}"
  ${EndIf}

  ; Restore saved Start Menu folder (or legacy Electron MenuDirectory, which is "" for top-level Start Menu)
  ReadRegStr $AppStartMenuFolder SHCTX "${MANUPRODUCTKEY}" "StartMenuFolder"
  ${If} $AppStartMenuFolder == ""
  ${AndIf} $LegacyMenuDirectory != ""
    StrCpy $AppStartMenuFolder $LegacyMenuDirectory
  ${EndIf}

  ; Snapshot existing shortcut presence before any files change so upgrades preserve user choices
  ${If} ${FileExists} "$DESKTOP\${PRODUCTNAME}.lnk"
    StrCpy $HadDesktopShortcut 1
  ${ElseIf} $LegacyShortcutName != ""
  ${AndIf} ${FileExists} "$DESKTOP\$LegacyShortcutName.lnk"
    StrCpy $HadDesktopShortcut 1
  ${EndIf}

  ${If} ${FileExists} "$SMPROGRAMS\${PRODUCTNAME}.lnk"
    StrCpy $HadStartMenuShortcut 1
  ${ElseIf} $AppStartMenuFolder != ""
  ${AndIf} ${FileExists} "$SMPROGRAMS\$AppStartMenuFolder\${PRODUCTNAME}.lnk"
    StrCpy $HadStartMenuShortcut 1
  ${ElseIf} $LegacyShortcutName != ""
  ${AndIf} ${FileExists} "$SMPROGRAMS\$LegacyShortcutName.lnk"
    StrCpy $HadStartMenuShortcut 1
  ${EndIf}
FunctionEnd

Section EarlyChecks
  ; Abort silent installer if downgrades are disabled
  !if "${ALLOWDOWNGRADES}" == "false"
  IfSilent 0 silent_downgrades_done
    ReadRegStr $R0 SHCTX "${UNINSTKEY}" "DisplayVersion"
    ${If} $R0 != ""
      nsis_tauri_utils::SemverCompare "${VERSION}" $R0
      Pop $R0
      ${If} $R0 == -1
        System::Call 'kernel32::AttachConsole(i -1)i.r0'
        ${If} $0 != 0
          System::Call 'kernel32::GetStdHandle(i -11)i.r0'
          System::Call 'kernel32::SetConsoleTextAttribute(i r0, i 0x0004)'
          FileWrite $0 "$(silentDowngrades)"
        ${EndIf}
        Abort
      ${EndIf}
    ${EndIf}
  silent_downgrades_done:
  !endif
SectionEnd

{{#if preinstall_section}}
{{unescape_newlines preinstall_section}}
{{/if}}

; Wait up to 10s for a process to exit gracefully (important while Electron finishes
; `quitAndInstall` shutdown and flushes user state), then prompt/terminate if still active.
!macro WaitAndCloseProcess PROC_NAME
  Push $R0
  Push $R1
  StrCpy $R1 0
  ${Do}
    nsis_tauri_utils::FindProcess "${PROC_NAME}"
    Pop $R0
    ${If} $R0 <> 0
      ${ExitDo}
    ${EndIf}
    ${If} $R1 >= 20
      ${ExitDo}
    ${EndIf}
    Sleep 500
    IntOp $R1 $R1 + 1
  ${Loop}

  ${If} $R0 = 0
    ${IfNot} ${Silent}
    ${AndIf} $PassiveMode <> 1
      ${IfNot} ${Cmd} 'MessageBox MB_OKCANCEL "$(appRunningOkKill)" IDOK'
        Abort "$(appRunning)"
      ${EndIf}
    ${EndIf}
    nsis_tauri_utils::KillProcess "${PROC_NAME}"
    Pop $R0
    StrCpy $R1 0
    ${Do}
      Sleep 500
      nsis_tauri_utils::FindProcess "${PROC_NAME}"
      Pop $R0
      ${If} $R0 <> 0
        ${ExitDo}
      ${EndIf}
      ${If} $R1 >= 10
        ${ExitDo}
      ${EndIf}
      IntOp $R1 $R1 + 1
    ${Loop}
    ${If} $R0 = 0
      ${If} ${Silent}
        System::Call 'kernel32::AttachConsole(i -1)i.r0'
        ${If} $0 != 0
          System::Call 'kernel32::GetStdHandle(i -11)i.r0'
          System::Call 'kernel32::SetConsoleTextAttribute(i r0, i 0x0004)'
          FileWrite $0 "$(appRunning)$\n"
        ${EndIf}
        Abort
      ${Else}
        Abort "$(failedToKillApp)"
      ${EndIf}
    ${EndIf}
  ${EndIf}
  Pop $R1
  Pop $R0
!macroend

!macro WaitAndCloseCoworkProcesses
  !insertmacro WaitAndCloseProcess "${MAINBINARYNAME}.exe"
  !insertmacro WaitAndCloseProcess "${LEGACY_EXECUTABLE_NAME}"
  !insertmacro WaitAndCloseProcess "${SIDECAR_PROC_NAME}"
!macroend

; Helper: idempotent delete with short retry for transient AV / process-exit locks
Function DeleteFileWithRetry
  Exch $R0
  Push $R1
  StrCpy $R1 0
  ${Do}
    IfFileExists "$R0" 0 dfwr_done
    ClearErrors
    Delete "$R0"
    IfFileExists "$R0" 0 dfwr_done
    ${If} $R1 >= 15
      ${ExitDo}
    ${EndIf}
    Sleep 300
    IntOp $R1 $R1 + 1
  ${Loop}
  dfwr_done:
  Pop $R1
  Pop $R0
FunctionEnd

; Helper: surgically remove legacy Electron runtime files from a validated Cowork directory.
; Never touches `%APPDATA%\Cowork`, `%APPDATA%\desktop`, `%USERPROFILE%\.cowork`, or user files.
Function CleanupValidatedLegacyElectronFiles
  ${If} $LegacyInstallDir == ""
    Return
  ${EndIf}

  ; Re-verify path safety immediately before deleting any legacy application files
  Push $LegacyInstallDir
  Call ValidateRegisteredCoworkDir
  Pop $R0
  ${If} $R0 == ""
    Return
  ${EndIf}

  ; Remove legacy main binary and uninstaller first (abort if legacy app is still locked)
  Push "$LegacyInstallDir\${LEGACY_EXECUTABLE_NAME}"
  Call DeleteFileWithRetry
  ${If} ${FileExists} "$LegacyInstallDir\${LEGACY_EXECUTABLE_NAME}"
    Abort "$(failedToKillApp)"
  ${EndIf}

  Push "$LegacyInstallDir\${LEGACY_UNINSTALLER_NAME}"
  Call DeleteFileWithRetry

  ; Remove known Electron/Chromium runtime files and directories (idempotent on retry)
  Delete "$LegacyInstallDir\chrome_100_percent.pak"
  Delete "$LegacyInstallDir\chrome_200_percent.pak"
  Delete "$LegacyInstallDir\chrome_elf.dll"
  Delete "$LegacyInstallDir\resources.pak"
  Delete "$LegacyInstallDir\icudtl.dat"
  Delete "$LegacyInstallDir\v8_context_snapshot.bin"
  Delete "$LegacyInstallDir\snapshot_blob.bin"
  Delete "$LegacyInstallDir\ffmpeg.dll"
  Delete "$LegacyInstallDir\libEGL.dll"
  Delete "$LegacyInstallDir\libGLESv2.dll"
  Delete "$LegacyInstallDir\d3dcompiler_47.dll"
  Delete "$LegacyInstallDir\dxcompiler.dll"
  Delete "$LegacyInstallDir\dxil.dll"
  Delete "$LegacyInstallDir\vk_swiftshader.dll"
  Delete "$LegacyInstallDir\vk_swiftshader_icd.json"
  Delete "$LegacyInstallDir\vulkan-1.dll"
  Delete "$LegacyInstallDir\LICENSE.electron.txt"
  Delete "$LegacyInstallDir\LICENSES.chromium.html"
  Delete "$LegacyInstallDir\version"
  Delete "$LegacyInstallDir\debug.log"
  RMDir /r "$LegacyInstallDir\locales"
  RMDir /r "$LegacyInstallDir\resources"
  RMDir /r "$LegacyInstallDir\swiftshader"

  ; If adopting into a different directory (e.g. explicit `/D=`), remove old dir only if now empty
  ${If} $LegacyInstallDir != $INSTDIR
    RMDir "$LegacyInstallDir"
  ${EndIf}
FunctionEnd

Section Install
  ; Ensure target `$INSTDIR` is still safe (e.g. if changed interactively on Directory page)
  Push $INSTDIR
  Call ValidateInstallDir
  Pop $R0
  ${If} $R0 == ""
    Abort "Invalid installation directory."
  ${EndIf}
  StrCpy $INSTDIR $R0

  !insertmacro WaitAndCloseCoworkProcesses

  ; Record migration-in-progress marker so interrupted legacy handoffs recover cleanly on retry
  ${If} $LegacyInstallDir != ""
    WriteRegStr SHCTX "${MANUPRODUCTKEY}" "MigrationInProgress" "1"
    WriteRegStr SHCTX "${MANUPRODUCTKEY}" "MigratedFrom" "$LegacyInstallDir"
    Call CleanupValidatedLegacyElectronFiles
  ${EndIf}

  SetOutPath $INSTDIR

  ; Copy main Rune executable
  ClearErrors
  File "${MAINBINARYSRCPATH}"
  IfErrors 0 +2
    Abort "$(failedToKillApp)"

  ; Create resources directory structure
  {{#each resources_dirs}}
    CreateDirectory "$INSTDIR\\{{this}}"
  {{/each}}

  ; Copy resources
  {{#each resources}}
    File /a "/oname={{this}}" "{{@key}}"
  {{/each}}

  ; Copy external binaries
  {{#each binaries}}
    File /a "/oname={{this}}" "{{@key}}"
  {{/each}}

  ; Create file associations
  {{#each file_associations as |association| ~}}
    {{#each association.extensions as |ext| ~}}
       !insertmacro APP_ASSOCIATE "{{ext}}" "{{or association.name ext}}" "{{association-description association.description ext}}" "$INSTDIR\${MAINBINARYNAME}.exe,0" "Open with ${PRODUCTNAME}" "$INSTDIR\${MAINBINARYNAME}.exe $\"%1$\""
    {{/each}}
  {{/each}}

  ; Register deep links
  {{#each deep_link_protocols as |protocol| ~}}
    WriteRegStr SHCTX "Software\Classes\\{{protocol}}" "URL Protocol" ""
    WriteRegStr SHCTX "Software\Classes\\{{protocol}}" "" "URL:${BUNDLEID} protocol"
    WriteRegStr SHCTX "Software\Classes\\{{protocol}}\DefaultIcon" "" "$\"$INSTDIR\${MAINBINARYNAME}.exe$\",0"
    WriteRegStr SHCTX "Software\Classes\\{{protocol}}\shell\open\command" "" "$\"$INSTDIR\${MAINBINARYNAME}.exe$\" $\"%1$\""
  {{/each}}

  ; Create single canonical uninstaller
  WriteUninstaller "$INSTDIR\uninstall.exe"

  ; Persist canonical install location and scope so subsequent Rune updates reuse this exact location
  WriteRegStr SHCTX "${MANUPRODUCTKEY}" "" "$INSTDIR"
  WriteRegStr SHCTX "${MANUPRODUCTKEY}" "InstallLocation" "$INSTDIR"
  WriteRegStr SHCTX "${MANUPRODUCTKEY}" "InstallScope" "$ResolvedScope"
  WriteRegStr SHCTX "${MANUPRODUCTKEY}" "StartMenuFolder" "$AppStartMenuFolder"

  ; Single canonical Add/Remove Programs (Apps & Features) uninstall entry
  WriteRegStr SHCTX "${UNINSTKEY}" "DisplayName" "${PRODUCTNAME}"
  WriteRegStr SHCTX "${UNINSTKEY}" "DisplayIcon" "$\"$INSTDIR\${MAINBINARYNAME}.exe$\""
  WriteRegStr SHCTX "${UNINSTKEY}" "DisplayVersion" "${VERSION}"
  WriteRegStr SHCTX "${UNINSTKEY}" "Publisher" "${MANUFACTURER}"
  WriteRegStr SHCTX "${UNINSTKEY}" "InstallLocation" "$\"$INSTDIR$\""
  WriteRegStr SHCTX "${UNINSTKEY}" "UninstallString" "$\"$INSTDIR\uninstall.exe$\""
  WriteRegStr SHCTX "${UNINSTKEY}" "QuietUninstallString" "$\"$INSTDIR\uninstall.exe$\" /S"
  WriteRegDWORD SHCTX "${UNINSTKEY}" "NoModify" "1"
  WriteRegDWORD SHCTX "${UNINSTKEY}" "NoRepair" "1"
  WriteRegDWORD SHCTX "${UNINSTKEY}" "EstimatedSize" "${ESTIMATEDSIZE}"

  ; Remove legacy Electron uninstall and install registry entries in the same scope hive
  ; ONLY after Rune files and canonical uninstall entry are written (one uninstall ownership).
  ${If} $LegacyRegistryPresent = 1
  ${OrIf} $LegacyInstallDir != ""
  ${OrIf} $MigrationRetryFlag = 1
    DeleteRegKey SHCTX "${LEGACY_UNINST_KEY}"
    DeleteRegKey SHCTX "${LEGACY_INSTALL_KEY}"
  ${EndIf}
  DeleteRegValue SHCTX "${MANUPRODUCTKEY}" "MigrationInProgress"
  DeleteRegValue SHCTX "${MANUPRODUCTKEY}" "MigratedFrom"

  ; Clean up renamed legacy shortcut if legacy ShortcutName differed from ProductName
  ${If} $LegacyShortcutName != ""
  ${AndIf} $LegacyShortcutName != "${PRODUCTNAME}"
    Delete "$DESKTOP\$LegacyShortcutName.lnk"
    ${If} $LegacyMenuDirectory != ""
      Delete "$SMPROGRAMS\$LegacyMenuDirectory\$LegacyShortcutName.lnk"
      RMDir "$SMPROGRAMS\$LegacyMenuDirectory"
    ${Else}
      Delete "$SMPROGRAMS\$LegacyShortcutName.lnk"
    ${EndIf}
  ${EndIf}

  ; Update/create Start Menu and Desktop shortcuts
  ${If} ${Silent}
  ${OrIf} $PassiveMode = 1
    ${If} $NoShortcutsFlag <> 1
      ; Start Menu shortcut: update existing or create on fresh install / legacy handoff
      ${If} $IsUpgradeMode = 0
      ${OrIf} $HadStartMenuShortcut = 1
      ${OrIf} $KeepShortcutsFlag <> 1
        Call CreateStartMenuShortcut
      ${EndIf}

      ; Desktop shortcut: preserve existing shortcut on upgrades (updating target to Rune),
      ; and create on fresh install unless suppressed by `/NS` or `--no-desktop-shortcut`.
      ${If} $NoDesktopShortcutFlag <> 1
        ${If} $IsUpgradeMode = 1
          ${If} $HadDesktopShortcut = 1
            Call CreateDesktopShortcut
          ${EndIf}
        ${Else}
          Call CreateDesktopShortcut
        ${EndIf}
      ${EndIf}
    ${EndIf}
  ${Else}
    ; Interactive GUI mode
    !insertmacro MUI_STARTMENU_WRITE_BEGIN Application
      Call CreateStartMenuShortcut
    !insertmacro MUI_STARTMENU_WRITE_END

    ; If upgrading an install that already had a Desktop shortcut, refresh it immediately
    ; so it never remains pointing to removed legacy `Cowork.exe`.
    ${If} $HadDesktopShortcut = 1
      Call CreateDesktopShortcut
    ${EndIf}
  ${EndIf}

  ; Notify Windows Shell so updated shortcut icons/targets refresh immediately
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, p 0, p 0)'

  ; Auto-close installer window in passive mode
  ${IfThen} $PassiveMode = 1 ${|} SetAutoClose true ${|}
SectionEnd

Function .onInstSuccess
  ; Relaunch Rune ONCE in silent/passive modes when requested by `/R`, `--force-run`,
  ; or non-silent `--updated`. In interactive GUI mode, `MUI_FINISHPAGE_RUN` handles launch.
  ${If} ${Silent}
  ${OrIf} $PassiveMode = 1
    ${If} $ShouldRelaunch = 1
      StrCpy $ShouldRelaunch 0
      Exec '"$INSTDIR\${MAINBINARYNAME}.exe"'
    ${EndIf}
  ${EndIf}
FunctionEnd

Function un.onInit
  !insertmacro SetRegViewForTarget

  StrCpy $PassiveMode 0
  StrCpy $UnAlreadyElevated 0

  ClearErrors
  ${GetOptions} $CMDLINE "/P" $R0
  ${IfNot} ${Errors}
    StrCpy $PassiveMode 1
  ${EndIf}

  ClearErrors
  ${GetOptions} $CMDLINE "/COWORK_ELEVATED" $R0
  ${IfNot} ${Errors}
    StrCpy $UnAlreadyElevated 1
  ${EndIf}

  ; Determine whether this uninstaller belongs to an HKLM (per-machine) or HKCU (per-user) install
  ReadRegStr $R0 HKLM "${MANUPRODUCTKEY}" ""
  ReadRegStr $R1 HKCU "${MANUPRODUCTKEY}" ""
  StrCpy $R2 "current"
  ${If} $R0 != ""
    ${If} $R0 == $INSTDIR
    ${OrIf} $R1 == ""
      StrCpy $R2 "all"
    ${EndIf}
  ${EndIf}

  ${If} $R2 == "all"
    SetShellVarContext all
    System::Call 'shell32::IsUserAnAdmin()i.r0'
    ${If} $0 = 0
      ${If} $UnAlreadyElevated = 1
        ${IfNot} ${Silent}
          MessageBox MB_ICONSTOP "Administrator privileges are required to uninstall ${PRODUCTNAME}."
        ${EndIf}
        SetErrorLevel 5
        Quit
      ${EndIf}
      ; Prefer the installed `uninstall.exe` over the transient temp copy `$EXEPATH`
      ${If} ${FileExists} "$INSTDIR\uninstall.exe"
        StrCpy $1 "$INSTDIR\uninstall.exe"
      ${Else}
        StrCpy $1 "$EXEPATH"
      ${EndIf}
      StrCpy $2 "/COWORK_ELEVATED _?=$INSTDIR"
      ${If} ${Silent}
        StrCpy $2 "/S $2"
      ${EndIf}
      ${If} $PassiveMode = 1
        StrCpy $2 "/P $2"
      ${EndIf}
      System::Call 'shell32::ShellExecuteW(p $HWNDPARENT, w "runas", w r1, w r2, w "", i 1)i.r0'
      ${If} $0 <= 32
        SetErrorLevel 1223
        Quit
      ${EndIf}
      SetErrorLevel 0
      Quit
    ${EndIf}
  ${Else}
    SetShellVarContext current
  ${EndIf}

  !insertmacro MUI_UNGETLANGUAGE
FunctionEnd

Section Uninstall
  !insertmacro WaitAndCloseCoworkProcesses

  ; Remove installed Rune application files (never touch user data directories)
  Delete "$INSTDIR\${MAINBINARYNAME}.exe"

  ; Delete resources
  {{#each resources}}
    Delete "$INSTDIR\\{{this}}"
  {{/each}}

  ; Delete external binaries
  {{#each binaries}}
    Delete "$INSTDIR\\{{this}}"
  {{/each}}

  ; Delete file associations
  {{#each file_associations as |association| ~}}
    {{#each association.ext as |ext| ~}}
      !insertmacro APP_UNASSOCIATE "{{ext}}" "{{or association.name ext}}"
    {{/each}}
  {{/each}}

  ; Delete deep links
  {{#each deep_link_protocols as |protocol| ~}}
    ReadRegStr $R7 SHCTX "Software\Classes\\{{protocol}}\shell\open\command" ""
    ${If} $R7 == "$\"$INSTDIR\${MAINBINARYNAME}.exe$\" $\"%1$\""
      DeleteRegKey SHCTX "Software\Classes\\{{protocol}}"
    ${EndIf}
  {{/each}}

  ; Delete uninstaller and empty install directories
  Delete "$INSTDIR\uninstall.exe"

  {{#each resources_dirs}}
  RMDir /REBOOTOK "$INSTDIR\\{{this}}"
  {{/each}}
  RMDir "$INSTDIR"

  ; Remove Start Menu shortcuts (both foldered and top-level)
  ReadRegStr $AppStartMenuFolder SHCTX "${MANUPRODUCTKEY}" "StartMenuFolder"
  ${If} $AppStartMenuFolder != ""
    Delete "$SMPROGRAMS\$AppStartMenuFolder\${PRODUCTNAME}.lnk"
    RMDir "$SMPROGRAMS\$AppStartMenuFolder"
  ${EndIf}
  Delete "$SMPROGRAMS\${PRODUCTNAME}.lnk"
  Delete "$SMPROGRAMS\${PRODUCTNAME}\${PRODUCTNAME}.lnk"
  RMDir "$SMPROGRAMS\${PRODUCTNAME}"

  ; Remove Desktop shortcut
  Delete "$DESKTOP\${PRODUCTNAME}.lnk"

  ; Remove canonical and any leftover legacy registry ownership entries in this hive
  DeleteRegKey SHCTX "${UNINSTKEY}"
  DeleteRegKey SHCTX "${MANUPRODUCTKEY}"
  DeleteRegKey SHCTX "${LEGACY_UNINST_KEY}"
  DeleteRegKey SHCTX "${LEGACY_INSTALL_KEY}"

  ; Notify Windows Shell
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, p 0, p 0)'

  ${IfThen} $PassiveMode = 1 ${|} SetAutoClose true ${|}
SectionEnd

Function SkipIfPassive
  ${IfThen} $PassiveMode = 1 ${|} Abort ${|}
FunctionEnd

Function CreateDesktopShortcut
  CreateShortcut "$DESKTOP\${PRODUCTNAME}.lnk" "$INSTDIR\${MAINBINARYNAME}.exe"
  ApplicationID::Set "$DESKTOP\${PRODUCTNAME}.lnk" "${IDENTIFIER}"
FunctionEnd

Function CreateStartMenuShortcut
  ${If} $AppStartMenuFolder != ""
    CreateDirectory "$SMPROGRAMS\$AppStartMenuFolder"
    CreateShortcut "$SMPROGRAMS\$AppStartMenuFolder\${PRODUCTNAME}.lnk" "$INSTDIR\${MAINBINARYNAME}.exe"
    ApplicationID::Set "$SMPROGRAMS\$AppStartMenuFolder\${PRODUCTNAME}.lnk" "${IDENTIFIER}"
    Delete "$SMPROGRAMS\${PRODUCTNAME}.lnk"
  ${Else}
    CreateShortcut "$SMPROGRAMS\${PRODUCTNAME}.lnk" "$INSTDIR\${MAINBINARYNAME}.exe"
    ApplicationID::Set "$SMPROGRAMS\${PRODUCTNAME}.lnk" "${IDENTIFIER}"
  ${EndIf}
FunctionEnd
