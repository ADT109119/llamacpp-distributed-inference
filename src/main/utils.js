import { app } from 'electron';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

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
 * @param {string} binaryName - 二進位檔案名稱
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
  const basePath = getAppBasePath();
  
  return path.join(basePath, 'bin', osMap[platform], executableName);
}

/**
 * 獲取模型資料夾路徑
 * @returns {string} 模型資料夾路徑
 */
export function getModelsPath() {
  return path.join(getAppBasePath(), 'models');
}

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
    const net = require('net');
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
  const { networkInterfaces } = require('os');
  const nets = networkInterfaces();
  const results = [];

  for (const name of Object.keys(nets)) {
    for (const net of nets[name]) {
      // 跳過內部地址和非 IPv4 地址
      if (net.family === 'IPv4' && !net.internal) {
        results.push(net.address);
      }
    }
  }

  return results;
}