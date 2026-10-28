@echo off
rem Hawkes now runs in the cloud (hawkesgen.ai). "auto-start.bat local" runs a copy on this PC instead.
if /I not "%~1"=="local" if exist "%USERPROFILE%\.hawkes\client.json" (
  echo Hawkes runs at https://gen.hawkesgen.ai/
  start "" "https://gen.hawkesgen.ai/"
  exit /b 0
)
cd /d "%~dp0"
title Hawkes Gen
powershell -NoProfile -Command "if (Get-NetTCPConnection -LocalPort 8790 -State Listen -ErrorAction SilentlyContinue) { exit 1 }"
if errorlevel 1 (
  echo Hawkes Gen is already running on http://127.0.0.1:8790
  start "" "http://127.0.0.1:8790/"
  exit /b 0
)
if not exist node_modules call npm install
if not exist .venv (
  echo Setting up the Python tools ^(.venv with rembg and Pillow^)...
  python -m venv .venv
  .venv\Scripts\python -m pip install "rembg[cpu]" pillow
)
echo Hawkes Gen: http://127.0.0.1:8790
start "" "http://127.0.0.1:8790/"
call npm start
