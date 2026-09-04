@echo off
rem Puts the GPU watchdog switch in the notification area. Double-click me.
rem No window: the tray icon is the whole interface.
start "" powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "%~dp0tdr-tray.ps1"
