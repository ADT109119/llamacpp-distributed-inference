import { app, BrowserWindow, ipcMain } from 'electron';
import { spawn } from 'child_process';
import path from 'path';
import fs from 'fs/promises';
import { fileURLToPath } from 'url';
import { Bonjour } from 'bonjour-service';
import Store from 'electron-store';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// 全域變數
let mainWindow;
let rpcServerProcess;
let apiServerProcess;
let bonjour;
let discoveredNodes = new Set();
const store = new Store();

// 創建主視窗
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 800,
    minWidth: 1200,
    minHeight: 700,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, '../preload/index.js')
    }
  });

  // 載入 HTML 檔案
  mainWindow.loadFile('src/renderer/index.html');

  // 開發模式下開啟開發者工具
  if (process.argv.includes('--dev')) {
    mainWindow.webContents.openDevTools();
  }
}

// 啟動 RPC 伺服器
function startRpcServer() {
  const platform = process.platform;
  const osMap = {
    'win32': 'windows',
    'darwin': 'macos',
    'linux': 'linux'
  };
  const binaryName = platform === 'win32' ? 'rpc-server.exe' : 'rpc-server';
  
  // 處理打包後路徑
  const basePath = app.isPackaged 
    ? process.resourcesPath
    : path.join(__dirname, '../..');

  const rpcServerPath = path.join(basePath, 'bin', osMap[platform], binaryName);

  try {
    console.log('Starting RPC server at:', rpcServerPath);
    rpcServerProcess = spawn(rpcServerPath, ['-H', '0.0.0.0', '-p', '50052', '-c']);

    rpcServerProcess.stdout.on('data', (data) => {
      console.log(`rpc-server stdout: ${data}`);
      mainWindow?.webContents.send('rpc-server-log', data.toString());
    });

    rpcServerProcess.stderr.on('data', (data) => {
      console.error(`rpc-server stderr: ${data}`);
      mainWindow?.webContents.send('rpc-server-error', data.toString());
    });

    rpcServerProcess.on('close', (code) => {
      console.log(`rpc-server process exited with code ${code}`);
      mainWindow?.webContents.send('rpc-server-status', false);
    });

    // 通知前端 RPC 伺服器已啟動
    setTimeout(() => {
      mainWindow?.webContents.send('rpc-server-status', true);
    }, 2000);

  } catch (error) {
    console.error('Failed to start rpc-server:', error);
    mainWindow?.webContents.send('rpc-server-error', error.message);
  }
}

// 啟動 mDNS 服務發現
function startMdnsDiscovery() {
  try {
    bonjour = new Bonjour();
    const serviceType = 'llm-cluster';
    const serviceName = 'LLMNode-' + require('os').hostname();

    console.log('Starting mDNS discovery...');
    console.log('Service name:', serviceName);
    console.log('Service type:', serviceType);

    // 發布本機服務
    const service = bonjour.publish({ 
      name: serviceName, 
      type: serviceType, 
      port: 50052,
      txt: {
        version: '1.0.0',
        platform: process.platform
      }
    });

    service.on('up', () => {
      console.log('mDNS service published successfully');
    });

    service.on('error', (err) => {
      console.error('mDNS service publish error:', err);
    });

    // 瀏覽網路上的其他服務
    const browser = bonjour.find({ type: serviceType }, (service) => {
      console.log('Found service via callback:', service.name, service.addresses);
    });
    
    browser.on('up', (service) => {
      console.log('Service up:', service.name, service.addresses);
      if (service.addresses && service.addresses.length > 0) {
        service.addresses.forEach(addr => {
          // 過濾掉無效的地址
          if (addr && addr !== '0.0.0.0' && !addr.startsWith('169.254')) {
            if (!discoveredNodes.has(addr)) {
              discoveredNodes.add(addr);
              console.log('Added discovered node:', addr);
              mainWindow?.webContents.send('node-update', Array.from(discoveredNodes));
            }
          }
        });
      }
    });
    
    browser.on('down', (service) => {
      console.log('Service down:', service.name, service.addresses);
      if (service.addresses && service.addresses.length > 0) {
        service.addresses.forEach(addr => {
          if (discoveredNodes.has(addr)) {
            discoveredNodes.delete(addr);
            console.log('Removed node:', addr);
            mainWindow?.webContents.send('node-update', Array.from(discoveredNodes));
          }
        });
      }
    });

    // 添加本機地址到節點列表
    const os = require('os');
    const interfaces = os.networkInterfaces();
    Object.keys(interfaces).forEach(name => {
      interfaces[name].forEach(iface => {
        if (iface.family === 'IPv4' && !iface.internal) {
          discoveredNodes.add(iface.address);
          console.log('Added local interface:', iface.address);
        }
      });
    });

    // 添加 localhost
    discoveredNodes.add('127.0.0.1');
    
    // 發送初始節點列表
    setTimeout(() => {
      mainWindow?.webContents.send('node-update', Array.from(discoveredNodes));
    }, 1000);

  } catch (error) {
    console.error('Failed to start mDNS discovery:', error);
    // 如果 mDNS 失敗，至少添加本機地址
    discoveredNodes.add('127.0.0.1');
    setTimeout(() => {
      mainWindow?.webContents.send('node-update', Array.from(discoveredNodes));
    }, 1000);
  }
}

// IPC 處理器
ipcMain.handle('get-models', async () => {
  try {
    const basePath = app.isPackaged 
      ? process.resourcesPath
      : path.join(__dirname, '../..');
    const modelsPath = path.join(basePath, 'models');
    
    // 檢查 models 目錄是否存在
    try {
      await fs.access(modelsPath);
    } catch {
      // 如果目錄不存在，創建它
      await fs.mkdir(modelsPath, { recursive: true });
      return [];
    }
    
    const files = await fs.readdir(modelsPath);
    return files.filter(file => file.endsWith('.gguf'));
  } catch (error) {
    console.error('Error getting models:', error);
    return [];
  }
});

ipcMain.handle('start-api-server', async (event, options) => {
  try {
    const { modelName, apiKey, rpcNodes, ngl } = options;
    
    if (apiServerProcess) {
      return { success: false, message: 'API 伺服器已在運行中' };
    }

    const platform = process.platform;
    const osMap = {
      'win32': 'windows',
      'darwin': 'macos',
      'linux': 'linux'
    };
    const binaryName = platform === 'win32' ? 'llama-server.exe' : 'llama-server';
    
    const basePath = app.isPackaged 
      ? process.resourcesPath
      : path.join(__dirname, '../..');

    const serverPath = path.join(basePath, 'bin', osMap[platform], binaryName);
    const modelPath = path.join(basePath, 'models', modelName);

    // 組合 RPC 參數
    const rpcString = rpcNodes.length > 0 ? rpcNodes.map(ip => `${ip}:50052`).join(',') : '';
    
    const args = [
      '-m', modelPath,
      '--host', '0.0.0.0',
      '--port', '8080'
    ];

    if (apiKey) {
      args.push('--api-key', apiKey);
    }

    if (rpcString) {
      args.push('--rpc', rpcString);
    }

    if (ngl && ngl > 0) {
      args.push('-ngl', ngl.toString());
    }

    console.log('Starting API server with args:', args);
    apiServerProcess = spawn(serverPath, args);

    apiServerProcess.stdout.on('data', (data) => {
      console.log(`api-server stdout: ${data}`);
      mainWindow?.webContents.send('api-server-log', data.toString());
    });

    apiServerProcess.stderr.on('data', (data) => {
      console.error(`api-server stderr: ${data}`);
      mainWindow?.webContents.send('api-server-error', data.toString());
    });

    apiServerProcess.on('close', (code) => {
      console.log(`api-server process exited with code ${code}`);
      apiServerProcess = null;
      mainWindow?.webContents.send('api-server-status', false);
    });

    // 通知前端 API 伺服器已啟動
    setTimeout(() => {
      mainWindow?.webContents.send('api-server-status', true);
    }, 3000);

    return { success: true, message: 'API 伺服器啟動中...' };
  } catch (error) {
    console.error('Failed to start API server:', error);
    return { success: false, message: error.message };
  }
});

ipcMain.handle('stop-api-server', async () => {
  if (apiServerProcess) {
    apiServerProcess.kill();
    apiServerProcess = null;
    mainWindow?.webContents.send('api-server-status', false);
    return { success: true, message: 'API 伺服器已停止' };
  }
  return { success: false, message: 'API 伺服器未在運行' };
});

ipcMain.handle('get-api-key', async () => {
  return store.get('apiKey', '');
});

ipcMain.handle('set-api-key', async (event, apiKey) => {
  store.set('apiKey', apiKey);
  return { success: true };
});

ipcMain.handle('get-discovered-nodes', async () => {
  return Array.from(discoveredNodes);
});

// 應用程式事件
app.whenReady().then(() => {
  createWindow();
  startRpcServer();
  startMdnsDiscovery();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

// 應用程式關閉時清理
app.on('will-quit', () => {
  if (rpcServerProcess) {
    rpcServerProcess.kill();
  }
  if (apiServerProcess) {
    apiServerProcess.kill();
  }
  if (bonjour) {
    bonjour.destroy();
  }
});