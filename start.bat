@echo off
setlocal
cd /d "%~dp0"
chcp 65001
echo Starting VCP Chat Desktop...
if exist ".vcp_ready" del /q ".vcp_ready" >nul 2>&1
START "" /D "%~dp0" "NativeSplash.exe"
npm start
