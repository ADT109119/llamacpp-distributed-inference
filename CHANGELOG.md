# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.1.0] - 2026-05-24

### Added
- **目前載入模型狀態看板 (Active Model Dashboard Revamp)**:
  - 於控制面板上方新增視覺看板，即時顯示當前載入記憶體的模型名稱與運行狀態，並配有綠色呼吸燈特效。
  - 新增 **手動卸載模型 (Unload Model)** 功能與按鈕，允許在不關閉代理伺服器的情況下隨時釋放 RAM/VRAM。
  - 於客製化下拉選單與觸發鈕上以 `🟢 [作用中]` 標章標記目前已載入的模型，提供極佳的直覺度。
- **推理核心進階參數配置 (Advanced Engine Tuning)**:
  - 新增 **限制僅載入單一模型 (Restrict to Single Active Model)** 設定，阻止 API 請求自動觸發背景模型切换與載入，保證單一模型運行穩定。
  - 新增 **CPU 執行緒數 (CPU Threads)** 調節滑桿與設定，支援限制推理時使用的 CPU 核心數（`-t`）。
  - 新增 **GPU 裝置選擇 (GPU Device Selection)** 設定，支援多 GPU 環境下指定執行裝置（`--device`）。
- **模型設定記憶升級**:
  - 全面支持將新加入的執行緒、GPU 裝置選擇與限制單一模型設定寫入該模型的專屬 localStorage 配置檔案中，切換時自動同步還原。

### Fixed
- **Hugging Face 下載大小解析修正**:
  - 修復 HF 下載面板因 `siblings` 預設不回傳檔案大小導致所有變體皆顯示為 `0.00 GB` 的 Bug。在 API 請求中補上 `?blobs=true` 參數，使各 GGUF 模型大小與分片大小得以正確顯示與計算。

---

## [1.0.0] - 2026-04-26

### Added
- **專專案初始發布 (Initial Release)**:
  - 現代化深色/明亮模式介面。
  - 自動節點發現 (mDNS) 與手動添加網路運算節點。
  - 支援多節點分佈式 LLM 推理。
  - 內建 llama.cpp 核心自動更新器。
  - Hugging Face 模型下載器。
  - 自定義模型資料夾管理與 API Key 安全保護。
