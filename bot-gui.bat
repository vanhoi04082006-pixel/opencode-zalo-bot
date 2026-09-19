@echo off
start "" /min powershell -NoProfile -STA -ExecutionPolicy Bypass -WindowStyle Hidden -File "%~dp0bot-gui.ps1"
