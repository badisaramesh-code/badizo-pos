!macro customInstall
  CreateShortCut "$SMSTARTUP\Badizo Receipt Printer.lnk" "$INSTDIR\${APP_EXECUTABLE_FILENAME}" "--background"
!macroend

!macro customUnInstall
  Delete "$SMSTARTUP\Badizo Receipt Printer.lnk"
!macroend
