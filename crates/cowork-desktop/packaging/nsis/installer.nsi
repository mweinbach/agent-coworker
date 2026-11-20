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
${UnStrStr}

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

; Dedicated exit code emitted ONLY when `/COWORK_DEFER_LAUNCH` is active and the user
; leaves "Run Cowork" checked on the interactive Finish page. The waiting non-elevated
; user-context parent translates this sentinel to exit code 0 and launches Rune once.
!define COWORK_EXIT_LAUNCH_REQUESTED 200

; Default to per-user execution level so standard per-user installs and updates never
; require UAC. When an existing legitimate per-machine (HKLM) install is adopted or
; `/allusers` is explicitly requested, `.onInit` elevates via ShellExecuteExW "runas",
; waits for completion in the user-context parent, propagates exit status, and performs
; at most one non-elevated launch on success while strictly isolating HKLM from HKCU.
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
Var RequestedAllUsersFlag
Var RequestedCurrentUserFlag
Var RequestedScope
Var ResolvedScope
Var ValidationScope
Var AlreadyElevatedFlag
Var DeferLaunchToParent
Var ExplicitInstDir
Var MigrationRetryFlag
Var IsUpgradeMode
Var ExistingRuneInstallDir
Var LegacyInstallDir
Var LegacyRegistryPresent
Var LegacyShortcutName
Var LegacyMenuDirectory
Var HkcuHasInstall
Var HklmHasInstall
Var HadDesktopShortcut
Var HadStartMenuShortcut
Var AppStartMenuFolder
Var UserAppDataDir
Var UserProfileDir
Var UserLocalAppDataDir
Var UsersRootDir
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
!define MUI_FINISHPAGE_RUN
!define MUI_FINISHPAGE_RUN_FUNCTION OnFinishPageRun
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

; Substring helper macro usable in both installer (`StrStr`) and uninstaller (`UnStrStr`) contexts
!macro CallStrStr PREFIX OUT HAYSTACK NEEDLE
  !if "${PREFIX}" == "un."
    ${UnStrStr} ${OUT} ${HAYSTACK} ${NEEDLE}
  !else
    ${StrStr} ${OUT} ${HAYSTACK} ${NEEDLE}
  !endif
!macroend

; Reject if PATH equals BASE or starts with BASE\ (case-insensitive)
!macro RejectIfPathOrPrefix PATH BASE LABEL
  ${If} "${BASE}" != ""
    ${If} ${PATH} == "${BASE}"
      Goto ${LABEL}
    ${EndIf}
    StrLen $R1 "${BASE}\"
    StrCpy $R2 ${PATH} $R1
    ${If} $R2 == "${BASE}\"
      Goto ${LABEL}
    ${EndIf}
  ${EndIf}
!macroend

; Capture user-context profile paths BEFORE `SetShellVarContext all` can switch `$APPDATA`
; to `C:\ProgramData`, ensuring user-profile exclusion stays active in every scope.
!macro CaptureUserContextDirs PREFIX
  SetShellVarContext current
  Push "$APPDATA"
  Call ${PREFIX}NormalizeDirPath
  Pop $UserAppDataDir
  Push "$PROFILE"
  Call ${PREFIX}NormalizeDirPath
  Pop $UserProfileDir
  Push "$LOCALAPPDATA"
  Call ${PREFIX}NormalizeDirPath
  Pop $UserLocalAppDataDir
  StrCpy $UsersRootDir ""
  ${If} $UserProfileDir != ""
    Push $UserProfileDir
    Call ${PREFIX}GetPathParent
    Pop $R0
    StrLen $R1 $R0
    ${If} $R1 > 3
      StrCpy $UsersRootDir $R0
    ${EndIf}
  ${EndIf}
!macroend

; Shared path-safety, elevation-wait, retry-delete, and empty-dir helpers for installer & uninstaller
!macro DefineCorePathAndElevationHelpers PREFIX
; Helper: strip surrounding quotes and trailing backslash (preserving drive root length)
Function ${PREFIX}NormalizeDirPath
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

; Helper: return parent directory of a Windows path (or "" if none)
Function ${PREFIX}GetPathParent
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

; Helper: return 1 if normalized path falls inside a forbidden system, user-profile data,
; or cross-scope subtree; return 0 otherwise.
Function ${PREFIX}IsForbiddenSubtree
  Exch $R0
  Push $R1
  Push $R2

  ; Always forbid Windows directory, active AppData, captured user Roaming AppData,
  ; `$PROFILE\AppData\Roaming`, and `$PROFILE\.cowork` (even after `SetShellVarContext all`).
  !insertmacro RejectIfPathOrPrefix $R0 "$WINDIR" ifs_forbidden
  !insertmacro RejectIfPathOrPrefix $R0 "$APPDATA" ifs_forbidden
  !insertmacro RejectIfPathOrPrefix $R0 "$UserAppDataDir" ifs_forbidden
  !insertmacro RejectIfPathOrPrefix $R0 "$PROFILE\AppData\Roaming" ifs_forbidden
  !insertmacro RejectIfPathOrPrefix $R0 "$UserProfileDir\AppData\Roaming" ifs_forbidden
  !insertmacro RejectIfPathOrPrefix $R0 "$PROFILE\.cowork" ifs_forbidden
  !insertmacro RejectIfPathOrPrefix $R0 "$UserProfileDir\.cowork" ifs_forbidden

  ; Reject ANY user's Roaming AppData or `.cowork` directory even under over-the-shoulder elevation
  !insertmacro CallStrStr "${PREFIX}" $R1 $R0 "\AppData\Roaming\"
  ${If} $R1 != ""
    Goto ifs_forbidden
  ${EndIf}
  StrCpy $R1 $R0 16 -16
  ${If} $R1 == "\AppData\Roaming"
    Goto ifs_forbidden
  ${EndIf}

  !insertmacro CallStrStr "${PREFIX}" $R1 $R0 "\.cowork\"
  ${If} $R1 != ""
    Goto ifs_forbidden
  ${EndIf}
  StrCpy $R1 $R0 8 -8
  ${If} $R1 == "\.cowork"
    Goto ifs_forbidden
  ${EndIf}

  ; Enforce strict install-scope directory boundaries so privileged per-machine (`all`)
  ; operations never target user-profile directories and per-user (`current`) operations
  ; never target Program Files.
  ${If} $ValidationScope == "all"
    !insertmacro RejectIfPathOrPrefix $R0 "$PROFILE" ifs_forbidden
    !insertmacro RejectIfPathOrPrefix $R0 "$UserProfileDir" ifs_forbidden
    !insertmacro RejectIfPathOrPrefix $R0 "$LOCALAPPDATA" ifs_forbidden
    !insertmacro RejectIfPathOrPrefix $R0 "$UserLocalAppDataDir" ifs_forbidden
    !insertmacro RejectIfPathOrPrefix $R0 "$UsersRootDir" ifs_forbidden
  ${ElseIf} $ValidationScope == "current"
    !insertmacro RejectIfPathOrPrefix $R0 "$PROGRAMFILES" ifs_forbidden
    !insertmacro RejectIfPathOrPrefix $R0 "$PROGRAMFILES64" ifs_forbidden
    !insertmacro RejectIfPathOrPrefix $R0 "$COMMONFILES" ifs_forbidden
    !insertmacro RejectIfPathOrPrefix $R0 "$COMMONFILES64" ifs_forbidden
  ${EndIf}

  StrCpy $R0 0
  Goto ifs_done

  ifs_forbidden:
  StrCpy $R0 1

  ifs_done:
  Pop $R2
  Pop $R1
  Exch $R0
FunctionEnd

; Helper: validate that a directory path is safe:
; - drive-rooted, canonical (`GetFullPathNameW`), no traversal/metacharacters/ADS
; - not a system/container root, user-profile data dir, or cross-scope location
; - full ancestor walk from target up to and including drive root verifying every existing
;   ancestor is a real directory (`0x10`), NOT a reparse point (`0x400`), its `GetLongPathNameW`
;   expansion is not in a forbidden subtree, and any `GetFileAttributesW` error other than
;   `ERROR_FILE_NOT_FOUND (2)` or `ERROR_PATH_NOT_FOUND (3)` is rejected as ambiguous ancestry.
; Input: candidate path on stack. Output: normalized path on stack, or "" if rejected.
Function ${PREFIX}ValidateInstallDir
  Exch $R0
  Push $R1
  Push $R2
  Push $0
  Push $1
  Push $2

  Push $R0
  Call ${PREFIX}NormalizeDirPath
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

  ; Reject secondary colons (NTFS ADS / device paths) after drive prefix
  StrCpy $R1 $R0 "" 2
  !insertmacro CallStrStr "${PREFIX}" $R2 $R1 ":"
  ${If} $R2 != ""
    Goto vid_reject
  ${EndIf}

  ; Reject leading/trailing spaces or trailing dots (ambiguous Win32 path normalization)
  StrCpy $R1 $R0 1
  ${If} $R1 == " "
    Goto vid_reject
  ${EndIf}
  StrCpy $R1 $R0 1 -1
  ${If} $R1 == " "
  ${OrIf} $R1 == "."
    Goto vid_reject
  ${EndIf}

  ; Reject UNC/double-backslash, dot/dot-dot traversal segments, forward slashes, or metacharacters
  !insertmacro CallStrStr "${PREFIX}" $R1 $R0 "\\"
  ${If} $R1 != ""
    Goto vid_reject
  ${EndIf}
  !insertmacro CallStrStr "${PREFIX}" $R1 $R0 "\..\"
  ${If} $R1 != ""
    Goto vid_reject
  ${EndIf}
  StrCpy $R1 $R0 3 -3
  ${If} $R1 == "\.."
    Goto vid_reject
  ${EndIf}
  !insertmacro CallStrStr "${PREFIX}" $R1 $R0 "\.\"
  ${If} $R1 != ""
    Goto vid_reject
  ${EndIf}
  StrCpy $R1 $R0 2 -2
  ${If} $R1 == "\."
    Goto vid_reject
  ${EndIf}
  !insertmacro CallStrStr "${PREFIX}" $R1 $R0 "/"
  ${If} $R1 != ""
    Goto vid_reject
  ${EndIf}
  !insertmacro CallStrStr "${PREFIX}" $R1 $R0 "*"
  ${If} $R1 != ""
    Goto vid_reject
  ${EndIf}
  !insertmacro CallStrStr "${PREFIX}" $R1 $R0 "?"
  ${If} $R1 != ""
    Goto vid_reject
  ${EndIf}
  StrCpy $0 '$\"'
  !insertmacro CallStrStr "${PREFIX}" $R1 $R0 $0
  ${If} $R1 != ""
    Goto vid_reject
  ${EndIf}
  !insertmacro CallStrStr "${PREFIX}" $R1 $R0 "<"
  ${If} $R1 != ""
    Goto vid_reject
  ${EndIf}
  !insertmacro CallStrStr "${PREFIX}" $R1 $R0 ">"
  ${If} $R1 != ""
    Goto vid_reject
  ${EndIf}
  !insertmacro CallStrStr "${PREFIX}" $R1 $R0 "|"
  ${If} $R1 != ""
    Goto vid_reject
  ${EndIf}

  ; Verify Win32 canonical equivalence via GetFullPathNameW (rejects ambiguous trailing dots/spaces)
  StrCpy $0 $R0
  StrCpy $1 ""
  System::Call 'kernel32::GetFullPathNameW(w r0, i ${NSIS_MAX_STRLEN}, t .r1, p 0)i.r2'
  ${If} $2 = 0
  ${OrIf} $2 >= ${NSIS_MAX_STRLEN}
    Goto vid_reject
  ${EndIf}
  Push $1
  Call ${PREFIX}NormalizeDirPath
  Pop $1
  ${If} $1 != $R0
    Goto vid_reject
  ${EndIf}

  ; Reject exact system and container roots
  ${If} $R0 == "$WINDIR"
  ${OrIf} $R0 == "$SYSDIR"
  ${OrIf} $R0 == "$PROGRAMFILES"
  ${OrIf} $R0 == "$PROGRAMFILES64"
  ${OrIf} $R0 == "$COMMONFILES"
  ${OrIf} $R0 == "$COMMONFILES64"
  ${OrIf} $R0 == "$LOCALAPPDATA"
  ${OrIf} $R0 == "$LOCALAPPDATA\Programs"
  ${OrIf} $R0 == "$UserLocalAppDataDir"
  ${OrIf} $R0 == "$UserLocalAppDataDir\Programs"
  ${OrIf} $R0 == "$APPDATA"
  ${OrIf} $R0 == "$UserAppDataDir"
  ${OrIf} $R0 == "$PROFILE"
  ${OrIf} $R0 == "$UserProfileDir"
  ${OrIf} $R0 == "$PROFILE\AppData"
  ${OrIf} $R0 == "$UserProfileDir\AppData"
  ${OrIf} $R0 == "$PROFILE\AppData\Local"
  ${OrIf} $R0 == "$UserProfileDir\AppData\Local"
  ${OrIf} $R0 == "$PROFILE\AppData\Local\Programs"
  ${OrIf} $R0 == "$UserProfileDir\AppData\Local\Programs"
  ${OrIf} $R0 == "$TEMP"
  ${OrIf} $R0 == "$DESKTOP"
  ${OrIf} $R0 == "$SMPROGRAMS"
    Goto vid_reject
  ${EndIf}
  ${If} $UsersRootDir != ""
  ${AndIf} $R0 == "$UsersRootDir"
    Goto vid_reject
  ${EndIf}

  ; Reject forbidden system, user-profile data, and cross-scope subtrees
  Push $R0
  Call ${PREFIX}IsForbiddenSubtree
  Pop $2
  ${If} $2 != 0
    Goto vid_reject
  ${EndIf}

  ; Verify drive root (e.g. `C:\`) exists, is a real directory, and is not a reparse point
  StrCpy $0 $R0 3
  System::Call 'kernel32::GetFileAttributesW(w r0)i.r1 ?e'
  Pop $2
  ${If} $1 = -1
    Goto vid_reject
  ${EndIf}
  IntOp $2 $1 & 0x10
  ${If} $2 = 0
    Goto vid_reject
  ${EndIf}
  IntOp $2 $1 & 0x400
  ${If} $2 != 0
    Goto vid_reject
  ${EndIf}

  ; Walk `$R0` and EVERY ancestor directory up to drive root checking for reparse points (0x400),
  ; non-directory segments, 8.3 short-name aliases into forbidden subtrees, or ambiguous errors.
  StrCpy $R1 $R0
  ${Do}
    StrLen $R2 $R1
    ${If} $R2 <= 3
      ${ExitDo}
    ${EndIf}

    StrCpy $0 $R1
    System::Call 'kernel32::GetFileAttributesW(w r0)i.r1 ?e'
    Pop $2
    ${If} $1 != -1
      IntOp $2 $1 & 0x10
      ${If} $2 = 0
        Goto vid_reject
      ${EndIf}
      IntOp $2 $1 & 0x400
      ${If} $2 != 0
        Goto vid_reject
      ${EndIf}

      ; Check `GetLongPathNameW` canonical expansion of each existing ancestor against forbidden subtrees
      StrCpy $1 ""
      System::Call 'kernel32::GetLongPathNameW(w r0, t .r1, i ${NSIS_MAX_STRLEN})i.r2'
      ${If} $2 > 0
      ${AndIf} $2 < ${NSIS_MAX_STRLEN}
        Push $1
        Call ${PREFIX}NormalizeDirPath
        Pop $1
        Push $1
        Call ${PREFIX}IsForbiddenSubtree
        Pop $2
        ${If} $2 != 0
          Goto vid_reject
        ${EndIf}
      ${EndIf}
    ${Else}
      ; Fail closed on ambiguous ancestry errors (anything other than NOT_FOUND / PATH_NOT_FOUND)
      ${If} $2 <> 2
      ${AndIf} $2 <> 3
        Goto vid_reject
      ${EndIf}
    ${EndIf}

    Push $R1
    Call ${PREFIX}GetPathParent
    Pop $R1
    ${If} $R1 == ""
      ${ExitDo}
    ${EndIf}
  ${Loop}

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

; Helper: elevate an executable via ShellExecuteExW (`runas`, `SEE_MASK_NOCLOSEPROCESS`),
; wait for completion with `WaitForSingleObject`, retrieve child exit code via
; `GetExitCodeProcess`, and close the process handle.
; Inputs on stack: exe path (pushed first), parameters (pushed second).
; Outputs on stack: top = child exit code (or Win32 error code on failure),
;                   next = 1 if elevated child launched and waited, 0 otherwise.
Function ${PREFIX}RunElevatedAndWait
  Exch $R1 ; parameters
  Exch
  Exch $R0 ; executable path
  Push $0
  Push $1
  Push $2
  Push $3
  Push $4
  Push $5
  Push $6
  Push $7
  Push $8
  Push $9

  StrCpy $9 0
  StrCpy $8 1223
  StrCpy $3 0
  StrCpy $4 0
  StrCpy $5 0
  StrCpy $6 0

  System::Call '*(&w16 "runas")p.r4'
  System::Call '*(&w${NSIS_MAX_STRLEN} R0)p.r5'
  System::Call '*(&w${NSIS_MAX_STRLEN} R1)p.r6'

  ${If} $4 != 0
  ${AndIf} $5 != 0
  ${AndIf} $6 != 0
    !if "${NSIS_PTR_SIZE}" > 4
      ; 64-bit SHELLEXECUTEINFOW (112 bytes; SEE_MASK_NOCLOSEPROCESS = 0x40, SW_SHOWNORMAL = 1)
      System::Call '*(i 112, i 0x40, p $HWNDPARENT, p r4, p r5, p r6, p 0, i 1, i 0, p 0, p 0, p 0, p 0, i 0, i 0, p 0, p 0)p.r3'
    !else
      ; 32-bit SHELLEXECUTEINFOW (60 bytes; SEE_MASK_NOCLOSEPROCESS = 0x40, SW_SHOWNORMAL = 1)
      System::Call '*(i 60, i 0x40, p $HWNDPARENT, p r4, p r5, p r6, p 0, i 1, p 0, p 0, p 0, p 0, i 0, p 0, p 0)p.r3'
    !endif
  ${EndIf}

  ${If} $3 != 0
    System::Call 'shell32::ShellExecuteExW(p r3)i.r0 ?e'
    Pop $1 ; Win32 GetLastError()
    ${If} $0 <> 0
      StrCpy $7 0
      !if "${NSIS_PTR_SIZE}" > 4
        System::Call '*$3(i, i, p, p, p, p, p, i, i, p, p, p, p, i, i, p, p.r7)'
      !else
        System::Call '*$3(i, i, p, p, p, p, p, i, p, p, p, p, i, p, p.r7)'
      !endif
      ${If} $7 != 0
        StrCpy $9 1
        System::Call 'kernel32::WaitForSingleObject(p r7, i -1)i.r0'
        StrCpy $8 1
        ${If} $0 = 0
          System::Call 'kernel32::GetExitCodeProcess(p r7, *i .r8)i.r2'
          ${If} $2 = 0
            StrCpy $8 1
          ${EndIf}
        ${EndIf}
        System::Call 'kernel32::CloseHandle(p r7)'
      ${Else}
        ; Fail closed if ShellExecuteExW returned no waitable process handle
        StrCpy $9 0
        StrCpy $8 1
      ${EndIf}
    ${Else}
      ${If} $1 <> 0
        StrCpy $8 $1
      ${Else}
        StrCpy $8 1223
      ${EndIf}
    ${EndIf}
    System::Free $3
  ${EndIf}

  ${If} $6 != 0
    System::Free $6
  ${EndIf}
  ${If} $5 != 0
    System::Free $5
  ${EndIf}
  ${If} $4 != 0
    System::Free $4
  ${EndIf}

  StrCpy $R0 $9 ; launched flag
  StrCpy $R1 $8 ; exit/error code
  Pop $9
  Pop $8
  Pop $7
  Pop $6
  Pop $5
  Pop $4
  Pop $3
  Pop $2
  Pop $1
  Pop $0
  Exch $R0
  Exch
  Exch $R1
FunctionEnd

; Helper: idempotent delete with short retry for transient AV / process-exit locks
Function ${PREFIX}DeleteFileWithRetry
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

; Helper: verify an existing path is a validated real directory and NOT a reparse point (0x400).
; Input: path on stack. Output: 1 if safe existing non-reparse directory, 0 otherwise.
Function ${PREFIX}IsSafeExistingNonReparseDir
  Exch $R0
  Push $0
  Push $1
  Push $2

  Push $R0
  Call ${PREFIX}ValidateInstallDir
  Pop $R0
  ${If} $R0 == ""
    StrCpy $R0 0
    Goto isenrd_done
  ${EndIf}

  StrCpy $0 $R0
  System::Call 'kernel32::GetFileAttributesW(w r0)i.r1 ?e'
  Pop $2
  ${If} $1 = -1
    StrCpy $R0 0
    Goto isenrd_done
  ${EndIf}
  IntOp $2 $1 & 0x10
  ${If} $2 = 0
    StrCpy $R0 0
    Goto isenrd_done
  ${EndIf}
  IntOp $2 $1 & 0x400
  ${If} $2 != 0
    StrCpy $R0 0
    Goto isenrd_done
  ${EndIf}

  StrCpy $R0 1

  isenrd_done:
  Pop $2
  Pop $1
  Pop $0
  Exch $R0
FunctionEnd

; Helper: delete a single known owned file only if its parent chain is validated
; (no reparse points / forbidden subtrees) and the target is a regular non-reparse file.
; Input: full file path on stack.
Function ${PREFIX}DeleteOwnedNonReparseFile
  Exch $R0
  Push $R1
  Push $0
  Push $1
  Push $2

  IfFileExists "$R0" 0 donrf_done

  Push $R0
  Call ${PREFIX}GetPathParent
  Pop $R1
  Push $R1
  Call ${PREFIX}IsSafeExistingNonReparseDir
  Pop $R1
  ${If} $R1 <> 1
    Goto donrf_done
  ${EndIf}

  StrCpy $0 $R0
  System::Call 'kernel32::GetFileAttributesW(w r0)i.r1 ?e'
  Pop $2
  ${If} $1 = -1
    Goto donrf_done
  ${EndIf}
  IntOp $2 $1 & 0x10
  ${If} $2 != 0
    Goto donrf_done
  ${EndIf}
  IntOp $2 $1 & 0x400
  ${If} $2 != 0
    Goto donrf_done
  ${EndIf}

  Delete "$R0"

  donrf_done:
  Pop $2
  Pop $1
  Pop $0
  Pop $R1
  Pop $R0
FunctionEnd

; Helper: same safety guards as `DeleteOwnedNonReparseFile`, with retry for transient file locks.
; Input: full file path on stack.
Function ${PREFIX}DeleteOwnedNonReparseFileWithRetry
  Exch $R0
  Push $R1
  Push $0
  Push $1
  Push $2

  IfFileExists "$R0" 0 donrfr_done

  Push $R0
  Call ${PREFIX}GetPathParent
  Pop $R1
  Push $R1
  Call ${PREFIX}IsSafeExistingNonReparseDir
  Pop $R1
  ${If} $R1 <> 1
    Goto donrfr_done
  ${EndIf}

  StrCpy $0 $R0
  System::Call 'kernel32::GetFileAttributesW(w r0)i.r1 ?e'
  Pop $2
  ${If} $1 = -1
    Goto donrfr_done
  ${EndIf}
  IntOp $2 $1 & 0x10
  ${If} $2 != 0
    Goto donrfr_done
  ${EndIf}
  IntOp $2 $1 & 0x400
  ${If} $2 != 0
    Goto donrfr_done
  ${EndIf}

  Push $R0
  Call ${PREFIX}DeleteFileWithRetry

  donrfr_done:
  Pop $2
  Pop $1
  Pop $0
  Pop $R1
  Pop $R0
FunctionEnd

; Helper: non-recursively remove known empty directories bottom-up from leafDir until stopRoot.
; Preserves any unknown files and never follows or removes reparse points.
; Inputs on stack: stopRoot (pushed first), leafDir (pushed second).
Function ${PREFIX}RemoveEmptyKnownSubdirChain
  Exch $R0 ; leafDir
  Exch
  Exch $R1 ; stopRoot
  Push $R2
  Push $0
  Push $1
  Push $2

  Push $R0
  Call ${PREFIX}NormalizeDirPath
  Pop $R0
  Push $R1
  Call ${PREFIX}NormalizeDirPath
  Pop $R1

  ${If} $R0 == ""
  ${OrIf} $R1 == ""
    Goto reksc_done
  ${EndIf}

  ${Do}
    ${If} $R0 == $R1
      ${ExitDo}
    ${EndIf}
    StrLen $R2 $R0
    ${If} $R2 <= 3
      ${ExitDo}
    ${EndIf}

    ; Ensure `$R0` is strictly inside `$R1\`
    StrLen $R2 "$R1\"
    StrCpy $0 $R0 $R2
    ${If} $0 != "$R1\"
      ${ExitDo}
    ${EndIf}

    ; Validate full ancestor chain before removing an empty directory
    Push $R0
    Call ${PREFIX}ValidateInstallDir
    Pop $2
    ${If} $2 == ""
      ${ExitDo}
    ${EndIf}

    StrCpy $0 $R0
    System::Call 'kernel32::GetFileAttributesW(w r0)i.r1 ?e'
    Pop $2
    ${If} $1 != -1
      IntOp $2 $1 & 0x10
      ${If} $2 = 0
        ${ExitDo}
      ${EndIf}
      IntOp $2 $1 & 0x400
      ${If} $2 != 0
        ${ExitDo}
      ${EndIf}
      ; Non-recursive RMDir: removes ONLY if empty, preserving unknown files
      RMDir "$R0"
    ${EndIf}

    Push $R0
    Call ${PREFIX}GetPathParent
    Pop $R0
    ${If} $R0 == ""
      ${ExitDo}
    ${EndIf}
  ${Loop}

  reksc_done:
  Pop $2
  Pop $1
  Pop $0
  Pop $R2
  Pop $R1
  Pop $R0
FunctionEnd
!macroend

!insertmacro DefineCorePathAndElevationHelpers ""
!insertmacro DefineCorePathAndElevationHelpers "un."

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

; Helper: verify a registered path is safe AND belongs to Cowork (or is a known migration retry).
; Input: candidate path on stack. Output: normalized path on stack, or "" if rejected.
Function ValidateRegisteredCoworkDir
  Exch $R0
  Push $R1

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
    Goto vrc_done
  ${EndIf}

  ; Only check `$R0\resources\app.asar` if `$R0\resources` itself is a non-reparse directory
  Push "$R0\resources"
  Call IsSafeExistingNonReparseDir
  Pop $R1
  ${If} $R1 = 1
  ${AndIf} ${FileExists} "$R0\resources\app.asar"
    Goto vrc_done
  ${EndIf}

  StrCpy $R0 ""

  vrc_done:
  Pop $R1
  Exch $R0
FunctionEnd

; Probe a single registry hive (`HKCU` or `HKLM`) strictly in isolation under its matching scope.
; Populates:
;   $ExistingRuneInstallDir, $LegacyInstallDir, $LegacyRegistryPresent,
;   $LegacyShortcutName, $LegacyMenuDirectory, $MigrationRetryFlag
!macro ProbeInstallInHive HIVE SCOPE
  StrCpy $ValidationScope "${SCOPE}"
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

; Helper: launch Rune (`${MAINBINARYNAME}.exe`) from a validated install directory
; strictly in a non-elevated user context. Never spawns an elevated Rune or sidecar.
; Input: install directory path on stack.
Function LaunchCoworkNonElevated
  Exch $R0
  Push $0
  Push $1

  Push $R0
  Call ValidateInstallDir
  Pop $R0
  ${If} $R0 == ""
    Goto lcne_done
  ${EndIf}

  ${IfNot} ${FileExists} "$R0\${MAINBINARYNAME}.exe"
    Goto lcne_done
  ${EndIf}

  System::Call 'shell32::IsUserAnAdmin()i.r0'
  ${If} $0 = 0
    ; Running in standard non-elevated user context (normal HKCU install or waiting
    ; user-context parent of an HKLM install): launch Rune directly in user context.
    Exec '"$R0\${MAINBINARYNAME}.exe"'
  ${Else}
    ; Installer was started already elevated (no non-elevated parent). Never launch
    ; Rune directly with an elevated token; only delegate through the desktop shell
    ; (`explorer.exe`) when an interactive shell window exists.
    System::Call 'user32::GetShellWindow()p.r1'
    ${If} $1 != 0
      Exec '"$WINDIR\explorer.exe" "$R0\${MAINBINARYNAME}.exe"'
    ${EndIf}
  ${EndIf}

  lcne_done:
  Pop $1
  Pop $0
  Pop $R0
FunctionEnd

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
  StrCpy $RequestedAllUsersFlag 0
  StrCpy $RequestedCurrentUserFlag 0
  StrCpy $RequestedScope ""
  StrCpy $ResolvedScope "current"
  StrCpy $ValidationScope "current"
  StrCpy $AlreadyElevatedFlag 0
  StrCpy $DeferLaunchToParent 0
  StrCpy $ExplicitInstDir 0
  StrCpy $MigrationRetryFlag 0
  StrCpy $IsUpgradeMode 0
  StrCpy $ExistingRuneInstallDir ""
  StrCpy $LegacyInstallDir ""
  StrCpy $LegacyRegistryPresent 0
  StrCpy $LegacyShortcutName ""
  StrCpy $LegacyMenuDirectory ""
  StrCpy $HkcuHasInstall 0
  StrCpy $HklmHasInstall 0
  StrCpy $HadDesktopShortcut 0
  StrCpy $HadStartMenuShortcut 0
  StrCpy $AppStartMenuFolder ""

  ; Capture user-context profile paths BEFORE `SetShellVarContext all` can ever run
  !insertmacro CaptureUserContextDirs ""

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
    StrCpy $RequestedAllUsersFlag 1
    StrCpy $RequestedScope "all"
  ${EndIf}

  ClearErrors
  ${GetOptions} $CmdParams "--allusers" $R0
  ${IfNot} ${Errors}
    StrCpy $RequestedAllUsersFlag 1
    StrCpy $RequestedScope "all"
  ${EndIf}

  ClearErrors
  ${GetOptions} $CmdParams "/currentuser" $R0
  ${IfNot} ${Errors}
    StrCpy $RequestedCurrentUserFlag 1
    StrCpy $RequestedScope "current"
  ${EndIf}

  ClearErrors
  ${GetOptions} $CmdParams "--currentuser" $R0
  ${IfNot} ${Errors}
    StrCpy $RequestedCurrentUserFlag 1
    StrCpy $RequestedScope "current"
  ${EndIf}

  ; Reject conflicting explicit scope flags immediately
  ${If} $RequestedAllUsersFlag = 1
  ${AndIf} $RequestedCurrentUserFlag = 1
    ${IfNot} ${Silent}
      MessageBox MB_ICONSTOP "Conflicting installation scope flags were specified."
    ${EndIf}
    SetErrorLevel 87
    Quit
  ${EndIf}

  ClearErrors
  ${GetOptions} $CmdParams "/COWORK_ELEVATED" $R0
  ${IfNot} ${Errors}
    StrCpy $AlreadyElevatedFlag 1
  ${EndIf}

  ClearErrors
  ${GetOptions} $CmdParams "/COWORK_DEFER_LAUNCH" $R0
  ${IfNot} ${Errors}
    StrCpy $DeferLaunchToParent 1
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

  ; Probe both hives strictly in isolation to detect existing ownership, reject scope
  ; changes, and reject ambiguous dual-hive installations.
  !insertmacro ProbeInstallInHive HKCU "current"
  ${If} $ExistingRuneInstallDir != ""
  ${OrIf} $LegacyInstallDir != ""
  ${OrIf} $MigrationRetryFlag = 1
    StrCpy $HkcuHasInstall 1
  ${EndIf}

  !insertmacro ProbeInstallInHive HKLM "all"
  ${If} $ExistingRuneInstallDir != ""
  ${OrIf} $LegacyInstallDir != ""
  ${OrIf} $MigrationRetryFlag = 1
    StrCpy $HklmHasInstall 1
  ${EndIf}

  ; Reject ambiguous dual-scope installations (both HKCU and HKLM registered)
  ${If} $HkcuHasInstall = 1
  ${AndIf} $HklmHasInstall = 1
    ${IfNot} ${Silent}
      MessageBox MB_ICONSTOP "Both per-user and per-machine ${PRODUCTNAME} installations were detected. Uninstall one before continuing."
    ${EndIf}
    SetErrorLevel 87
    Quit
  ${EndIf}

  ; Reject explicit scope changes against an existing installation in the opposite hive
  ${If} $RequestedScope == "all"
  ${AndIf} $HkcuHasInstall = 1
  ${AndIf} $HklmHasInstall = 0
    ${IfNot} ${Silent}
      MessageBox MB_ICONSTOP "Cannot change an existing per-user ${PRODUCTNAME} installation to per-machine scope."
    ${EndIf}
    SetErrorLevel 87
    Quit
  ${EndIf}

  ${If} $RequestedScope == "current"
  ${AndIf} $HklmHasInstall = 1
  ${AndIf} $HkcuHasInstall = 0
    ${IfNot} ${Silent}
      MessageBox MB_ICONSTOP "Cannot change an existing per-machine ${PRODUCTNAME} installation to per-user scope."
    ${EndIf}
    SetErrorLevel 87
    Quit
  ${EndIf}

  ; Resolve final scope cleanly
  !if "${INSTALLMODE}" == "perMachine"
    ${If} $RequestedScope == ""
    ${AndIf} $HkcuHasInstall = 0
      StrCpy $RequestedScope "all"
    ${EndIf}
  !endif

  ${If} $RequestedScope == "all"
  ${OrIf} $HklmHasInstall = 1
    StrCpy $ResolvedScope "all"
    StrCpy $ValidationScope "all"
    !insertmacro ProbeInstallInHive HKLM "all"
  ${Else}
    StrCpy $ResolvedScope "current"
    StrCpy $ValidationScope "current"
    !insertmacro ProbeInstallInHive HKCU "current"
  ${EndIf}

  ; Never allow a scope downgrade/change across our self-elevation boundary
  ${If} $AlreadyElevatedFlag = 1
  ${AndIf} $ResolvedScope != "all"
    SetErrorLevel 87
    Quit
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

      ; Validate explicit `/D=` BEFORE triggering UAC so unsafe/cross-scope paths fail fast
      ${If} $ExplicitInstDir = 1
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
      ${EndIf}

      ; Re-launch elevated, suppressing relaunch inside the elevated child so THIS
      ; user-context parent waits for completion, propagates exit status, and performs
      ; at most ONE non-elevated launch on success. Place internal flags BEFORE
      ; `$CmdParams` so any `/D=` remains last.
      StrCpy $2 "/COWORK_ELEVATED /COWORK_DEFER_LAUNCH /allusers"
      ${If} $CmdParams != ""
        StrCpy $2 "$2 $CmdParams"
      ${EndIf}
      ${If} $ExplicitInstDir = 1
        ${StrLoc} $3 "$2" "/D=" ">"
        ${If} $3 == ""
          StrCpy $2 "$2 /D=$INSTDIR"
        ${EndIf}
      ${EndIf}

      Push "$EXEPATH"
      Push "$2"
      Call RunElevatedAndWait
      Pop $8 ; child exit code (or Win32 error code)
      Pop $9 ; launched flag

      ${If} $9 = 0
        SetErrorLevel $8
        Quit
      ${EndIf}

      ; Translate interactive GUI "Run Cowork" sentinel back to exit code 0 + parent launch
      ${If} $8 = ${COWORK_EXIT_LAUNCH_REQUESTED}
        StrCpy $ShouldRelaunch 1
        StrCpy $8 0
      ${EndIf}

      ; Propagate any non-zero child failure without launching Rune
      ${If} $8 <> 0
        SetErrorLevel $8
        Quit
      ${EndIf}

      ; Elevated install succeeded: perform at most ONE non-elevated launch from this
      ; user-context parent using the validated installed HKLM location.
      ${If} $ShouldRelaunch = 1
        StrCpy $ShouldRelaunch 0
        ReadRegStr $R0 HKLM "${MANUPRODUCTKEY}" "InstallLocation"
        ${If} $R0 == ""
          ReadRegStr $R0 HKLM "${MANUPRODUCTKEY}" ""
        ${EndIf}
        ${If} $R0 == ""
          ReadRegStr $R0 HKLM "${UNINSTKEY}" "InstallLocation"
        ${EndIf}
        ${If} $R0 != ""
          Push $R0
          Call LaunchCoworkNonElevated
        ${EndIf}
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

  StrCpy $R0 $AppStartMenuFolder 1
  ${If} ${FileExists} "$SMPROGRAMS\${PRODUCTNAME}.lnk"
    StrCpy $HadStartMenuShortcut 1
  ${ElseIf} $AppStartMenuFolder != ""
  ${AndIf} $R0 != ">"
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

; Helper: surgically remove ONLY known owned legacy Electron runtime files from a validated
; Cowork directory without any recursive deletion (`RMDir /r`). Unknown files and all user
; profile directories (`%APPDATA%\Cowork`, `%APPDATA%\desktop`, `%USERPROFILE%\.cowork`)
; are strictly preserved.
Function CleanupValidatedLegacyElectronFiles
  ${If} $LegacyInstallDir == ""
    Return
  ${EndIf}

  ; Re-verify path safety and scope ownership immediately before removing any legacy file
  StrCpy $ValidationScope $ResolvedScope
  Push $LegacyInstallDir
  Call ValidateRegisteredCoworkDir
  Pop $R0
  ${If} $R0 == ""
    Return
  ${EndIf}
  StrCpy $LegacyInstallDir $R0

  ; Remove legacy main binary and uninstaller first (abort if legacy app is still locked)
  Push "$LegacyInstallDir\${LEGACY_EXECUTABLE_NAME}"
  Call DeleteOwnedNonReparseFileWithRetry
  ${If} ${FileExists} "$LegacyInstallDir\${LEGACY_EXECUTABLE_NAME}"
    Abort "$(failedToKillApp)"
  ${EndIf}

  Push "$LegacyInstallDir\${LEGACY_UNINSTALLER_NAME}"
  Call DeleteOwnedNonReparseFileWithRetry

  ; Remove known top-level Electron/Chromium runtime files (idempotent on retry)
  Push "$LegacyInstallDir\chrome_100_percent.pak"
  Call DeleteOwnedNonReparseFile
  Push "$LegacyInstallDir\chrome_200_percent.pak"
  Call DeleteOwnedNonReparseFile
  Push "$LegacyInstallDir\chrome_elf.dll"
  Call DeleteOwnedNonReparseFile
  Push "$LegacyInstallDir\resources.pak"
  Call DeleteOwnedNonReparseFile
  Push "$LegacyInstallDir\icudtl.dat"
  Call DeleteOwnedNonReparseFile
  Push "$LegacyInstallDir\v8_context_snapshot.bin"
  Call DeleteOwnedNonReparseFile
  Push "$LegacyInstallDir\snapshot_blob.bin"
  Call DeleteOwnedNonReparseFile
  Push "$LegacyInstallDir\ffmpeg.dll"
  Call DeleteOwnedNonReparseFile
  Push "$LegacyInstallDir\libEGL.dll"
  Call DeleteOwnedNonReparseFile
  Push "$LegacyInstallDir\libGLESv2.dll"
  Call DeleteOwnedNonReparseFile
  Push "$LegacyInstallDir\d3dcompiler_47.dll"
  Call DeleteOwnedNonReparseFile
  Push "$LegacyInstallDir\dxcompiler.dll"
  Call DeleteOwnedNonReparseFile
  Push "$LegacyInstallDir\dxil.dll"
  Call DeleteOwnedNonReparseFile
  Push "$LegacyInstallDir\vk_swiftshader.dll"
  Call DeleteOwnedNonReparseFile
  Push "$LegacyInstallDir\vk_swiftshader_icd.json"
  Call DeleteOwnedNonReparseFile
  Push "$LegacyInstallDir\vulkan-1.dll"
  Call DeleteOwnedNonReparseFile
  Push "$LegacyInstallDir\LICENSE.electron.txt"
  Call DeleteOwnedNonReparseFile
  Push "$LegacyInstallDir\LICENSES.chromium.html"
  Call DeleteOwnedNonReparseFile
  Push "$LegacyInstallDir\version"
  Call DeleteOwnedNonReparseFile
  Push "$LegacyInstallDir\debug.log"
  Call DeleteOwnedNonReparseFile

  ; Clean known owned files in `swiftshader` without recursive deletion
  Push "$LegacyInstallDir\swiftshader"
  Call IsSafeExistingNonReparseDir
  Pop $R0
  ${If} $R0 = 1
    Push "$LegacyInstallDir\swiftshader\libEGL.dll"
    Call DeleteOwnedNonReparseFile
    Push "$LegacyInstallDir\swiftshader\libGLESv2.dll"
    Call DeleteOwnedNonReparseFile
    Push "$LegacyInstallDir\swiftshader\vk_swiftshader.dll"
    Call DeleteOwnedNonReparseFile
    RMDir "$LegacyInstallDir\swiftshader"
  ${EndIf}

  ; Clean known Chromium locale `.pak` files in `locales` without recursive deletion
  Push "$LegacyInstallDir\locales"
  Call IsSafeExistingNonReparseDir
  Pop $R0
  ${If} $R0 = 1
    ClearErrors
    FindFirst $R1 $R2 "$LegacyInstallDir\locales\*.pak"
    ${DoWhile} $R2 != ""
      Push "$LegacyInstallDir\locales\$R2"
      Call DeleteOwnedNonReparseFile
      ClearErrors
      FindNext $R1 $R2
      ${If} ${Errors}
        StrCpy $R2 ""
      ${EndIf}
    ${Loop}
    ${If} $R1 != ""
      FindClose $R1
    ${EndIf}
    RMDir "$LegacyInstallDir\locales"
  ${EndIf}

  ; Clean known owned Electron `resources` files without recursive deletion (preserves unknown files)
  Push "$LegacyInstallDir\resources"
  Call IsSafeExistingNonReparseDir
  Pop $R0
  ${If} $R0 = 1
    Push "$LegacyInstallDir\resources\app.asar"
    Call DeleteOwnedNonReparseFileWithRetry
    Push "$LegacyInstallDir\resources\app-update.yml"
    Call DeleteOwnedNonReparseFile
    Push "$LegacyInstallDir\resources\elevate.exe"
    Call DeleteOwnedNonReparseFile
    Push "$LegacyInstallDir\resources\package-type"
    Call DeleteOwnedNonReparseFile

    ; Clean known legacy Electron tray icons
    Push "$LegacyInstallDir\resources\tray"
    Call IsSafeExistingNonReparseDir
    Pop $R1
    ${If} $R1 = 1
      Push "$LegacyInstallDir\resources\tray\icon.png"
      Call DeleteOwnedNonReparseFile
      Push "$LegacyInstallDir\resources\tray\icon.ico"
      Call DeleteOwnedNonReparseFile
      RMDir "$LegacyInstallDir\resources\tray"
    ${EndIf}

    ; Clean known legacy Electron sidecar and Windows sandbox helpers
    Push "$LegacyInstallDir\resources\binaries"
    Call IsSafeExistingNonReparseDir
    Pop $R1
    ${If} $R1 = 1
      Push "$LegacyInstallDir\resources\binaries\cowork-server-x86_64-pc-windows-msvc.exe"
      Call DeleteOwnedNonReparseFileWithRetry
      Push "$LegacyInstallDir\resources\binaries\cowork-server-aarch64-pc-windows-msvc.exe"
      Call DeleteOwnedNonReparseFileWithRetry
      Push "$LegacyInstallDir\resources\binaries\cowork-server-manifest.json"
      Call DeleteOwnedNonReparseFile
      Push "$LegacyInstallDir\resources\binaries\sidecar-manifest.json"
      Call DeleteOwnedNonReparseFile
      Push "$LegacyInstallDir\resources\binaries\cowork-win-sandbox.exe"
      Call DeleteOwnedNonReparseFileWithRetry
      Push "$LegacyInstallDir\resources\binaries\codex-windows-sandbox-setup.exe"
      Call DeleteOwnedNonReparseFileWithRetry
      Push "$LegacyInstallDir\resources\binaries\codex-command-runner.exe"
      Call DeleteOwnedNonReparseFileWithRetry
      Push "$LegacyInstallDir\resources\binaries\cowork-win-sandbox.sha256.json"
      Call DeleteOwnedNonReparseFile
      RMDir "$LegacyInstallDir\resources\binaries"
    ${EndIf}

    ; Remove known bundled resource files matching the Cowork resource layout under `resources\`
    {{#each resources}}
      Push "$LegacyInstallDir\resources\\{{this}}"
      Call DeleteOwnedNonReparseFile
    {{/each}}

    ; Remove now-empty known resource subdirectories bottom-up (non-recursive RMDir only)
    {{#each resources_dirs}}
      Push "$LegacyInstallDir\resources"
      Push "$LegacyInstallDir\resources\\{{this}}"
      Call RemoveEmptyKnownSubdirChain
    {{/each}}

    RMDir "$LegacyInstallDir\resources"
  ${EndIf}

  ; If adopting into a different directory (e.g. explicit `/D=`), remove old dir only if now empty
  ${If} $LegacyInstallDir != $INSTDIR
    RMDir "$LegacyInstallDir"
  ${EndIf}
FunctionEnd

Section Install
  ; Ensure target `$INSTDIR` is still safe and within the active scope (e.g. if changed interactively)
  StrCpy $ValidationScope $ResolvedScope
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

Function OnFinishPageRun
  ; In interactive GUI mode, when spawned by our non-elevated user-context parent,
  ; never launch Rune inside the elevated child; signal the waiting parent instead.
  ${If} $DeferLaunchToParent = 1
    SetErrorLevel ${COWORK_EXIT_LAUNCH_REQUESTED}
    Return
  ${EndIf}
  StrCpy $ValidationScope $ResolvedScope
  Push $INSTDIR
  Call LaunchCoworkNonElevated
FunctionEnd

Function .onInstSuccess
  ; When spawned by our non-elevated user-context parent, suppress relaunch inside
  ; the elevated child so the waiting parent performs at most one non-elevated launch.
  ${If} $DeferLaunchToParent = 1
    Return
  ${EndIf}

  ; Relaunch Rune ONCE in silent/passive modes when requested by `/R`, `--force-run`,
  ; or non-silent `--updated`. In interactive GUI mode, `OnFinishPageRun` handles launch.
  ${If} ${Silent}
  ${OrIf} $PassiveMode = 1
    ${If} $ShouldRelaunch = 1
      StrCpy $ShouldRelaunch 0
      StrCpy $ValidationScope $ResolvedScope
      Push $INSTDIR
      Call LaunchCoworkNonElevated
    ${EndIf}
  ${EndIf}
FunctionEnd

Function un.onInit
  !insertmacro SetRegViewForTarget

  StrCpy $PassiveMode 0
  StrCpy $UnAlreadyElevated 0
  StrCpy $ValidationScope "current"

  ; Capture user-context profile paths BEFORE `SetShellVarContext all` can ever run
  !insertmacro CaptureUserContextDirs "un."

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

  ; Normalize `$INSTDIR` before matching against HKLM / HKCU registrations
  Push $INSTDIR
  Call un.NormalizeDirPath
  Pop $INSTDIR

  ; Read normalized registered install paths from HKLM and HKCU strictly in isolation
  ReadRegStr $R0 HKLM "${MANUPRODUCTKEY}" ""
  ${If} $R0 == ""
    ReadRegStr $R0 HKLM "${MANUPRODUCTKEY}" "InstallLocation"
  ${EndIf}
  ${If} $R0 == ""
    ReadRegStr $R0 HKLM "${UNINSTKEY}" "InstallLocation"
  ${EndIf}
  ${If} $R0 != ""
    Push $R0
    Call un.NormalizeDirPath
    Pop $R0
  ${EndIf}

  ReadRegStr $R1 HKCU "${MANUPRODUCTKEY}" ""
  ${If} $R1 == ""
    ReadRegStr $R1 HKCU "${MANUPRODUCTKEY}" "InstallLocation"
  ${EndIf}
  ${If} $R1 == ""
    ReadRegStr $R1 HKCU "${UNINSTKEY}" "InstallLocation"
  ${EndIf}
  ${If} $R1 != ""
    Push $R1
    Call un.NormalizeDirPath
    Pop $R1
  ${EndIf}

  StrCpy $R3 0
  StrCpy $R4 0
  ${If} $R0 != ""
  ${AndIf} $R0 == $INSTDIR
    StrCpy $R3 1
  ${EndIf}
  ${If} $R1 != ""
  ${AndIf} $R1 == $INSTDIR
    StrCpy $R4 1
  ${EndIf}

  ; Reject ambiguous dual-hive ownership for `$INSTDIR`
  ${If} $R3 = 1
  ${AndIf} $R4 = 1
    ${IfNot} ${Silent}
      MessageBox MB_ICONSTOP "Ambiguous per-user and per-machine ${PRODUCTNAME} registrations were found for this directory."
    ${EndIf}
    SetErrorLevel 87
    Quit
  ${EndIf}

  StrCpy $R2 "current"
  ${If} $R3 = 1
    StrCpy $R2 "all"
  ${ElseIf} $R4 = 1
    StrCpy $R2 "current"
  ${Else}
    ; Do not escalate privileges or uninstall an unregistered directory when HKLM owns a different path
    ${If} $UnAlreadyElevated = 1
      SetErrorLevel 87
      Quit
    ${EndIf}
    ${If} $R0 != ""
    ${AndIf} $R1 == ""
      SetErrorLevel 87
      Quit
    ${EndIf}
  ${EndIf}

  StrCpy $ValidationScope $R2

  ${If} $R2 == "all"
    ; Validate `$INSTDIR` under per-machine scope BEFORE requesting UAC elevation
    Push $INSTDIR
    Call un.ValidateInstallDir
    Pop $R5
    ${If} $R5 == ""
      SetErrorLevel 87
      Quit
    ${EndIf}
    StrCpy $INSTDIR $R5

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

      ; Prefer the installed `uninstall.exe` WITHOUT `_?=$INSTDIR` so NSIS uses its
      ; standard temp-copy self-removal mechanism (copying itself to `%TEMP%` before
      ; running cleanup, allowing `$INSTDIR\uninstall.exe` and `$INSTDIR` to be removed).
      ; Keep `_?=$INSTDIR` strictly for the `$EXEPATH` fallback when already relocated.
      ${If} ${FileExists} "$INSTDIR\uninstall.exe"
        StrCpy $1 "$INSTDIR\uninstall.exe"
        StrCpy $2 "/COWORK_ELEVATED"
      ${Else}
        StrCpy $1 "$EXEPATH"
        StrCpy $2 "/COWORK_ELEVATED _?=$INSTDIR"
      ${EndIf}
      ${If} ${Silent}
        StrCpy $2 "/S $2"
      ${EndIf}
      ${If} $PassiveMode = 1
        StrCpy $2 "/P $2"
      ${EndIf}

      Push "$1"
      Push "$2"
      Call un.RunElevatedAndWait
      Pop $8 ; child exit code (or Win32 error code)
      Pop $9 ; launched flag
      SetErrorLevel $8
      Quit
    ${EndIf}
  ${Else}
    SetShellVarContext current
    Push $INSTDIR
    Call un.ValidateInstallDir
    Pop $R5
    ${If} $R5 == ""
      SetErrorLevel 87
      Quit
    ${EndIf}
    StrCpy $INSTDIR $R5
  ${EndIf}

  !insertmacro MUI_UNGETLANGUAGE
FunctionEnd

Section Uninstall
  ; Re-validate `$INSTDIR` before deleting any files
  Push $INSTDIR
  Call un.ValidateInstallDir
  Pop $R0
  ${If} $R0 == ""
    Abort "Invalid installation directory."
  ${EndIf}
  StrCpy $INSTDIR $R0

  !insertmacro WaitAndCloseCoworkProcesses

  ; Remove installed Rune application files (only known non-reparse files; never touch user data)
  Push "$INSTDIR\${MAINBINARYNAME}.exe"
  Call un.DeleteOwnedNonReparseFileWithRetry

  ; Delete resources
  {{#each resources}}
    Push "$INSTDIR\\{{this}}"
    Call un.DeleteOwnedNonReparseFile
  {{/each}}

  ; Delete external binaries
  {{#each binaries}}
    Push "$INSTDIR\\{{this}}"
    Call un.DeleteOwnedNonReparseFileWithRetry
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

  ; Delete uninstaller (running from `%TEMP%` via standard NSIS temp-copy) and empty known dirs
  Push "$INSTDIR\uninstall.exe"
  Call un.DeleteOwnedNonReparseFileWithRetry

  {{#each resources_dirs}}
  Push "$INSTDIR"
  Push "$INSTDIR\\{{this}}"
  Call un.RemoveEmptyKnownSubdirChain
  {{/each}}
  RMDir "$INSTDIR"

  ; Remove Start Menu shortcuts (both foldered and top-level; ignore MUI2 `>` disabled sentinel)
  ReadRegStr $AppStartMenuFolder SHCTX "${MANUPRODUCTKEY}" "StartMenuFolder"
  StrCpy $R0 $AppStartMenuFolder 1
  ${If} $AppStartMenuFolder != ""
  ${AndIf} $R0 != ">"
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
  StrCpy $R0 $AppStartMenuFolder 1
  ${If} $R0 == ">"
    ; MUI2 stores a leading `>` sentinel when "Do not create shortcuts" was selected
    Return
  ${EndIf}
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
