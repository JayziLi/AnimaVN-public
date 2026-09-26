@echo off
rem Double-click to run: starts backend + frontend in their own windows, waits until
rem both answer, then opens the prompt console in the default browser.
rem ASCII only in this file to avoid codepage mojibake.
rem --host 0.0.0.0 / --host so phones on the same Wi-Fi can open http://[this PC's LAN IP]:5173
start "AnimaBackend" cmd /k "echo AnimaBackend API: http://localhost:8000 && echo Swagger docs: http://localhost:8000/docs && cd /d %~dp0AnimaBackend && .venv\Scripts\python.exe -m uvicorn app.main:app --host 0.0.0.0 --port 8000"
start "AnimaVN Frontend" cmd /k "echo AnimaVN: http://localhost:5173/debug.html && cd /d %~dp0frontend && npm run dev -- --host"

rem Opening the page before the backend is up would load it with empty lists,
rem so poll both servers first (1s apart, give up after 90s).
echo Waiting for AnimaBackend and the frontend to come up...
set tries=0
:wait
set /a tries+=1
if %tries% gtr 90 (
  echo Servers did not respond within 90s - check the two server windows for errors.
  pause
  exit /b 1
)
curl.exe -s -o nul --noproxy "*" http://127.0.0.1:8000/api/health || goto retry
curl.exe -s -o nul --noproxy "*" http://127.0.0.1:5173/debug.html || goto retry
start "" http://localhost:5173/debug.html
exit /b 0

:retry
ping -n 2 127.0.0.1 >nul
goto wait
