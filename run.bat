@echo off
REM Recap-V2 pool solver - double-click to run. Reads .env (PROXY_MODE on/off + settings).
REM   run.bat          -> normal mode (clean log)
REM   run.bat debug    -> debug mode (full pipeline per request)
cd /d "%~dp0"
node pool-server.mjs %*
echo.
pause
