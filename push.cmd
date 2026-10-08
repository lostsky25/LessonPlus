@echo off
cd /d "%~dp0"
call pnpm run push %*
exit /b %ERRORLEVEL%
