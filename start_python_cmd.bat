@echo off
title Python Portable Environment
set "PYTHON_DIR=%~dp0python-3.14.6-embed-amd64"
set "PATH=%PYTHON_DIR%;%PYTHON_DIR%\Scripts;%PATH%"

echo ========================================================
echo  Python Portable Environment Loaded!
echo  Python Path: %PYTHON_DIR%
echo ========================================================
cmd /k