# 發布指南

## 🚀 自動發布流程

本專案使用 GitHub Actions 自動構建和發布。

### 📋 發布步驟

#### 方法一：標籤發布（推薦）

1. **創建並推送標籤**
   ```bash
   git tag v1.0.0
   git push origin v1.0.0
   ```

2. **自動構建**
   - GitHub Actions 會自動檢測到新標籤
   - 在 Windows、macOS、Linux 三個平台上構建
   - 自動下載最新的 llama.cpp 二進位檔案

3. **自動發布**
   - 創建 Draft Release
   - 上傳所有平台的構建檔案
   - 生成發布說明

#### 方法二：手動觸發

1. **前往 Actions 頁面**
   - 進入 GitHub 專案的 Actions 標籤
   - 選擇 "Build and Release" workflow

2. **手動觸發**
   - 點擊 "Run workflow"
   - 輸入版本號（如 v1.0.0）
   - 可選：輸入 llama.cpp 版本（如 b5997）
   - 點擊 "Run workflow"

### 📦 構建產物

每次發布會產生以下檔案：

#### Windows
- `distributed-llm-inference-windows.exe` - NSIS 安裝程式
- `distributed-llm-inference-windows.zip` - 免安裝版本

#### macOS
- `distributed-llm-inference-macos.dmg` - DMG 安裝程式
- `distributed-llm-inference-macos.zip` - 免安裝版本

#### Linux
- `distributed-llm-inference-linux.AppImage` - AppImage 可執行檔
- `distributed-llm-inference-linux.tar.gz` - 免安裝版本

### ⚙️ 必要設定

#### GitHub Secrets
確保以下 Secrets 已設定：
- `GITHUB_TOKEN` - 自動提供，用於發布 Release

#### Repository 設定
1. **Actions 權限**
   - Settings → Actions → General
   - 確保 "Allow GitHub Actions to create and approve pull requests" 已啟用

2. **Release 權限**
   - Settings → Actions → General → Workflow permissions
   - 選擇 "Read and write permissions"

### 🔧 本地測試

#### 測試構建
```bash
# 安裝依賴
npm install

# 測試打包（不發布）
npm run pack

# 構建特定平台
npm run build:win    # Windows
npm run build:mac    # macOS  
npm run build:linux  # Linux
```

#### 自動下載二進位檔案
GitHub Actions 會自動下載 llama.cpp 二進位檔案：

1. **預設行為**
   - 自動下載最新版本的 llama.cpp
   - Windows: CUDA 版本
   - macOS: ARM64 版本
   - Linux: Ubuntu x64 版本

2. **自定義版本**
   - 手動觸發時可指定版本號
   - 可提供自定義下載 URL
   - 支援多個後備 URL

3. **手動更新二進位檔案**
   - 使用 "Download llama.cpp Binaries" workflow
   - 自動創建 PR 更新二進位檔案
   - 支援自定義 URL 和版本

#### 手動準備二進位檔案（如需要）
如果自動下載失敗，可手動準備：

1. **下載 llama.cpp**
   - 前往 [llama.cpp Releases](https://github.com/ggerganov/llama.cpp/releases)
   - 下載對應平台的編譯版本

2. **放置檔案**
   ```
   bin/
   ├── windows/
   │   ├── rpc-server.exe
   │   ├── llama-server.exe
   │   └── *.dll
   ├── macos/
   │   ├── rpc-server
   │   └── llama-server
   └── linux/
       ├── rpc-server
       └── llama-server
   ```

#### 更新二進位檔案
使用專用的 workflow 更新：

1. **前往 Actions → Download llama.cpp Binaries**
2. **點擊 "Run workflow"**
3. **設定參數**：
   - 版本號（如 b3259 或 latest）
   - 自定義 URL（可選）
4. **自動創建 PR** 包含更新的二進位檔案

### 📝 發布檢查清單

發布前確認：
- [ ] 版本號已更新（package.json）
- [ ] CHANGELOG 已更新
- [ ] 所有測試通過
- [ ] 二進位檔案相容性確認
- [ ] README 文檔已更新

發布後確認：
- [ ] 所有平台檔案已上傳
- [ ] Release 說明完整
- [ ] 下載連結正常
- [ ] 安裝測試通過

### 🐛 故障排除

#### 構建失敗
1. **檢查 Actions 日誌**
   - 查看具體錯誤訊息
   - 確認依賴安裝是否成功

2. **二進位檔案問題**
   - 確認 llama.cpp 下載連結有效
   - 檢查檔案權限設定

3. **發布權限問題**
   - 確認 GITHUB_TOKEN 權限
   - 檢查 Repository 設定

#### 下載問題
1. **檔案大小**
   - 確認檔案完整上傳
   - 檢查網路連接

2. **平台相容性**
   - 確認目標平台支援
   - 檢查依賴庫版本

### 📞 支援

如遇到發布相關問題，請：
1. 檢查 Actions 執行日誌
2. 查看 Issues 中的相關討論
3. 提交新的 Issue 並附上錯誤日誌