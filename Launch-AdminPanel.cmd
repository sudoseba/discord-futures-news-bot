@echo off
setlocal
title Discord News Bot - Admin Panel

REM ==================================================================
REM  DOUBLE-CLICK THIS FILE (Launch-AdminPanel.cmd) to open the panel.
REM
REM  Do NOT double-click AdminPanel.ps1 directly: Windows' default
REM  action for a .ps1 file is "Edit", which opens Notepad. That is a
REM  Windows setting, not a bug in the script. This launcher runs the
REM  script in a PowerShell (STA) host for you.
REM ==================================================================

pushd "%~dp0"

powershell.exe -NoProfile -ExecutionPolicy Bypass -STA -File "%~dp0AdminPanel.ps1"
set "RC=%ERRORLEVEL%"

popd

if not "%RC%"=="0" (
    echo.
    echo ------------------------------------------------------------------
    echo  The admin panel exited with code %RC%.
    echo  If no window appeared, copy any red error text above.
    echo  Common cause: Node.js not installed, or PowerShell blocked by
    echo  an admin policy. Try running from a terminal instead:
    echo      powershell -STA -ExecutionPolicy Bypass -File AdminPanel.ps1
    echo ------------------------------------------------------------------
    pause
)

endlocal
