/**
 * Hugging Face 模型下載模組
 * 透過 HF REST API 搜尋、瀏覽、下載 GGUF 模型（含分割模型支援）
 */

import https from 'https';
import fs from 'fs/promises';
import { createWriteStream } from 'fs';
import path from 'path';

// ==================== 常數 ====================

const HF_API_BASE = 'https://huggingface.co/api/models';
const HF_RESOLVE_BASE = 'https://huggingface.co';

// 分割 GGUF 檔名正則：<BaseName>-<ShardNum>-of-<ShardTotal>.gguf
const SPLIT_GGUF_REGEX = /^(.+)-(\d{5})-of-(\d{5})\.gguf$/;

// ==================== 活動下載追蹤 ====================

let activeDownloadController = null;

// ==================== 公開 API ====================

/**
 * 搜尋 HF Repo 並返回元資訊
 * @param {string} repoId - 例如 "unsloth/Qwen3-32B-GGUF"
 * @returns {Promise<{id: string, author: string, modelId: string, downloads: number, tags: string[]}>}
 */
export async function searchRepo(repoId) {
  const data = await fetchJson(`${HF_API_BASE}/${repoId}`);
  return {
    id: data.id || repoId,
    author: data.author || repoId.split('/')[0],
    modelId: data.modelId || repoId,
    downloads: data.downloads || 0,
    tags: data.tags || [],
    private: data.private || false
  };
}

/**
 * 列出 Repo 中的 GGUF 檔案，按量化變體分組
 * @param {string} repoId
 * @returns {Promise<Array<{variant: string, files: Array<{name: string, size: number}>, totalSize: number, shardCount: number, isSplit: boolean}>>}
 */
export async function listGGUFFiles(repoId) {
  const data = await fetchJson(`${HF_API_BASE}/${repoId}/revision/main`);
  const siblings = data.siblings || [];

  // 篩選 .gguf 檔案
  const ggufFiles = siblings
    .filter(s => s.rfilename.endsWith('.gguf'))
    .map(s => ({ name: s.rfilename, size: s.size || 0 }));

  if (ggufFiles.length === 0) {
    return [];
  }

  return groupByVariant(ggufFiles);
}

/**
 * 下載選定的模型檔案到指定目錄
 * @param {string} repoId
 * @param {string[]} fileNames - 要下載的檔案名稱陣列
 * @param {string} modelsPath - 模型儲存目錄
 * @param {function} onProgress - (percent: number, message: string, currentFile: string)
 * @returns {Promise<{success: boolean, message: string, downloadedFiles: string[]}>}
 */
export async function downloadModel(repoId, fileNames, modelsPath, onProgress) {
  activeDownloadController = { cancelled: false };
  const controller = activeDownloadController;
  const downloadedFiles = [];

  try {
    await fs.mkdir(modelsPath, { recursive: true });

    for (let i = 0; i < fileNames.length; i++) {
      if (controller.cancelled) {
        return { success: false, message: '下載已取消', downloadedFiles };
      }

      const fileName = fileNames[i];
      const fileUrl = `${HF_RESOLVE_BASE}/${repoId}/resolve/main/${fileName}`;
      const destPath = path.join(modelsPath, fileName);

      const fileProgress = (filePct) => {
        const overallPct = ((i + filePct) / fileNames.length) * 100;
        onProgress(
          Math.round(overallPct),
          `下載中 (${i + 1}/${fileNames.length})... ${Math.round(filePct * 100)}%`,
          fileName
        );
      };

      onProgress(
        Math.round((i / fileNames.length) * 100),
        `開始下載 ${fileName} (${i + 1}/${fileNames.length})`,
        fileName
      );

      await downloadFileWithProgress(fileUrl, destPath, fileProgress, controller);
      downloadedFiles.push(fileName);
    }

    activeDownloadController = null;
    return {
      success: true,
      message: `成功下載 ${downloadedFiles.length} 個檔案`,
      downloadedFiles
    };
  } catch (error) {
    activeDownloadController = null;
    if (controller.cancelled) {
      return { success: false, message: '下載已取消', downloadedFiles };
    }
    return { success: false, message: `下載失敗: ${error.message}`, downloadedFiles };
  }
}

/**
 * 取消正在進行的下載
 */
export function cancelDownload() {
  if (activeDownloadController) {
    activeDownloadController.cancelled = true;
  }
}

// ==================== 內部函數 ====================

/**
 * 將 GGUF 檔案按量化變體分組
 *
 * 邏輯：
 * 1. 先識別分割檔案（-00001-of-00005.gguf 格式）
 * 2. 同一 BaseName 的分割檔案歸為一組
 * 3. 單檔 GGUF 各自為一組
 * 4. 嘗試從檔名中提取量化標籤（如 Q4_K_M, UD-Q8_K_XL）
 */
function groupByVariant(ggufFiles) {
  const groups = new Map(); // variantKey → { variant, files[], isSplit }

  for (const file of ggufFiles) {
    const splitMatch = file.name.match(SPLIT_GGUF_REGEX);

    if (splitMatch) {
      // 分割檔案：baseName 作為 group key
      const baseName = splitMatch[1];
      if (!groups.has(baseName)) {
        groups.set(baseName, {
          variant: extractQuantLabel(baseName),
          files: [],
          isSplit: true
        });
      }
      groups.get(baseName).files.push(file);
    } else {
      // 單檔 GGUF
      const key = file.name;
      const baseName = file.name.replace(/\.gguf$/, '');
      groups.set(key, {
        variant: extractQuantLabel(baseName),
        files: [file],
        isSplit: false
      });
    }
  }

  // 排序每組中的分割檔案
  for (const group of groups.values()) {
    if (group.isSplit) {
      group.files.sort((a, b) => a.name.localeCompare(b.name));
    }
  }

  // 轉換為輸出格式
  return Array.from(groups.values()).map(group => ({
    variant: group.variant,
    files: group.files,
    totalSize: group.files.reduce((sum, f) => sum + f.size, 0),
    shardCount: group.files.length,
    isSplit: group.isSplit
  })).sort((a, b) => a.variant.localeCompare(b.variant));
}

/**
 * 從檔名中提取量化標籤
 * 例如: "Qwen3-32B-Q4_K_M" → "Q4_K_M"
 *       "Qwen3-32B-UD-Q8_K_XL" → "UD-Q8_K_XL"
 */
function extractQuantLabel(baseName) {
  // 常見量化標識符
  const quantPatterns = [
    /[_-](UD[_-]Q\d+[_A-Z]*\w*)/i,
    /[_-](IQ\d+[_A-Z]*\w*)/i,
    /[_-](Q\d+[_A-Z]*\w*)/i,
    /[_-](F16|F32|BF16)/i,
  ];

  for (const pattern of quantPatterns) {
    const match = baseName.match(pattern);
    if (match) return match[1].toUpperCase();
  }

  // 如果沒有匹配到量化標籤，返回完整檔名（截斷過長的部分）
  const parts = baseName.split('/');
  const name = parts[parts.length - 1];
  return name.length > 40 ? name.substring(name.length - 40) : name;
}

/**
 * 發送 HTTPS GET 請求並解析 JSON
 */
function fetchJson(url) {
  return new Promise((resolve, reject) => {
    const options = {
      headers: { 'User-Agent': 'llamacpp-distributed-inference' }
    };

    https.get(url, options, (res) => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        return fetchJson(res.headers.location).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) {
        reject(new Error(`HTTP ${res.statusCode}: ${url}`));
        return;
      }

      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          reject(new Error(`JSON 解析失敗: ${url}`));
        }
      });
    }).on('error', (e) => reject(new Error(`網路請求失敗: ${e.message}`)));
  });
}

/**
 * 帶進度的檔案下載（支援取消）
 */
function downloadFileWithProgress(url, dest, onProgress, controller) {
  return new Promise((resolve, reject) => {
    const makeRequest = (requestUrl) => {
      const mod = requestUrl.startsWith('https') ? https : require('http');
      const req = mod.get(requestUrl, (response) => {
        if (response.statusCode === 301 || response.statusCode === 302) {
          return makeRequest(response.headers.location);
        }
        if (response.statusCode !== 200) {
          reject(new Error(`下載失敗，HTTP ${response.statusCode}`));
          return;
        }

        const totalSize = parseInt(response.headers['content-length'], 10) || 0;
        let downloaded = 0;
        const file = createWriteStream(dest);

        response.on('data', (chunk) => {
          if (controller && controller.cancelled) {
            response.destroy();
            file.close();
            fs.unlink(dest).catch(() => {});
            reject(new Error('下載已取消'));
            return;
          }
          downloaded += chunk.length;
          if (totalSize > 0) onProgress(downloaded / totalSize);
        });

        response.pipe(file);
        file.on('finish', () => { file.close(); resolve(); });
        file.on('error', (err) => { fs.unlink(dest).catch(() => {}); reject(err); });
      });
      req.on('error', reject);
    };
    makeRequest(url);
  });
}
