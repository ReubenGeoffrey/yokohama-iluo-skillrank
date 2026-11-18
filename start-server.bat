@echo off
title Yokohama Admin Portal Server
echo Starting Yokohama Admin Portal on port 5000...
cd /d "%~dp0"
node server.js
pause
