@echo off
echo "正在啟動分佈式 LLM 推理應用程式..."
echo.

REM 檢查 Node.js 是否安裝
node --version >nul 2>&1
if %errorlevel% neq 0 (
    echo 錯誤: 未找到 Node.js，請先安裝 Node.js
    echo 下載地址: https://nodejs.org/
    pause
    exit /b 1
)

REM 檢查是否已安裝依賴
if not exist "node_modules" (
    echo 正在安裝依賴套件...
    npm install
    if %errorlevel% neq 0 (
        echo 錯誤: 依賴安裝失敗
        pause
        exit /b 1
    )
)

REM 檢查 models 目錄
if not exist "models" (
    mkdir models
    echo 已創建 models 目錄，請將 .gguf 模型檔案放入此目錄
)

REM 啟動應用程式
echo 啟動應用程式...
npm start

pause