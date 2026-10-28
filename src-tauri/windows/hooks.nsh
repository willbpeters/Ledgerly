; Ledgerly was renamed Tally. The installer files an app under its display
; name, so without this an update would install Tally beside Ledgerly and leave
; Ledgerly's program, shortcuts and "Installed apps" entry behind.
;
; After Tally installs, this removes those, putting a Tally shortcut wherever a
; Ledgerly one was (an update only refreshes shortcuts that already exist under
; the new name). It never touches %APPDATA%\com.ledgerly.app: the identifier
; did not change, so Tally keeps using that data.
!macro NSIS_HOOK_POSTINSTALL
  StrCpy $R9 "$LOCALAPPDATA\Ledgerly"
  ${If} "$INSTDIR" != "$R9"
  ${AndIf} ${FileExists} "$R9\ledgerly.exe"
    ${If} ${FileExists} "$SMPROGRAMS\Ledgerly.lnk"
      Delete "$SMPROGRAMS\Ledgerly.lnk"
      ${IfNot} ${FileExists} "$SMPROGRAMS\${PRODUCTNAME}.lnk"
        CreateShortcut "$SMPROGRAMS\${PRODUCTNAME}.lnk" "$INSTDIR\${MAINBINARYNAME}.exe"
        !insertmacro SetLnkAppUserModelId "$SMPROGRAMS\${PRODUCTNAME}.lnk"
      ${EndIf}
    ${EndIf}
    ${If} ${FileExists} "$DESKTOP\Ledgerly.lnk"
      Delete "$DESKTOP\Ledgerly.lnk"
      ${IfNot} ${FileExists} "$DESKTOP\${PRODUCTNAME}.lnk"
        CreateShortcut "$DESKTOP\${PRODUCTNAME}.lnk" "$INSTDIR\${MAINBINARYNAME}.exe"
        !insertmacro SetLnkAppUserModelId "$DESKTOP\${PRODUCTNAME}.lnk"
      ${EndIf}
    ${EndIf}
    Delete "$R9\ledgerly.exe"
    Delete "$R9\uninstall.exe"
    RMDir "$R9"
    DeleteRegKey HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\Ledgerly"
    DeleteRegKey HKCU "Software\ledgerly\Ledgerly"
  ${EndIf}
!macroend
