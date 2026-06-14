!macro customInstall
  StrCpy $0 "$INSTDIR\resources\assets\badizo.ico"
  StrCpy $1 "$INSTDIR\${APP_EXECUTABLE_FILENAME}"

  ${if} ${FileExists} "$0"
    ${if} ${FileExists} "$DESKTOP\${SHORTCUT_NAME}.lnk"
      Delete "$DESKTOP\${SHORTCUT_NAME}.lnk"
      CreateShortCut "$DESKTOP\${SHORTCUT_NAME}.lnk" "$1" "" "$0" 0 "" "" "${APP_DESCRIPTION}"
      WinShell::SetLnkAUMI "$DESKTOP\${SHORTCUT_NAME}.lnk" "${APP_ID}"
    ${endIf}

    !ifdef MENU_FILENAME
      ${if} ${FileExists} "$SMPROGRAMS\${MENU_FILENAME}\${SHORTCUT_NAME}.lnk"
        Delete "$SMPROGRAMS\${MENU_FILENAME}\${SHORTCUT_NAME}.lnk"
        CreateShortCut "$SMPROGRAMS\${MENU_FILENAME}\${SHORTCUT_NAME}.lnk" "$1" "" "$0" 0 "" "" "${APP_DESCRIPTION}"
        WinShell::SetLnkAUMI "$SMPROGRAMS\${MENU_FILENAME}\${SHORTCUT_NAME}.lnk" "${APP_ID}"
      ${endIf}
    !else
      ${if} ${FileExists} "$SMPROGRAMS\${SHORTCUT_NAME}.lnk"
        Delete "$SMPROGRAMS\${SHORTCUT_NAME}.lnk"
        CreateShortCut "$SMPROGRAMS\${SHORTCUT_NAME}.lnk" "$1" "" "$0" 0 "" "" "${APP_DESCRIPTION}"
        WinShell::SetLnkAUMI "$SMPROGRAMS\${SHORTCUT_NAME}.lnk" "${APP_ID}"
      ${endIf}
    !endif

    System::Call 'Shell32::SHChangeNotify(i 0x8000000, i 0, i 0, i 0)'
  ${endIf}
!macroend
