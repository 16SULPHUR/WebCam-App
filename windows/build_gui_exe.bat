@echo off
REM build_gui_exe.bat
REM Compiles gui_app.py into a standalone GUI executable.

cd /d "%~dp0"

echo Building standalone GUI executable...
call F:\tools\python312\python.exe -m PyInstaller --onefile --noconsole gui_app.py

if exist dist\gui_app.exe (
    echo.
    echo SUCCESS: Generated dist\gui_app.exe!
    copy /y dist\gui_app.exe ..\usb_webcam_bridge_gui.exe
    echo ✓ Copied executable to root folder as usb_webcam_bridge_gui.exe!
    echo.
) else (
    echo.
    echo ERROR: Failed to generate executable.
    echo.
)
pause
