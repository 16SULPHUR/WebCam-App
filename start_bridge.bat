@echo off
REM start_bridge.bat
REM Connects to your phone, sets up ADB port forwarding, and starts the bridge.
REM You can choose between the Node.js stack or the pure Python stack.

setlocal EnableDelayedExpansion

echo ========================================================
echo   USB Webcam Bridge - Startup Script
echo ========================================================
echo.

REM ── Check phone connection ──────────────────────────────────────────────────
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
echo [OK] Phone connected!
echo.

REM ── Launch Android app ──────────────────────────────────────────────────────
echo Launching USB Webcam Bridge app on phone...
adb shell am start -n com.example.usbwebcambridge/com.example.usbwebcambridge.MainActivity >nul 2>&1
if errorlevel 1 (
    echo [WARN] Could not launch app automatically. Open "USB Webcam Bridge" manually.
) else (
    echo [OK] App launched!
)
echo.

REM ── ADB port forward ────────────────────────────────────────────────────────
echo Setting up ADB port forward (localhost:8080 to phone:8080)...
adb forward tcp:8080 tcp:8080
if errorlevel 1 (
    echo ERROR: ADB port forward failed.
    pause
    exit /b 1
)
echo [OK] Port forward ready!
echo.

REM ── Stack selection ─────────────────────────────────────────────────────────
echo ========================================================
echo   Select Bridge Stack
echo ========================================================
echo.
echo   [1] Node.js    - index.js     (default, proven)
echo   [2] Python     - bridge_py    (new, pure Python)
echo.
set /p CHOICE="Enter choice (1 or 2) [default: 1]: "

if "!CHOICE!"=="2" goto USE_PYTHON
goto USE_NODE

REM ── Node.js stack ────────────────────────────────────────────────────────────
:USE_NODE
echo.
echo Starting Node.js bridge...
echo Dashboard: http://localhost:3000
echo.
cd /d "F:\PROGRAMING\WebCam App\windows"
node index.js
goto END

REM ── Python stack ─────────────────────────────────────────────────────────────
:USE_PYTHON
echo.
echo Starting Python bridge...
echo Dashboard: http://localhost:3000
echo.
cd /d "F:\PROGRAMING\WebCam App\windows"
"F:\tools\python312\python.exe" -c "import sys, os; sys.path.insert(0, os.getcwd()); import bridge_py.__main__; bridge_py.__main__.main()"
goto END

:END
endlocal
