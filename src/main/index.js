import { app, BrowserWindow, ipcMain } from 'electron';
import { spawn } from 'child_process';
import path from 'path';
import fs from 'fs/promises';
import { fileURLToPath } from 'url';
import { Bonjour } from 'bonjour-service';
import Store from 'electron-store';
import os from 'os';
import net from 'net';
import http from 'http';
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

// API 代理與自動載入管理
let proxyServer;
let activeModelName = null;
let lastServerOptions = null;
let idleTimer = null;
let currentBackendPort = null;
let isShuttingDownBackend = false;

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
  if (getCurrentVersion() === '未安裝') {
    console.log('llama.cpp is not installed, skipping auto-start of RPC server');
    return;
  }
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

// ==================== API 代理與動態加載輔助函數 ====================

function getFreePort(startPort) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.listen(startPort, '127.0.0.1', () => {
      const port = server.address().port;
      server.close(() => {
        resolve(port);
      });
    });
    server.on('error', () => {
      resolve(getFreePort(startPort + 1));
    });
  });
}

function checkHealthEndpoint(port) {
  return new Promise((resolve) => {
    const req = http.get(`http://127.0.0.1:${port}/health`, (res) => {
      resolve(res.statusCode === 200);
    });
    req.on('error', () => {
      resolve(false);
    });
    req.setTimeout(1000, () => {
      req.destroy();
      resolve(false);
    });
  });
}

async function findMatchingModel(requestedModelName) {
  if (!requestedModelName) return null;
  const modelsPath = getModelsPath();
  try {
    const files = await fs.readdir(modelsPath);
    const ggufFiles = files.filter(f => f.endsWith('.gguf'));
    
    // 1. 精確匹配 (包含副檔名)
    if (ggufFiles.includes(requestedModelName)) {
      return requestedModelName;
    }
    
    // 2. 精確匹配 (不包含副檔名)
    if (ggufFiles.includes(requestedModelName + '.gguf')) {
      return requestedModelName + '.gguf';
    }
    
    // 3. 大小寫無關精確匹配
    const lowerName = requestedModelName.toLowerCase();
    let match = ggufFiles.find(f => f.toLowerCase() === lowerName || f.toLowerCase() === lowerName + '.gguf');
    if (match) return match;
    
    // 4. 子字串匹配
    match = ggufFiles.find(f => {
      const fLower = f.toLowerCase();
      return fLower.includes(lowerName) || lowerName.includes(fLower.replace('.gguf', ''));
    });
    if (match) return match;
    
  } catch (e) {
    console.error('尋找匹配模型失敗:', e);
  }
  return null;
}

function bufferRequestBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', (err) => reject(err));
  });
}

function resetIdleTimer() {
  if (idleTimer) {
    clearTimeout(idleTimer);
    idleTimer = null;
  }
  
  if (lastServerOptions && lastServerOptions.idleTimeout !== undefined) {
    const timeoutMin = parseInt(lastServerOptions.idleTimeout);
    if (timeoutMin > 0) {
      idleTimer = setTimeout(unloadModelDueToIdle, timeoutMin * 60 * 1000);
    }
  }
}

async function unloadModelDueToIdle() {
  if (apiServerProcess && activeModelName) {
    console.log(`[閒置逾時] 正在自動卸載模型 "${activeModelName}" 以釋放記憶體。`);
    mainWindow?.webContents.send('api-server-log', `[代理服務] 偵測到已閒置 ${lastServerOptions.idleTimeout} 分鐘，自動卸載模型 "${activeModelName}" 以釋放記憶體...\n`);
    
    isShuttingDownBackend = true;
    
    await new Promise((resolve) => {
      if (apiServerProcess) {
        apiServerProcess.once('close', () => {
          resolve();
        });
        apiServerProcess.kill();
        apiServerProcess = null;
      } else {
        resolve();
      }
    });
    
    isShuttingDownBackend = false;
    activeModelName = null;
    
    mainWindow?.webContents.send('api-server-status', { 
      running: true, 
      message: `運行中 (模型已閒置卸載: ${lastServerOptions.modelName})`, 
      loadedModel: null 
    });
  }
}

async function loadModelBackend(modelName) {
  if (getCurrentVersion() === '未安裝') {
    throw new Error('尚未安裝 llama.cpp 推理核心，請先下載安裝。');
  }
  
  if (!lastServerOptions) {
    throw new Error('未提供伺服器配置。請先在儀表板點擊「啟動 API 伺服器」以初始化配置。');
  }
  
  const serverPath = getBinaryPath('llama-server');
  const modelPath = path.join(getModelsPath(), modelName);
  
  // 1. 檢查模型檔案是否存在
  try {
    await fs.access(modelPath);
  } catch (e) {
    throw new Error(`找不到模型檔案: ${modelName}`);
  }
  
  // 2. 評估與檢查記憶體 (RAM)
  const stats = await fs.stat(modelPath);
  const modelSize = stats.size;
  const totalMem = os.totalmem();
  const freeMem = os.freemem();
  
  let runningModelSize = 0;
  if (activeModelName) {
    try {
      const activeModelPath = path.join(getModelsPath(), activeModelName);
      const activeStats = await fs.stat(activeModelPath);
      runningModelSize = activeStats.size;
    } catch (e) {}
  }
  
  const predictedFreeMem = freeMem + runningModelSize;
  const requiredMemWithBuffer = modelSize + 512 * 1024 * 1024; // 512MB 系統緩衝
  
  // 記憶體限制檢查
  if (lastServerOptions && lastServerOptions.maxMemoryLimit > 0) {
    const limitBytes = lastServerOptions.maxMemoryLimit * 1024 * 1024 * 1024;
    if (modelSize > limitBytes) {
      throw new Error(`模型大小 (${(modelSize / 1024 / 1024 / 1024).toFixed(2)} GB) 超出設定的記憶體上限限制 (${lastServerOptions.maxMemoryLimit} GB)。`);
    }
  }

  // 如果模型本身比實體記憶體總量(扣除1GB系統保留)還大，直接拒絕，避免系統崩潰
  if (modelSize > totalMem - 1024 * 1024 * 1024) {
    throw new Error(`模型大小 (${(modelSize / 1024 / 1024 / 1024).toFixed(2)} GB) 超出系統總記憶體限制 (${(totalMem / 1024 / 1024 / 1024).toFixed(2)} GB)。`);
  }
  
  // 3. 如果已有運行的 backend，先將其停止以釋放記憶體
  if (apiServerProcess) {
    console.log(`Stopping current backend model "${activeModelName}" to free RAM...`);
    mainWindow?.webContents.send('api-server-log', `[代理服務] 正在卸載模型 "${activeModelName}" 以釋放記憶體...\n`);
    isShuttingDownBackend = true;
    
    await new Promise((resolve) => {
      apiServerProcess.once('close', () => {
        resolve();
      });
      apiServerProcess.kill();
      apiServerProcess = null;
    });
    
    isShuttingDownBackend = false;
    activeModelName = null;
    mainWindow?.webContents.send('api-server-status', { running: true, message: '運行中 (無模型載入)', loadedModel: null });
    
    // 等待 1 秒讓系統徹底回收記憶體
    await new Promise(r => setTimeout(r, 1000));
  }
  
  // 如果預估的可用實體記憶體不足以載入該模型，在日誌中警告使用者
  const currentFreeMem = os.freemem();
  if (currentFreeMem < requiredMemWithBuffer) {
    const warningMsg = `[記憶體警告] 剩餘實體記憶體 (${(currentFreeMem / 1024 / 1024 / 1024).toFixed(2)} GB) 少於模型大小與緩衝需求 (${(requiredMemWithBuffer / 1024 / 1024 / 1024).toFixed(2)} GB)，系統可能會使用虛擬記憶體並減慢推理速度。\n`;
    console.warn(warningMsg.trim());
    mainWindow?.webContents.send('api-server-log', warningMsg);
  }
  
  // 4. 尋找閒置的內部端口
  currentBackendPort = await getFreePort(8081);
  
  // 5. 使用最新配置與新模型啟動 backend 伺服器
  const {
    apiKey, rpcNodes, ngl, np, ctxSize,
    flashAttention, cacheTypeK, cacheTypeV,
    specEnabled, draftModel, draftNgl, draftMax, draftMin, draftPMin,
    cudaDeviceId, cpuThreads
  } = lastServerOptions;
  
  const filteredRpcNodes = rpcNodes ? rpcNodes.filter(ip => ip !== '127.0.0.1' && ip !== 'localhost') : [];
  const rpcString = filteredRpcNodes.length > 0 ? filteredRpcNodes.map(ip => `${ip}:50052`).join(',') : '';
  
  const args = ['-m', modelPath, '--host', '127.0.0.1', '--port', currentBackendPort.toString()];
  
  if (apiKey) args.push('--api-key', apiKey);
  if (rpcString) args.push('--rpc', rpcString);
  if (ngl && ngl > 0) args.push('-ngl', ngl.toString());
  if (np && np > 0) args.push('-np', np.toString());
  if (ctxSize && ctxSize > 0) args.push('--ctx-size', ctxSize.toString());
  if (flashAttention) args.push('-fa');
  if (cacheTypeK && cacheTypeK !== 'f16') args.push('-ctk', cacheTypeK);
  if (cacheTypeV && cacheTypeV !== 'f16') args.push('-ctv', cacheTypeV);
  if (cpuThreads && cpuThreads > 0) args.push('-t', cpuThreads.toString());
  if (cudaDeviceId) args.push('--device', cudaDeviceId);
  
  // Speculative Decoding
  if (specEnabled && draftModel) {
    const draftModelPath = path.join(getModelsPath(), draftModel);
    args.push('-md', draftModelPath);
    if (draftNgl != null && draftNgl > 0) args.push('-ngld', draftNgl.toString());
    if (draftMax != null && draftMax > 0) args.push('--draft-max', draftMax.toString());
    if (draftMin != null && draftMin > 0) args.push('--draft-min', draftMin.toString());
    if (draftPMin != null && draftPMin > 0) args.push('--draft-p-min', draftPMin.toString());
  }
  
  console.log(`Spawning backend llama-server on port ${currentBackendPort} with args:`, args);
  mainWindow?.webContents.send('api-server-log', `[系統] 正在啟動推理引擎 (端口 ${currentBackendPort})，載入模型: ${modelName}...\n`);
  mainWindow?.webContents.send('api-server-status', { running: true, message: `載入模型中 (${modelName})`, loadedModel: modelName });
  
  apiServerProcess = spawn(serverPath, args);
  
  apiServerProcess.stdout.on('data', (data) => {
    mainWindow?.webContents.send('api-server-log', data.toString());
  });
  
  apiServerProcess.stderr.on('data', (data) => {
    mainWindow?.webContents.send('api-server-error', data.toString());
  });
  
  apiServerProcess.on('close', (code) => {
    console.log(`Backend llama-server exited with code ${code}`);
    apiServerProcess = null;
    activeModelName = null;
    
    if (!isShuttingDownBackend) {
      mainWindow?.webContents.send('api-server-log', `[錯誤] 推理引擎意外結束，代碼: ${code}\n`);
      mainWindow?.webContents.send('api-server-status', { running: true, message: '運行中 (核心意外終止)', loadedModel: null });
    }
  });
  
  // 6. 等待 /health 端口就緒
  const startWaitTime = Date.now();
  const maxWaitTime = 60000; // 最多等待 60 秒
  
  while (true) {
    if (!apiServerProcess) {
      throw new Error('推理引擎啟動失敗。');
    }
    if (Date.now() - startWaitTime > maxWaitTime) {
      isShuttingDownBackend = true;
      apiServerProcess.kill();
      apiServerProcess = null;
      isShuttingDownBackend = false;
      throw new Error('等待推理引擎啟動逾時。');
    }
    
    const healthy = await checkHealthEndpoint(currentBackendPort);
    if (healthy) {
      break;
    }
    
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  
  activeModelName = modelName;
  mainWindow?.webContents.send('api-server-log', `[系統] 模型 "${modelName}" 載入完成，推理引擎已就緒。\n`);
  mainWindow?.webContents.send('api-server-status', { running: true, message: `運行中 (已載入: ${modelName})`, loadedModel: modelName });
  
  resetIdleTimer();
}

async function startProxyServer() {
  const host = '0.0.0.0';
  const port = 8080;
  
  proxyServer = http.createServer(async (req, res) => {
    resetIdleTimer();
    
    try {
      const bodyBuffer = await bufferRequestBody(req);
      
      let requestedModel = null;
      const contentType = req.headers['content-type'] || '';
      if (contentType.includes('application/json') && bodyBuffer.length > 0) {
        try {
          const bodyJson = JSON.parse(bodyBuffer.toString('utf8'));
          if (bodyJson.model) {
            requestedModel = bodyJson.model;
          }
        } catch (e) {
          // JSON 解析失敗，忽略
        }
      }
      
      let targetModel = activeModelName;
      if (requestedModel) {
        const matched = await findMatchingModel(requestedModel);
        if (matched) {
          targetModel = matched;
        } else {
          res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({
            error: {
              message: `找不到請求的模型: "${requestedModel}"。請先在儀表板下載或放入此模型。`,
              type: 'invalid_request_error',
              code: 'model_not_found'
            }
          }));
          return;
        }
      } else if (!activeModelName) {
        if (lastServerOptions && lastServerOptions.modelName) {
          targetModel = lastServerOptions.modelName;
        }
      }
      
      if (targetModel && targetModel !== activeModelName) {
        // 檢查是否限制載入單一模型
        if (lastServerOptions && lastServerOptions.restrictSingleModel) {
          const lockedModel = activeModelName || lastServerOptions.modelName;
          if (lockedModel && targetModel !== lockedModel) {
            res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({
              error: {
                message: `API 伺服器已設定限制僅載入單一模型，不允許自動切換。目前鎖定模型為 "${lockedModel}"，而請求的模型為 "${targetModel}"。`,
                type: 'invalid_request_error',
                code: 'model_switching_restricted'
              }
            }));
            return;
          }
        }

        // 檢查是否開啟自動加載
        if (lastServerOptions && lastServerOptions.autoLoadEnabled === false) {
          res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({
            error: {
              message: `即時模型加載 (On-demand loading) 已停用。請先在主面板手動載入模型 "${targetModel}"。`,
              type: 'invalid_request_error',
              code: 'auto_load_disabled'
            }
          }));
          return;
        }

        // 檢查記憶體限制
        if (lastServerOptions && lastServerOptions.maxMemoryLimit > 0) {
          const targetModelPath = path.join(getModelsPath(), targetModel);
          try {
            const mStats = await fs.stat(targetModelPath);
            const limitBytes = lastServerOptions.maxMemoryLimit * 1024 * 1024 * 1024;
            if (mStats.size > limitBytes) {
              res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
              res.end(JSON.stringify({
                error: {
                  message: `模型 "${targetModel}" 的大小 (${(mStats.size / 1024 / 1024 / 1024).toFixed(2)} GB) 超出設定的記憶體上限限制 (${lastServerOptions.maxMemoryLimit} GB)。`,
                  type: 'invalid_request_error',
                  code: 'memory_limit_exceeded'
                }
              }));
              return;
            }
          } catch (e) {
            // Stat 失敗讓 loadModelBackend 去處理錯誤
          }
        }

        mainWindow?.webContents.send('api-server-log', `[代理服務] 偵測到請求指定模型 "${targetModel}"，開始自動載入...\n`);
        await loadModelBackend(targetModel);
      }
      
      if (!apiServerProcess || !currentBackendPort) {
        res.writeHead(503, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({
          error: {
            message: '推理核心尚未啟動，且自動載入失敗。',
            type: 'service_unavailable',
            code: 'no_active_model'
          }
        }));
        return;
      }
      
      // 轉發請求
      const options = {
        hostname: '127.0.0.1',
        port: currentBackendPort,
        path: req.url,
        method: req.method,
        headers: req.headers
      };
      
      const proxyReq = http.request(options, (proxyRes) => {
        res.writeHead(proxyRes.statusCode, proxyRes.headers);
        proxyRes.pipe(res, { end: true });
      });
      
      proxyReq.on('error', (err) => {
        console.error('Proxy request error:', err);
        res.writeHead(502, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: { message: `內部代理轉發錯誤: ${err.message}` } }));
      });
      
      proxyReq.write(bodyBuffer);
      proxyReq.end();
      
    } catch (err) {
      console.error('Proxy server internal error:', err);
      res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: { message: `代理伺服器內部錯誤: ${err.message}` } }));
    }
  });
  
  return new Promise((resolve, reject) => {
    proxyServer.listen(port, host, () => {
      console.log(`API Proxy Server listening on ${host}:${port}`);
      mainWindow?.webContents.send('api-server-status', { running: true, message: '運行中 (無模型載入)', loadedModel: null });
      resolve();
    });
    
    proxyServer.on('error', (err) => {
      console.error('Failed to start API Proxy Server:', err);
      proxyServer = null;
      reject(err);
    });
  });
}

// ==================== IPC Handlers: API 伺服器管理 ====================

ipcMain.handle('start-api-server', async (event, options) => {
  try {
    if (getCurrentVersion() === '未安裝') {
      return { success: false, message: '尚未安裝 llama.cpp 推理核心，請先下載安裝。' };
    }
    
    if (proxyServer) {
      return { success: false, message: 'API 代理伺服器已在運行中' };
    }
    
    lastServerOptions = options;
    const { modelName } = options;
    
    // 啟動代理伺服器
    await startProxyServer();
    
    // 背景預先載入預設選取的模型
    if (modelName) {
      loadModelBackend(modelName).catch(err => {
        console.error('預先載入模型失敗:', err);
        mainWindow?.webContents.send('api-server-log', `[代理服務警告] 預先載入初始模型 "${modelName}" 失敗: ${err.message}\n`);
      });
    }
    
    return { success: true, message: 'API 代理伺服器已啟動' };
  } catch (error) {
    console.error('Failed to start API server proxy:', error);
    return { success: false, message: error.message };
  }
});

ipcMain.handle('stop-api-server', async () => {
  let stoppedAny = false;
  
  if (idleTimer) {
    clearTimeout(idleTimer);
    idleTimer = null;
  }
  
  if (proxyServer) {
    proxyServer.close();
    proxyServer = null;
    stoppedAny = true;
  }
  
  if (apiServerProcess) {
    isShuttingDownBackend = true;
    apiServerProcess.kill();
    apiServerProcess = null;
    stoppedAny = true;
  }
  
  activeModelName = null;
  currentBackendPort = null;
  isShuttingDownBackend = false;
  
  if (stoppedAny) {
    mainWindow?.webContents.send('api-server-status', false);
    return { success: true, message: 'API 伺服器與代理服務已停止' };
  }
  return { success: false, message: 'API 伺服器未在運行' };
});

ipcMain.handle('unload-model', async () => {
  if (idleTimer) {
    clearTimeout(idleTimer);
    idleTimer = null;
  }
  
  if (apiServerProcess) {
    const prevModel = activeModelName;
    isShuttingDownBackend = true;
    
    await new Promise((resolve) => {
      if (apiServerProcess) {
        apiServerProcess.once('close', () => {
          resolve();
        });
        apiServerProcess.kill();
        apiServerProcess = null;
      } else {
        resolve();
      }
    });
    
    isShuttingDownBackend = false;
    activeModelName = null;
    currentBackendPort = null;
    
    mainWindow?.webContents.send('api-server-log', `[代理服務] 已成功卸載模型 "${prevModel}"。\n`);
    mainWindow?.webContents.send('api-server-status', { running: true, message: '運行中 (無模型載入)', loadedModel: null });
    return { success: true, message: `已成功卸載模型 "${prevModel}"` };
  }
  
  return { success: false, message: '當前無載入模型' };
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
    if (getCurrentVersion() === '未安裝') {
      return { success: false, message: '尚未安裝 llama.cpp 推理核心，無法重啟 RPC 伺服器。' };
    }
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
    if (proxyServer) {
      console.log('正在關閉 API 代理伺服器以進行更新...');
      proxyServer.close();
      proxyServer = null;
    }
    if (apiServerProcess) {
      console.log('正在關閉 API 伺服器以進行更新...');
      isShuttingDownBackend = true;
      apiServerProcess.kill();
      apiServerProcess = null;
    }
    activeModelName = null;
    currentBackendPort = null;
    isShuttingDownBackend = false;
    mainWindow?.webContents.send('api-server-status', false);

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
  if (proxyServer) proxyServer.close();
  if (idleTimer) clearTimeout(idleTimer);
  if (bonjour) bonjour.destroy();
  if (discoveryInterval) clearInterval(discoveryInterval);
});