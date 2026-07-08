@echo off
cd /d "%~dp0backend"
"C:\Program Files\nodejs\node.exe" server.js >> "%~dp0backend-start-live.log" 2>&1
