@echo off
title qtinterface Control Center

echo ===================================================
echo Starting qtinterface portable system...
echo ===================================================

set "ROOT_DIR=%~dp0"
set "PY_EXE=%ROOT_DIR%python-3.14.6-embed-amd64\python.exe"
set "PYTHONPATH=%ROOT_DIR%"

if not exist "%PY_EXE%" (
    echo [ERROR] Python environment not found: %PY_EXE%
    pause
    exit /b 1
)

if exist "%ROOT_DIR%qtplot\qtplot.exe" (
    echo [1/2] Launching QtPlot...
    start "" "%ROOT_DIR%qtplot\qtplot.exe"
)

echo [2/2] Starting Web API server (main.py)...
"%PY_EXE%" "%ROOT_DIR%main.py"

pause