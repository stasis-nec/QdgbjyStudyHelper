@echo off
chcp 65001 >nul
title 创建桌面快捷方式
cd /d "%~dp0"

powershell -NoProfile -Command "$WshShell = New-Object -ComObject WScript.Shell; $Shortcut = $WshShell.CreateShortcut([Environment]::GetFolderPath('Desktop') + '\青岛干部网院学习助手.lnk'); $Shortcut.TargetPath = 'wscript.exe'; $Shortcut.Arguments = '\"%~dp0双击启动助手(无黑框).vbs\"'; $Shortcut.WorkingDirectory = '%~dp0'; $Shortcut.Description = '青岛干部网络学院全自动学习助手'; $Shortcut.Save()"

echo 快捷方式已成功创建到您的桌面！
pause
