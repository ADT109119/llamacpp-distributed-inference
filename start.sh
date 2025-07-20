#!/bin/bash

echo "正在啟動分佈式 LLM 推理應用程式..."
echo

# 檢查 Node.js 是否安裝
if ! command -v node &> /dev/null; then
    echo "錯誤: 未找到 Node.js，請先安裝 Node.js"
    echo "安裝指令: sudo apt install nodejs npm  # Ubuntu/Debian"
    echo "         brew install node           # macOS"
    exit 1
fi

# 檢查是否已安裝依賴
if [ ! -d "node_modules" ]; then
    echo "正在安裝依賴套件..."
    npm install
    if [ $? -ne 0 ]; then
        echo "錯誤: 依賴安裝失敗"
        exit 1
    fi
fi

# 檢查 models 目錄
if [ ! -d "models" ]; then
    mkdir -p models
    echo "已創建 models 目錄，請將 .gguf 模型檔案放入此目錄"
fi

# 設定二進位檔案執行權限 (Linux/macOS)
if [ -d "bin" ]; then
    find bin -type f -name "rpc-server" -exec chmod +x {} \;
    find bin -type f -name "llama-server" -exec chmod +x {} \;
fi

# 啟動應用程式
echo "啟動應用程式..."
npm start