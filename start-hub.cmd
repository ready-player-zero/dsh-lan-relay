@echo off
setlocal
set CONFIG=%USERPROFILE%\.dsh\lan-relay\config.json
if not exist "%CONFIG%" (
  echo 找不到配置：%CONFIG%
  echo 请先运行：scripts\setup.ps1 -Role hub
  pause
  exit /b 1
)
node "%~dp0hub.mjs" --config "%CONFIG%"
echo.
echo hub 已退出（退出码 %ERRORLEVEL%）
pause
