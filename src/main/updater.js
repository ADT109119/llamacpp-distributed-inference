/**
 * llama.cpp 核心更新模組
 * 從 ggml-org/llama.cpp GitHub Releases 下載最新二進位檔
 */

import https from 'https';
import http from 'http';
import fs from 'fs/promises';
import { createWriteStream, existsSync } from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import Store from 'electron-store';
import { getBinDir, getPlatformId } from './utils.js';

const store = new Store();

// ==================== 常數 ====================

const GITHUB_API = 'https://api.github.com/repos/ggml-org/llama.cpp/releases/latest';
const GITHUB_RELEASES = 'https://github.com/ggml-org/llama.cpp/releases/download';

// 各平台預設變體對應表
const PLATFORM_DEFAULTS = {
  windows: 'cuda-12.4',
  macos: 'arm64',
  linux: 'x64'
};

// CUDA DLL 附帶下載映射
const CUDA_DLL_MAP = {
  'cuda-12.4': 'cudart-llama-bin-win-cuda-12.4-x64.zip',
  'cuda-13.1': 'cudart-llama-bin-win-cuda-13.1-x64.zip'
};

// ==================== 公開 API ====================

/**
 * 查詢最新版本並與本地版本比對
 * @returns {Promise<{currentVersion: string, latestVersion: string, hasUpdate: boolean, releaseUrl: string}>}
 */
export async function checkForUpdates() {
  const currentVersion = store.get('llamacppVersion', '未安裝');
  const releaseInfo = await fetchLatestRelease();
  const latestVersion = releaseInfo.tag_name;

  return {
    currentVersion,
    latestVersion,
    hasUpdate: currentVersion !== latestVersion,
    releaseUrl: releaseInfo.html_url
  };
}

/**
 * 獲取當前平台可用的 asset 列表
 * @returns {Promise<Array<{name: string, label: string, downloadUrl: string, size: number, isDefault: boolean}>>}
 */
export async function getAvailableAssets() {
  const releaseInfo = await fetchLatestRelease();
  const platform = getPlatformId();
  const tag = releaseInfo.tag_name;

  // 過濾出當前平台的 assets
  const platformAssets = releaseInfo.assets.filter(asset => {
    const name = asset.name;
    if (platform === 'windows') return name.startsWith(`llama-${tag}-bin-win-`) && name.endsWith('.zip');
    if (platform === 'macos') return name.startsWith(`llama-${tag}-bin-macos-`) && name.endsWith('.tar.gz');
    if (platform === 'linux') return name.startsWith(`llama-${tag}-bin-ubuntu-`) && name.endsWith('.tar.gz');
    return false;
  });

  const defaultVariant = PLATFORM_DEFAULTS[platform];

  return platformAssets.map(asset => {
    // 從檔名中提取變體標籤
    const label = extractVariantLabel(asset.name, tag, platform);
    return {
      name: asset.name,
      label,
      downloadUrl: asset.browser_download_url,
      size: asset.size,
      isDefault: label.toLowerCase().includes(defaultVariant)
    };
  });
}

/**
 * 獲取當前已安裝的 llama.cpp 版本
 * @returns {string}
 */
export function getCurrentVersion() {
  return store.get('llamacppVersion', '未安裝');
}

/**
 * 下載並安裝 llama.cpp 二進位檔案
 * @param {string} assetUrl - 主 asset 下載 URL
 * @param {string} assetName - asset 檔案名稱
 * @param {string} tag - release tag（用於儲存版本號）
 * @param {function} onProgress - 進度回報 (percent: number, message: string)
 * @returns {Promise<{success: boolean, message: string}>}
 */
export async function downloadAndInstall(assetUrl, assetName, tag, onProgress) {
  const binDir = getBinDir();
  const platform = getPlatformId();
  const tempDir = path.join(binDir, '__update_temp');

  try {
    // 確保目標目錄存在
    await fs.mkdir(binDir, { recursive: true });
    await fs.mkdir(tempDir, { recursive: true });

    // ---- 步驟 1：下載主 asset ----
    const mainZipPath = path.join(tempDir, assetName);
    let needDownloadMain = true;
    try {
      if (existsSync(mainZipPath)) {
        const stats = await fs.stat(mainZipPath);
        if (stats.size > 0) {
          needDownloadMain = false;
        }
      }
    } catch {}

    if (needDownloadMain) {
      onProgress(5, `正在下載 ${assetName}...`);
      await downloadFile(assetUrl, mainZipPath, (pct) => {
        onProgress(5 + pct * 0.6, `下載中... ${Math.round(pct * 100)}%`);
      });
    } else {
      onProgress(65, `使用暫存的主檔案 ${assetName}...`);
    }

    // ---- 步驟 2：如果是 CUDA 變體，附帶下載 DLL ----
    if (platform === 'windows') {
      for (const [cudaKey, dllName] of Object.entries(CUDA_DLL_MAP)) {
        if (assetName.includes(cudaKey)) {
          const dllPath = path.join(tempDir, dllName);
          let needDownloadDll = true;
          try {
            if (existsSync(dllPath)) {
              const stats = await fs.stat(dllPath);
              if (stats.size > 0) {
                needDownloadDll = false;
              }
            }
          } catch {}

          if (needDownloadDll) {
            onProgress(65, `正在下載 CUDA 執行庫 (${dllName})...`);
            const dllUrl = `${GITHUB_RELEASES}/${tag}/${dllName}`;
            await downloadFile(dllUrl, dllPath, (pct) => {
              onProgress(65 + pct * 0.1, `下載 CUDA DLL... ${Math.round(pct * 100)}%`);
            });
          } else {
            onProgress(75, `使用暫存的 CUDA DLL...`);
          }
          // 解壓 DLL
          await extractArchive(dllPath, tempDir, platform);
          break;
        }
      }
    }

    // ---- 步驟 3：解壓主 asset ----
    onProgress(75, '正在解壓縮...');
    await extractArchive(mainZipPath, tempDir, platform);

    // ---- 步驟 4：複製二進位檔案到目標目錄 ----
    onProgress(85, '正在安裝...');
    await installBinaries(tempDir, binDir, platform);

    // ---- 步驟 5：儲存版本號 ----
    store.set('llamacppVersion', tag);

    // 成功後清理臨時目錄（清空暫存）
    try {
      await fs.rm(tempDir, { recursive: true, force: true });
    } catch {}

    onProgress(100, '安裝完成！');
    return { success: true, message: `llama.cpp 已更新至 ${tag}` };
  } catch (error) {
    return { success: false, message: `更新失敗: ${error.message}` };
  }
}

// ==================== 內部函數 ====================

/**
 * 從 GitHub API 獲取最新 release 資訊
 */
async function fetchLatestRelease() {
  return new Promise((resolve, reject) => {
    const options = {
      headers: { 'User-Agent': 'llamacpp-distributed-inference' }
    };

    https.get(GITHUB_API, options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          reject(new Error('無法解析 GitHub API 回應'));
        }
      });
    }).on('error', (e) => reject(new Error(`GitHub API 請求失敗: ${e.message}`)));
  });
}

/**
 * 從 asset 檔名中提取人類可讀的變體標籤
 */
function extractVariantLabel(name, tag, platform) {
  // 移除前綴與後綴，保留中間的變體描述
  // 例如 llama-b8940-bin-win-cuda-12.4-x64.zip → CUDA 12.4 (x64)
  const prefixMap = {
    windows: `llama-${tag}-bin-win-`,
    macos: `llama-${tag}-bin-macos-`,
    linux: `llama-${tag}-bin-ubuntu-`
  };
  const prefix = prefixMap[platform] || '';
  let label = name.replace(prefix, '').replace(/\.(zip|tar\.gz)$/, '');
  
  // 美化標籤
  label = label.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
  return label;
}

/**
 * 帶進度的檔案下載
 * @param {string} url - 下載 URL
 * @param {string} dest - 目標檔案路徑
 * @param {function} onProgress - 進度回報 (0.0 ~ 1.0)
 */
function downloadFile(url, dest, onProgress) {
  return new Promise((resolve, reject) => {
    const makeRequest = (requestUrl) => {
      const mod = requestUrl.startsWith('https') ? https : http;
      mod.get(requestUrl, (response) => {
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
          downloaded += chunk.length;
          if (totalSize > 0) onProgress(downloaded / totalSize);
        });

        response.pipe(file);
        file.on('finish', () => { file.close(); resolve(); });
        file.on('error', (err) => { fs.unlink(dest).catch(() => {}); reject(err); });
      }).on('error', reject);
    };
    makeRequest(url);
  });
}

/**
 * 解壓檔案（zip 或 tar.gz）
 */
async function extractArchive(archivePath, extractDir, platform) {
  const isZip = archivePath.endsWith('.zip');
  const isTarGz = archivePath.endsWith('.tar.gz');

  if (isZip) {
    if (process.platform === 'win32') {
      execSync(`powershell -command "Expand-Archive -Path '${archivePath}' -DestinationPath '${extractDir}' -Force"`, { stdio: 'ignore' });
    } else {
      execSync(`unzip -qo "${archivePath}" -d "${extractDir}"`, { stdio: 'ignore' });
    }
  } else if (isTarGz) {
    execSync(`tar -xzf "${archivePath}" -C "${extractDir}"`, { stdio: 'ignore' });
  }
}

/**
 * 將解壓後的二進位檔案安裝到 bin 目錄
 */
async function installBinaries(tempDir, binDir, platform) {
  const targetBinaries = platform === 'windows'
    ? ['llama-server.exe', 'rpc-server.exe']
    : ['llama-server', 'rpc-server'];

  // 遞迴搜尋臨時目錄中的目標檔案
  const files = await findFilesRecursive(tempDir);

  for (const targetName of targetBinaries) {
    const found = files.find(f => path.basename(f) === targetName);
    if (found) {
      const destPath = path.join(binDir, targetName);
      await fs.copyFile(found, destPath);
      // Unix 設定可執行權限
      if (platform !== 'windows') {
        await fs.chmod(destPath, 0o755);
      }
    }
  }

  // Windows: 複製所有 DLL 檔案
  if (platform === 'windows') {
    const dllFiles = files.filter(f => f.endsWith('.dll'));
    for (const dll of dllFiles) {
      const destPath = path.join(binDir, path.basename(dll));
      await fs.copyFile(dll, destPath);
    }
  }
}

/**
 * 遞迴列出目錄中的所有檔案
 */
async function findFilesRecursive(dir) {
  const results = [];
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory() && entry.name !== '__update_temp') {
      results.push(...await findFilesRecursive(fullPath));
    } else if (entry.isFile()) {
      results.push(fullPath);
    }
  }
  return results;
}
