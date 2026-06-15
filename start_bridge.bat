@echo off
REM start_bridge.bat
REM Automatically wakes the Android app, sets up port forwarding, and starts the Windows bridge.

setlocal

echo ========================================================
echo   USB Webcam Bridge - Startup Script
echo ========================================================
echo.

echo Checking connection to your phone...
adb wait-for-device
if errorlevel 1 (
    echo.
    echo ERROR: Could not connect to phone.
    echo Please make sure:
    echo   1. Your phone is connected via USB.
    echo   2. USB Debugging is enabled in Developer Options.
    echo.
    pause
    exit /b 1
)
echo ✓ Phone connected successfully!
echo.

echo Launching USB Webcam Bridge app on phone...
adb shell am start -n com.example.usbwebcambridge/com.example.usbwebcambridge.MainActivity >nul 2>&1
if errorlevel 1 (
    echo WARNING: Could not launch app automatically. Please open "USB Webcam Bridge" manually on your phone.
) else (
    echo ✓ App launched on phone!
)
echo.

echo Setting up ADB port forward (localhost:8080 -> phone:8080)...
adb forward tcp:8080 tcp:8080
if errorlevel 1 (
    echo ERROR: ADB port forward failed.
    pause
    exit /b 1
)
echo ✓ Port forward ready!
echo.

echo ========================================================
echo Select your preferred Bridge option:
echo   [1] Standalone Windows GUI Application (EXE) [Recommended]
echo   [2] Web-Based Dashboard (Served on localhost:3000)
echo ========================================================
echo.

set "choice=2"
set /p "choice=Enter option [1 or 2, default is 2]: "

if "%choice%"=="2" (
    echo.
    echo Starting Web-Based Dashboard...
    echo Open your browser to: http://localhost:3000
    echo.
    cd /d "F:\PROGRAMING\WebCam App\windows"
    node index.js
) else (
    echo.
    echo Starting Standalone Windows GUI App...
    if exist usb_webcam_bridge_gui.exe (
        start "" usb_webcam_bridge_gui.exe
    ) else (
        echo ERROR: usb_webcam_bridge_gui.exe not found! Running python windows/gui_app.py...
        cd /d "F:\PROGRAMING\WebCam App\windows"
        start "" F:\tools\python312\pythonw.exe gui_app.py
    )
)

endlocal
