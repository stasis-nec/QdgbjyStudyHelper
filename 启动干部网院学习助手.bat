@echo off
setlocal
chcp 65001 >nul
title 青岛干部网络学院 - 自动化学习助手
cd /d "%~dp0"

where pyw.exe >nul 2>nul
if not errorlevel 1 goto run_pyw

where pythonw.exe >nul 2>nul
if not errorlevel 1 goto run_pythonw

for %%V in (314 313 312 311 310 39) do if exist "%LocalAppData%\Programs\Python\Python%%V\pythonw.exe" (
    set "PYTHON_EXE=%LocalAppData%\Programs\Python\Python%%V\pythonw.exe"
    goto run_path
)

where python.exe >nul 2>nul
if not errorlevel 1 goto run_python

echo 未检测到可用的 Python 3。
echo 请安装 Python 3，并在安装时勾选“Add python.exe to PATH”。
echo 油猴脚本本身可以脱离桌面端独立运行。
pause
exit /b 1

:run_pyw
start "" pyw.exe -3 "%~dp0main.py"
exit /b

:run_pythonw
start "" pythonw.exe "%~dp0main.py"
exit /b

:run_path
start "" "%PYTHON_EXE%" "%~dp0main.py"
exit /b

:run_python
python.exe "%~dp0main.py"
exit /b
