@echo off
setlocal

set "PROCESS_LIST=%TEMP%\CodexProjectboard-%RANDOM%-%RANDOM%.tmp"
tasklist /FI "IMAGENAME eq ChatGPT.exe" /NH > "%PROCESS_LIST%" 2>&1
if errorlevel 1 (
  echo Unable to verify whether Codex is running.
  type "%PROCESS_LIST%"
  del /Q "%PROCESS_LIST%" >NUL 2>&1
  pause
  exit /b 3
)

find /I "ChatGPT.exe" < "%PROCESS_LIST%" >NUL
set "CODEX_RUNNING=%ERRORLEVEL%"
del /Q "%PROCESS_LIST%" >NUL 2>&1
if "%CODEX_RUNNING%"=="0" (
  echo Codex is still running.
  echo Fully exit Codex, then run this launcher again.
  pause
  exit /b 2
)

powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\start-projectboard-sidebar.ps1"
if errorlevel 1 (
  echo.
  echo Projectboard sidebar startup failed. Review the error above.
  pause
  exit /b 1
)

endlocal
