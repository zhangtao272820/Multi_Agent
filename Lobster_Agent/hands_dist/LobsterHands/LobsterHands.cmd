@echo off
setlocal
set ROOT=%~dp0..\..
cd /d "%ROOT%"
set LOBSTER_HANDS_ONLY=1
set LOBSTER_DESKTOP_MCP_ENABLED=1
set HOST=127.0.0.1
if "%LOBSTER_HANDS_PORT%"=="" set LOBSTER_HANDS_PORT=13109
set PORT=%LOBSTER_HANDS_PORT%
set NITRO_PORT=%PORT%
set NUXT_PORT=%PORT%
echo LobsterHands starting on http://127.0.0.1:%PORT%
node hands\launcher.mjs
endlocal
