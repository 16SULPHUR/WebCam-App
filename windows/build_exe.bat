@echo off
REM build_exe.bat
REM Packages the Windows Webcam Bridge into a standalone executable.

cd /d "%~dp0"

echo Installing pkg package locally if not present...
call npm install --save-dev pkg

echo Building standalone executable...
call npm run build

if exist usb_webcam_bridge.exe (
    echo.
    echo SUCCESS: Generated usb_webcam_bridge.exe!
    echo.
) else (
    echo.
    echo ERROR: Failed to generate executable.
    echo.
)
pause
