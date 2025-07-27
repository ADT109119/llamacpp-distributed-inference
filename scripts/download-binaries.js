#!/usr/bin/env node

/**
 * llama.cpp 二進位檔案下載腳本
 * 用於本地開發或手動下載二進位檔案
 */

const https = require('https');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

// 配置
const config = {
  version: process.env.LLAMACPP_VERSION || 'master',
  platforms: {
    windows: {
      url: 'https://github.com/ggerganov/llama.cpp/releases/latest/download/llama-master-bin-win-cuda-cu12.2.0-x64.zip',
      extractDir: 'llama-master-bin-win-cuda-cu12.2.0-x64',
      files: ['rpc-server.exe', 'llama-server.exe'],
      dlls: true
    },
    macos: {
      url: 'https://github.com/ggerganov/llama.cpp/releases/latest/download/llama-master-bin-macos-arm64.zip',
      extractDir: 'llama-master-bin-macos-arm64',
      files: ['rpc-server', 'llama-server'],
      dlls: false
    },
    linux: {
      url: 'https://github.com/ggerganov/llama.cpp/releases/latest/download/llama-master-bin-ubuntu-x64.zip',
      extractDir: 'llama-master-bin-ubuntu-x64',
      files: ['rpc-server', 'llama-server'],
      dlls: false
    }
  }
};

function downloadFile(url, dest) {
  return new Promise((resolve, reject) => {
    console.log(`正在下載: ${url}`);
    const file = fs.createWriteStream(dest);
    
    https.get(url, (response) => {
      if (response.statusCode === 302 || response.statusCode === 301) {
        // 處理重定向
        return downloadFile(response.headers.location, dest).then(resolve).catch(reject);
      }
      
      if (response.statusCode !== 200) {
        reject(new Error(`下載失敗，狀態碼: ${response.statusCode}`));
        return;
      }
      
      response.pipe(file);
      
      file.on('finish', () => {
        file.close();
        console.log(`下載完成: ${dest}`);
        resolve();
      });
      
      file.on('error', (err) => {
        fs.unlink(dest, () => {}); // 刪除不完整的檔案
        reject(err);
      });
    }).on('error', (err) => {
      reject(err);
    });
  });
}

function extractZip(zipPath, extractPath) {
  try {
    console.log(`正在解壓縮: ${zipPath}`);
    
    // 檢查是否有 unzip 命令
    try {
      execSync('unzip -v', { stdio: 'ignore' });
      execSync(`unzip -q "${zipPath}" -d "${extractPath}"`);
    } catch {
      // 如果沒有 unzip，嘗試使用 PowerShell (Windows)
      if (process.platform === 'win32') {
        execSync(`powershell -command "Expand-Archive -Path '${zipPath}' -DestinationPath '${extractPath}' -Force"`);
      } else {
        throw new Error('需要 unzip 命令來解壓縮檔案');
      }
    }
    
    console.log(`解壓縮完成: ${extractPath}`);
  } catch (error) {
    throw new Error(`解壓縮失敗: ${error.message}`);
  }
}

async function downloadPlatform(platform) {
  const platformConfig = config.platforms[platform];
  if (!platformConfig) {
    throw new Error(`不支援的平台: ${platform}`);
  }
  
  const tempDir = path.join(__dirname, '..', 'temp');
  const binDir = path.join(__dirname, '..', 'bin', platform);
  const zipPath = path.join(tempDir, `${platform}.zip`);
  
  // 創建目錄
  fs.mkdirSync(tempDir, { recursive: true });
  fs.mkdirSync(binDir, { recursive: true });
  
  try {
    // 下載檔案
    await downloadFile(platformConfig.url, zipPath);
    
    // 解壓縮
    extractZip(zipPath, tempDir);
    
    // 複製檔案
    const extractedDir = path.join(tempDir, platformConfig.extractDir);
    
    for (const file of platformConfig.files) {
      const srcPath = path.join(extractedDir, file);
      const destPath = path.join(binDir, file);
      
      if (fs.existsSync(srcPath)) {
        fs.copyFileSync(srcPath, destPath);
        console.log(`已複製: ${file}`);
        
        // 設定執行權限 (非 Windows)
        if (platform !== 'windows') {
          fs.chmodSync(destPath, 0o755);
        }
      } else {
        console.warn(`警告: 找不到檔案 ${file}`);
      }
    }
    
    // 複製 DLL 檔案 (Windows)
    if (platformConfig.dlls && platform === 'windows') {
      const dllFiles = fs.readdirSync(extractedDir).filter(f => f.endsWith('.dll'));
      for (const dll of dllFiles) {
        const srcPath = path.join(extractedDir, dll);
        const destPath = path.join(binDir, dll);
        fs.copyFileSync(srcPath, destPath);
        console.log(`已複製 DLL: ${dll}`);
      }
    }
    
    console.log(`✅ ${platform} 平台二進位檔案下載完成`);
    
  } finally {
    // 清理臨時檔案
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch (error) {
      console.warn(`清理臨時檔案失敗: ${error.message}`);
    }
  }
}

async function main() {
  const args = process.argv.slice(2);
  const platforms = args.length > 0 ? args : ['windows', 'macos', 'linux'];
  
  console.log('🚀 開始下載 llama.cpp 二進位檔案...');
  console.log(`版本: ${config.version}`);
  console.log(`平台: ${platforms.join(', ')}`);
  console.log('');
  
  for (const platform of platforms) {
    try {
      await downloadPlatform(platform);
    } catch (error) {
      console.error(`❌ ${platform} 平台下載失敗: ${error.message}`);
      process.exit(1);
    }
  }
  
  console.log('');
  console.log('🎉 所有二進位檔案下載完成！');
}

if (require.main === module) {
  main().catch(console.error);
}

module.exports = { downloadPlatform, config };