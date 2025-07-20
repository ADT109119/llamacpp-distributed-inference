# 模型資料夾

請將您的 GGUF 格式模型檔案放置在此資料夾中。

## 支援的模型格式
- `.gguf` 檔案

## 建議的模型來源
- [Hugging Face](https://huggingface.co/models?library=gguf)
- [TheBloke 的量化模型](https://huggingface.co/TheBloke)

## 範例模型檔案名稱
- `llama-2-7b-chat.Q4_K_M.gguf`
- `mistral-7b-instruct-v0.1.Q4_K_M.gguf`
- `codellama-7b-instruct.Q4_K_M.gguf`

## 注意事項
- 模型檔案可能很大（數 GB），請確保有足夠的磁碟空間
- 較大的模型需要更多的 RAM 和 VRAM
- 建議使用量化版本（如 Q4_K_M）以節省記憶體