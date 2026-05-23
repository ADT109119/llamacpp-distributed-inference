import { app } from 'electron';
import path from 'path';
import { fileURLToPath } from 'url';
import os from 'os';
import net from 'net';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ==================== 路徑工具 ====================

/**
 * 獲取應用程式的基礎路徑
 * 處理開發環境和打包後環境的路徑差異
 */
export function getAppBasePath() {
  return app.isPackaged 
    ? path.join(process.resourcesPath, 'app')
    : path.join(__dirname, '../..');
}

/**
 * 獲取二進位檔案路徑
 * @param {string} binaryName - 二進位檔案名稱（不含副檔名）
 * @returns {string} 完整的二進位檔案路徑
 */
export function getBinaryPath(binaryName) {
  const platform = process.platform;
  const osMap = {
    'win32': 'windows',
    'darwin': 'macos',
    'linux': 'linux'
  };
  
  const executableName = platform === 'win32' ? `${binaryName}.exe` : binaryName;
  
  // 二進位檔案的路徑與 app 路徑不同
  const basePath = app.isPackaged 
    ? process.resourcesPath
    : path.join(__dirname, '../..');

  return path.join(basePath, 'bin', osMap[platform], executableName);
}

/**
 * 獲取二進位檔案所在目錄
 * @returns {string} bin/<platform>/ 的絕對路徑
 */
export function getBinDir() {
  const platform = process.platform;
  const osMap = { 'win32': 'windows', 'darwin': 'macos', 'linux': 'linux' };
  const basePath = app.isPackaged 
    ? process.resourcesPath
    : path.join(__dirname, '../..');
  return path.join(basePath, 'bin', osMap[platform]);
}

/**
 * 獲取當前平台識別符
 * @returns {'windows'|'macos'|'linux'}
 */
export function getPlatformId() {
  const map = { 'win32': 'windows', 'darwin': 'macos', 'linux': 'linux' };
  return map[process.platform] || 'linux';
}

// ==================== 網路工具 ====================

/**
 * 格式化日誌訊息
 * @param {string} level - 日誌等級
 * @param {string} message - 訊息內容
 * @returns {string} 格式化後的日誌訊息
 */
export function formatLogMessage(level, message) {
  const timestamp = new Date().toISOString();
  return `[${timestamp}] [${level.toUpperCase()}] ${message}`;
}

/**
 * 檢查端口是否可用
 * @param {number} port - 要檢查的端口
 * @returns {Promise<boolean>} 端口是否可用
 */
export function isPortAvailable(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    
    server.listen(port, () => {
      server.once('close', () => {
        resolve(true);
      });
      server.close();
    });
    
    server.on('error', () => {
      resolve(false);
    });
  });
}

/**
 * 獲取本機 IP 地址
 * @returns {string[]} IP 地址列表
 */
export function getLocalIpAddresses() {
  const nets = os.networkInterfaces();
  const results = [];

  for (const name of Object.keys(nets)) {
    for (const iface of nets[name]) {
      // 跳過內部地址和非 IPv4 地址
      if (iface.family === 'IPv4' && !iface.internal) {
        results.push(iface.address);
      }
    }
  }

  return results;
}

/**
 * 檢查指定 IP 是否為本機地址
 * @param {string} addr - 要檢查的 IP 地址
 * @returns {boolean}
 */
export function isLocalAddress(addr) {
  if (addr === '127.0.0.1' || addr === 'localhost') return true;
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family === 'IPv4' && iface.address === addr) return true;
    }
  }
  return false;
}