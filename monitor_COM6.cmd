@echo off
cd /d "%~dp0"
arduino-cli monitor --port COM6 --config baudrate=115200,dtr=off,rts=off
pause
