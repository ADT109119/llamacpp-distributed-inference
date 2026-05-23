import { app, BrowserWindow, ipcMain } from 'electron';
import { spawn } from 'child_process';
import path from 'path';
import fs from 'fs/promises';
import { fileURLToPath } from 'url';
import { Bonjour } from 'bonjour-service';
import Store from 'electron-store';
import os from 'os';
import net from 'net';
import { getBinaryPath, isLocalAddress } from './utils.js';
import { checkForUpdates, getAvailableAssets, getCurrentVersion, downloadAndInstall } from './updater.js';
import { searchRepo, listGGUFFiles, downloadModel, cancelDownload } from './hf-downloader.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ==================== 全域變數 ====================

let mainWindow;
let rpcServerProcess;
let apiServerProcess;
let bonjour;
let discoveredNodes = new Set();
let discoveryInterval;
const store = new Store();

// ==================== 視窗管理 ====================

function createWindow() {
  const iconPath = app.isPackaged 
    ? path.join(process.resourcesPath, 'images', 'icon.png')
    : path.join(__dirname, '../../images/icon.png');

  mainWindow = new BrowserWindow({
    width: 1400,
    height: 800,
    minWidth: 1200,
    minHeight: 700,
    icon: iconPath,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, '../preload/index.js')
    }
  });

  mainWindow.loadFile('src/renderer/index.html');

  if (process.argv.includes('--dev')) {
    mainWindow.webContents.openDevTools();
  }
}

// ==================== RPC 伺服器管理 ====================

function startRpcServer() {
  if (rpcServerProcess) {
    console.log('RPC server is already running');
    setTimeout(() => {
      mainWindow?.webContents.send('rpc-server-status', true);
    }, 100);
    return;
  }
  
  const rpcServerPath = getBinaryPath('rpc-server');

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
      rpcServerProcess = null;
      mainWindow?.webContents.send('rpc-server-status', false);
    });

    setTimeout(() => {
      mainWindow?.webContents.send('rpc-server-status', true);
    }, 2000);

  } catch (error) {
    console.error('Failed to start rpc-server:', error);
    rpcServerProcess = null;
    mainWindow?.webContents.send('rpc-server-error', error.message);
  }
}

// ==================== mDNS 節點發現 ====================

/**
 * 統一的節點過濾與添加邏輯（消除原始程式碼中的重複）
 * @param {string[]} addresses - mDNS 發現的 IP 地址陣列
 * @param {string} source - 日誌標記（如 'initial', 'periodic'）
 */
function filterAndAddNode(addresses, source) {
  if (!addresses || addresses.length === 0) return;

  for (const addr of addresses) {
    // 跳過無效地址：空、全零、link-local、IPv6、非法格式
    if (!addr || addr === '0.0.0.0' || addr.startsWith('169.254') || addr.includes(':')) continue;
    if (!/^(?:(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\.){3}(?:25[0-5]|2[0-4]\d|[01]?\d\d?)$/.test(addr)) continue;

    if (isLocalAddress(addr)) {
      // 本機 IP 統一映射為 127.0.0.1
      if (!discoveredNodes.has('127.0.0.1')) {
        discoveredNodes.add('127.0.0.1');
        console.log(`[${source}] Added localhost node via mDNS`);
        mainWindow?.webContents.send('node-update', Array.from(discoveredNodes));
      }
    } else {
      if (!discoveredNodes.has(addr)) {
        discoveredNodes.add(addr);
        console.log(`[${source}] Added remote node: ${addr}`);
        mainWindow?.webContents.send('node-update', Array.from(discoveredNodes));
      }
    }
  }
}

function startMdnsDiscovery() {
  try {
    bonjour = new Bonjour();
    const serviceType = 'llm-cluster';
    const serviceName = 'LLMNode-' + os.hostname();

    console.log('Starting mDNS discovery...');

    // 發布本機服務
    const service = bonjour.publish({ 
      name: serviceName, type: serviceType, port: 50052,
      txt: { version: '1.0.0', platform: process.platform }
    });
    service.on('up', () => console.log('mDNS service published'));
    service.on('error', (err) => console.error('mDNS publish error:', err));

    // 瀏覽網路上的其他服務
    const browser = bonjour.find({ type: serviceType });
    browser.on('up', (svc) => {
      console.log('Service up:', svc.name, svc.addresses);
      filterAndAddNode(svc.addresses, 'initial');
    });
    browser.on('down', (svc) => {
      console.log('Service down:', svc.name, svc.addresses);
      if (svc.addresses) {
        svc.addresses.forEach(addr => {
          if (discoveredNodes.has(addr)) {
            discoveredNodes.delete(addr);
            mainWindow?.webContents.send('node-update', Array.from(discoveredNodes));
          }
        });
      }
    });

    // 自動添加 localhost
    discoveredNodes.add('127.0.0.1');
    setTimeout(() => {
      mainWindow?.webContents.send('node-update', Array.from(discoveredNodes));
    }, 1000);

    // 定時搜尋 (每30秒)
    discoveryInterval = setInterval(() => {
      const periodicBrowser = bonjour.find({ type: serviceType, protocol: 'tcp' });
      periodicBrowser.on('up', (svc) => {
        filterAndAddNode(svc.addresses, 'periodic');
      });
      setTimeout(() => periodicBrowser.stop(), 5000);
    }, 30000);

  } catch (error) {
    console.error('Failed to start mDNS discovery:', error);
    discoveredNodes.add('127.0.0.1');
    setTimeout(() => {
      mainWindow?.webContents.send('node-update', Array.from(discoveredNodes));
    }, 1000);
  }
}

// ==================== 模型路徑管理 ====================

function getModelsPath() {
  const customPath = store.get('modelsPath');
  if (customPath) return customPath;
  
  if (app.isPackaged) {
    return path.join(path.dirname(process.execPath), 'models');
  } else {
    return path.join(process.cwd(), 'models');
  }
}

// ==================== IPC Handlers: 模型管理 ====================

ipcMain.handle('get-models', async () => {
  try {
    const modelsPath = getModelsPath();
    try {
      await fs.access(modelsPath);
    } catch {
      await fs.mkdir(modelsPath, { recursive: true });
      const readmePath = path.join(modelsPath, 'README.md');
      const readmeContent = `# 模型資料夾\n\n請將您的 GGUF 格式模型檔案放置在此資料夾中。\n\n## 支援的模型格式\n- \`.gguf\` 檔案\n\n## 建議的模型來源\n- [Hugging Face](https://huggingface.co/models?library=gguf)\n`;
      await fs.writeFile(readmePath, readmeContent, 'utf8');
      return [];
    }
    const files = await fs.readdir(modelsPath);
    return files.filter(file => file.endsWith('.gguf'));
  } catch (error) {
    console.error('Error getting models:', error);
    return [];
  }
});

ipcMain.handle('get-models-path', async () => getModelsPath());

ipcMain.handle('set-models-path', async (event, newPath) => {
  try {
    await fs.access(newPath);
    store.set('modelsPath', newPath);
    return { success: true, message: `模型路徑已設定為: ${newPath}` };
  } catch {
    return { success: false, message: `無效的路徑: ${newPath}` };
  }
});

ipcMain.handle('reset-models-path', async () => {
  store.delete('modelsPath');
  const defaultPath = getModelsPath();
  return { success: true, message: `已重置為預設路徑: ${defaultPath}` };
});

ipcMain.handle('browse-models-folder', async () => {
  try {
    const { dialog } = await import('electron');
    const result = await dialog.showOpenDialog(mainWindow, {
      properties: ['openDirectory'],
      title: '選擇模型資料夾',
      defaultPath: getModelsPath()
    });
    if (!result.canceled && result.filePaths.length > 0) {
      return { success: true, path: result.filePaths[0] };
    }
    return { success: false, message: '未選擇資料夾' };
  } catch (error) {
    return { success: false, message: `選擇資料夾失敗: ${error.message}` };
  }
});

ipcMain.handle('open-models-folder', async () => {
  try {
    const { shell } = await import('electron');
    const modelsPath = getModelsPath();
    try { await fs.access(modelsPath); } catch { await fs.mkdir(modelsPath, { recursive: true }); }
    await shell.openPath(modelsPath);
    return { success: true, message: `已開啟資料夾: ${modelsPath}` };
  } catch (error) {
    return { success: false, message: `開啟資料夾失敗: ${error.message}` };
  }
});

// ==================== IPC Handlers: API 伺服器管理 ====================

ipcMain.handle('start-api-server', async (event, options) => {
  try {
    const {
      modelName, apiKey, rpcNodes, ngl, np, ctxSize,
      flashAttention, cacheTypeK, cacheTypeV,
      // Speculative Decoding 參數
      specEnabled, draftModel, draftNgl, draftMax, draftMin, draftPMin
    } = options;
    
    if (apiServerProcess) {
      return { success: false, message: 'API 伺服器已在運行中' };
    }

    const serverPath = getBinaryPath('llama-server');
    const modelPath = path.join(getModelsPath(), modelName);

    // 過濾掉本機IP
    const filteredRpcNodes = rpcNodes.filter(ip => ip !== '127.0.0.1' && ip !== 'localhost');
    const rpcString = filteredRpcNodes.length > 0 ? filteredRpcNodes.map(ip => `${ip}:50052`).join(',') : '';
    
    const args = ['-m', modelPath, '--host', '0.0.0.0', '--port', '8080'];

    if (apiKey) args.push('--api-key', apiKey);
    if (rpcString) args.push('--rpc', rpcString);
    if (ngl && ngl > 0) args.push('-ngl', ngl.toString());
    if (np && np > 0) args.push('-np', np.toString());
    if (ctxSize && ctxSize > 0) args.push('--ctx-size', ctxSize.toString());
    if (flashAttention) args.push('-fa');
    if (cacheTypeK && cacheTypeK !== 'f16') args.push('-ctk', cacheTypeK);
    if (cacheTypeV && cacheTypeV !== 'f16') args.push('-ctv', cacheTypeV);

    // Speculative Decoding 參數
    if (specEnabled && draftModel) {
      const draftModelPath = path.join(getModelsPath(), draftModel);
      args.push('-md', draftModelPath);
      if (draftNgl != null && draftNgl > 0) args.push('-ngld', draftNgl.toString());
      if (draftMax != null && draftMax > 0) args.push('--draft-max', draftMax.toString());
      if (draftMin != null && draftMin > 0) args.push('--draft-min', draftMin.toString());
      if (draftPMin != null && draftPMin > 0) args.push('--draft-p-min', draftPMin.toString());
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

// ==================== IPC Handlers: API Key ====================

ipcMain.handle('get-api-key', async () => store.get('apiKey', ''));
ipcMain.handle('set-api-key', async (event, apiKey) => {
  store.set('apiKey', apiKey);
  return { success: true };
});

// ==================== IPC Handlers: 節點管理 ====================

ipcMain.handle('get-discovered-nodes', async () => Array.from(discoveredNodes));

ipcMain.handle('get-local-ips', async () => {
  try {
    const interfaces = os.networkInterfaces();
    const localIps = [];
    Object.keys(interfaces).forEach(name => {
      const ifaceList = interfaces[name];
      if (ifaceList) {
        ifaceList.forEach(iface => {
          if (iface.family === 'IPv4') {
            localIps.push({ address: iface.address, interface: name, internal: iface.internal });
          }
        });
      }
    });
    return localIps;
  } catch (error) {
    console.error('Error getting local IPs:', error);
    return [{ address: '127.0.0.1', interface: 'Loopback', internal: true }];
  }
});

async function checkNodeConnection(nodeIp, port = 50052) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    const timeout = setTimeout(() => { socket.destroy(); resolve(false); }, 5000);
    socket.connect(port, nodeIp, () => { clearTimeout(timeout); socket.destroy(); resolve(true); });
    socket.on('error', () => { clearTimeout(timeout); resolve(false); });
  });
}

ipcMain.handle('check-node-connection', async (event, nodeIp) => {
  try {
    const isConnectable = await checkNodeConnection(nodeIp);
    return {
      success: true,
      reachable: isConnectable,
      message: isConnectable
        ? `節點 ${nodeIp} 連接成功，RPC 服務正在運行`
        : `無法連接到節點 ${nodeIp}:50052，請確認目標設備已啟動此程式`
    };
  } catch (error) {
    return { success: false, reachable: false, message: `檢查連接時發生錯誤: ${error.message}` };
  }
});

ipcMain.handle('add-manual-node', async (event, nodeIp) => {
  try {
    const ipRegex = /^(?:(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\.){3}(?:25[0-5]|2[0-4]\d|[01]?\d\d?)$/;
    if (!ipRegex.test(nodeIp)) return { success: false, message: '無效的 IP 地址格式' };
    if (discoveredNodes.has(nodeIp)) return { success: false, message: '該節點已存在' };

    if (isLocalAddress(nodeIp) && nodeIp !== '127.0.0.1') {
      return { success: false, message: '本機節點請使用 127.0.0.1' };
    }

    const connectionResult = await checkNodeConnection(nodeIp);
    discoveredNodes.add(nodeIp);
    mainWindow?.webContents.send('node-update', Array.from(discoveredNodes));

    return {
      success: true,
      reachable: connectionResult,
      message: connectionResult
        ? `節點 ${nodeIp} 已添加並驗證連接成功`
        : `節點 ${nodeIp} 已添加，但無法連接到 RPC 服務 (端口 50052)`
    };
  } catch (error) {
    return { success: false, message: error.message };
  }
});

ipcMain.handle('remove-node', async (event, nodeIp) => {
  if (discoveredNodes.has(nodeIp)) {
    discoveredNodes.delete(nodeIp);
    mainWindow?.webContents.send('node-update', Array.from(discoveredNodes));
    return { success: true, message: `節點 ${nodeIp} 已移除` };
  }
  return { success: false, message: '節點不存在' };
});

ipcMain.handle('restart-rpc-server', async () => {
  try {
    if (rpcServerProcess) { rpcServerProcess.kill(); rpcServerProcess = null; }
    startRpcServer();
    return { success: true, message: 'RPC server 重啟中...' };
  } catch (error) {
    return { success: false, message: `重啟失敗: ${error.message}` };
  }
});

// ==================== IPC Handlers: llama.cpp 更新 ====================

ipcMain.handle('check-llamacpp-updates', async () => {
  try {
    return { success: true, ...(await checkForUpdates()) };
  } catch (error) {
    return { success: false, message: `檢查更新失敗: ${error.message}` };
  }
});

ipcMain.handle('get-llamacpp-assets', async () => {
  try {
    const assets = await getAvailableAssets();
    return { success: true, assets };
  } catch (error) {
    return { success: false, message: `獲取資源失敗: ${error.message}` };
  }
});

ipcMain.handle('get-current-llamacpp-version', async () => getCurrentVersion());

ipcMain.handle('download-llamacpp', async (event, assetUrl, assetName, tag) => {
  try {
    // 1. 關閉伺服器以解除檔案鎖
    if (rpcServerProcess) {
      console.log('正在關閉 RPC 伺服器以進行更新...');
      rpcServerProcess.kill();
      rpcServerProcess = null;
    }
    if (apiServerProcess) {
      console.log('正在關閉 API 伺服器以進行更新...');
      apiServerProcess.kill();
      apiServerProcess = null;
    }

    // 稍微等待 500ms 確保進程徹底釋放資源
    await new Promise(resolve => setTimeout(resolve, 500));

    // 2. 執行下載與安裝
    const result = await downloadAndInstall(assetUrl, assetName, tag, (percent, message) => {
      mainWindow?.webContents.send('download-progress', { percent, message, type: 'llamacpp' });
    });
    return result;
  } catch (error) {
    return { success: false, message: `下載失敗: ${error.message}` };
  }
});

// ==================== IPC Handlers: Hugging Face 模型下載 ====================

ipcMain.handle('search-hf-repo', async (event, repoId) => {
  try {
    const info = await searchRepo(repoId);
    return { success: true, ...info };
  } catch (error) {
    return { success: false, message: `搜尋失敗: ${error.message}` };
  }
});

ipcMain.handle('list-hf-models', async (event, repoId) => {
  try {
    const variants = await listGGUFFiles(repoId);
    return { success: true, variants };
  } catch (error) {
    return { success: false, message: `列出模型失敗: ${error.message}` };
  }
});

ipcMain.handle('download-hf-model', async (event, repoId, fileNames) => {
  try {
    const modelsPath = getModelsPath();
    const result = await downloadModel(repoId, fileNames, modelsPath, (percent, message, currentFile) => {
      mainWindow?.webContents.send('download-progress', { percent, message, currentFile, type: 'hf' });
    });
    return result;
  } catch (error) {
    return { success: false, message: `下載失敗: ${error.message}` };
  }
});

ipcMain.handle('cancel-hf-download', async () => {
  cancelDownload();
  return { success: true, message: '已發送取消請求' };
});

// ==================== 應用程式生命週期 ====================

app.whenReady().then(() => {
  createWindow();
  startRpcServer();
  startMdnsDiscovery();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('will-quit', () => {
  if (rpcServerProcess) rpcServerProcess.kill();
  if (apiServerProcess) apiServerProcess.kill();
  if (bonjour) bonjour.destroy();
  if (discoveryInterval) clearInterval(discoveryInterval);
});