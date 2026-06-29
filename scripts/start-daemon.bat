@echo off
setlocal
set "DAEMON_DIR=%~dp0.."
set "LOG_DIR=%~dp0..\logs"
if not exist "%LOG_DIR%" mkdir "%LOG_DIR%"
cd /d "%DAEMON_DIR%"
call npm run start >> "%LOG_DIR%\daemon.log" 2>&1
