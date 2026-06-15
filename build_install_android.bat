@echo off
REM build_install_android.bat
REM Automates building the Android app and installing it to the connected phone.

setlocal

echo === USB Webcam Bridge — Build and Install Android App ===
echo.

set "JAVA_HOME=F:\tools\jdk17\jdk-17.0.11+9"
echo Using JDK: %JAVA_HOME%
echo.

cd /d "f:\PROGRAMING\WebCam App\android"

echo [1/2] Building Android app with Gradle...
call .\gradlew.bat assembleDebug
if errorlevel 1 (
    echo.
    echo ERROR: Gradle build failed. Please check the logs above.
    pause
    exit /b 1
)

echo.
echo [2/2] Installing APK on connected phone...
adb install -r app\build\outputs\apk\debug\app-debug.apk
if errorlevel 1 (
    echo.
    echo ERROR: adb install failed. Is your phone connected and USB debugging enabled?
    pause
    exit /b 1
)

echo.
echo =======================================================
echo  SUCCESS: Android app built and installed successfully!
echo =======================================================
echo.
pause
endlocal
