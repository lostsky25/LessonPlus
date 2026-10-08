@echo off
cd /d "%~dp0"
call pnpm run run %*
exit /b %ERRORLEVEL%
