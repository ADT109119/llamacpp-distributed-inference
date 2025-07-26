import { app, BrowserWindow, ipcMain } from 'electron';
import { spawn } from 'child_process';
import path from 'path';
import fs from 'fs/promises';
import { fileURLToPath } from 'url';
import { Bonjour } from 'bonjour-service';
import Store from 'electron-store';
import os from 'os';
import net from 'net';

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
  // 設定圖示路徑
  const iconPath = app.isPackaged 
    ? path.join(process.resourcesPath, 'images', 'icon.png')
    : path.join(__dirname, '../../images/icon.png');

  mainWindow = new BrowserWindow({
    width: 1400,
    height: 800,
    minWidth: 1200,
    minHeight: 700,
    icon: iconPath, // 設定視窗圖示
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
    const serviceName = 'LLMNode-' + os.hostname();

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
          // 過濾掉無效的地址和IPv6地址
          if (addr && 
              addr !== '0.0.0.0' && 
              !addr.startsWith('169.254') && 
              !addr.includes(':') && // 排除IPv6
              /^(?:(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.){3}(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)$/.test(addr)) { // 確保是有效的IPv4
            
            // 檢查是否為本機IP
            const interfaces = os.networkInterfaces();
            let isLocalIp = false;
            Object.keys(interfaces).forEach(name => {
              const interfaceList = interfaces[name];
              if (interfaceList) {
                interfaceList.forEach(iface => {
                  if (iface.family === 'IPv4' && iface.address === addr) {
                    isLocalIp = true;
                  }
                });
              }
            });
            
            // 如果是本機IP，確保 127.0.0.1 存在，其他本機IP都忽略
            if (isLocalIp) {
              // 確保 127.0.0.1 在節點列表中
              if (!discoveredNodes.has('127.0.0.1')) {
                discoveredNodes.add('127.0.0.1');
                console.log('Added localhost node via mDNS discovery');
                mainWindow?.webContents.send('node-update', Array.from(discoveredNodes));
              }
              // 其他本機IP (如 192.168.x.x) 都忽略，不添加到節點列表
              if (addr !== '127.0.0.1') {
                console.log('Ignored local IP:', addr, '(only 127.0.0.1 allowed for localhost)');
              }
            } else {
              // 非本機IP，正常添加
              if (!discoveredNodes.has(addr)) {
                discoveredNodes.add(addr);
                console.log('Added discovered remote node:', addr);
                mainWindow?.webContents.send('node-update', Array.from(discoveredNodes));
              }
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

    // 自動添加 127.0.0.1 作為本機節點選項
    discoveredNodes.add('127.0.0.1');
    console.log('Added 127.0.0.1 as localhost option');
    
    // 發送初始節點列表
    setTimeout(() => {
      mainWindow?.webContents.send('node-update', Array.from(discoveredNodes));
    }, 1000);

    // 設定定時廣播和搜尋 (每30秒)
    const discoveryInterval = setInterval(() => {
      console.log('Performing periodic mDNS discovery...');
      
      // 重新搜尋服務
      const periodicBrowser = bonjour.find({ type: serviceType, protocol: 'tcp' });
      
      periodicBrowser.on('up', (service) => {
        console.log('Periodic discovery - Service up:', service.name, service.addresses);
        if (service.addresses && service.addresses.length > 0) {
          service.addresses.forEach(addr => {
            if (addr && 
                addr !== '0.0.0.0' && 
                !addr.startsWith('169.254') && 
                !addr.includes(':') && 
                /^(?:(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.){3}(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)$/.test(addr)) {
              
              const interfaces = os.networkInterfaces();
              let isLocalIp = false;
              Object.keys(interfaces).forEach(name => {
                const interfaceList = interfaces[name];
                if (interfaceList) {
                  interfaceList.forEach(iface => {
                    if (iface.family === 'IPv4' && iface.address === addr) {
                      isLocalIp = true;
                    }
                  });
                }
              });
              
              if (isLocalIp) {
                if (!discoveredNodes.has('127.0.0.1')) {
                  discoveredNodes.add('127.0.0.1');
                  console.log('Periodic discovery - Added localhost node');
                  mainWindow?.webContents.send('node-update', Array.from(discoveredNodes));
                }
                if (addr !== '127.0.0.1') {
                  console.log('Periodic discovery - Ignored local IP:', addr);
                }
              } else {
                if (!discoveredNodes.has(addr)) {
                  discoveredNodes.add(addr);
                  console.log('Periodic discovery - Added remote node:', addr);
                  mainWindow?.webContents.send('node-update', Array.from(discoveredNodes));
                }
              }
            }
          });
        }
      });

      // 停止這次的搜尋 (5秒後)
      setTimeout(() => {
        periodicBrowser.stop();
      }, 5000);
    }, 30000); // 每30秒執行一次

    // 清理定時器的函數
    global.cleanupDiscovery = () => {
      if (discoveryInterval) {
        clearInterval(discoveryInterval);
      }
    };

  } catch (error) {
    console.error('Failed to start mDNS discovery:', error);
    // 如果 mDNS 失敗，至少確保有 127.0.0.1
    discoveredNodes.add('127.0.0.1');
    setTimeout(() => {
      mainWindow?.webContents.send('node-update', Array.from(discoveredNodes));
    }, 1000);
  }
}

// IPC 處理器
// 獲取模型資料夾路徑
function getModelsPath() {
  const customPath = store.get('modelsPath');
  if (customPath) {
    return customPath;
  }
  
  // 預設路徑：始終在當前執行路徑下的 models 資料夾
  if (app.isPackaged) {
    // 打包後：在執行檔同目錄下的 models 資料夾
    return path.join(path.dirname(process.execPath), 'models');
  } else {
    // 開發中：在專案根目錄的 models 資料夾
    return path.join(process.cwd(), 'models');
  }
}

ipcMain.handle('get-models', async () => {
  try {
    const modelsPath = getModelsPath();
    console.log('Models path:', modelsPath);
    
    // 檢查 models 目錄是否存在，不存在則創建
    try {
      await fs.access(modelsPath);
    } catch {
      console.log('Creating models directory:', modelsPath);
      await fs.mkdir(modelsPath, { recursive: true });
      
      // 創建說明檔案
      const readmePath = path.join(modelsPath, 'README.md');
      const readmeContent = `# 模型資料夾

請將您的 GGUF 格式模型檔案放置在此資料夾中。

## 支援的模型格式
- \`.gguf\` 檔案

## 建議的模型來源
- [Hugging Face](https://huggingface.co/models?library=gguf)
- [TheBloke 的量化模型](https://huggingface.co/TheBloke)

## 注意事項
- 模型檔案可能很大（數 GB），請確保有足夠的磁碟空間
- 較大的模型需要更多的 RAM 和 VRAM
- 建議使用量化版本（如 Q4_K_M）以節省記憶體`;
      
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

ipcMain.handle('get-models-path', async () => {
  return getModelsPath();
});

ipcMain.handle('set-models-path', async (event, newPath) => {
  try {
    // 驗證路徑是否存在
    await fs.access(newPath);
    
    // 儲存新路徑
    store.set('modelsPath', newPath);
    
    return { success: true, message: `模型路徑已設定為: ${newPath}` };
  } catch (error) {
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
    } else {
      return { success: false, message: '未選擇資料夾' };
    }
  } catch (error) {
    return { success: false, message: `選擇資料夾失敗: ${error.message}` };
  }
});

ipcMain.handle('open-models-folder', async () => {
  try {
    const { shell } = await import('electron');
    const modelsPath = getModelsPath();
    
    // 確保資料夾存在
    try {
      await fs.access(modelsPath);
    } catch {
      // 如果資料夾不存在，創建它
      await fs.mkdir(modelsPath, { recursive: true });
    }
    
    // 開啟資料夾
    await shell.openPath(modelsPath);
    return { success: true, message: `已開啟資料夾: ${modelsPath}` };
  } catch (error) {
    return { success: false, message: `開啟資料夾失敗: ${error.message}` };
  }
});

ipcMain.handle('start-api-server', async (event, options) => {
  try {
    const { modelName, apiKey, rpcNodes, ngl, np } = options;
    
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
    const modelPath = path.join(getModelsPath(), modelName);

    // 過濾掉本機IP，因為API伺服器本身就會參與計算
    const filteredRpcNodes = rpcNodes.filter(ip => ip !== '127.0.0.1' && ip !== 'localhost');
    const rpcString = filteredRpcNodes.length > 0 ? filteredRpcNodes.map(ip => `${ip}:50052`).join(',') : '';
    
    console.log('Original RPC nodes:', rpcNodes);
    console.log('Filtered RPC nodes (excluding localhost):', filteredRpcNodes);
    console.log('RPC string:', rpcString);
    
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

    if (np && np > 0) {
      args.push('-np', np.toString());
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

ipcMain.handle('get-local-ips', async () => {
  try {
    const interfaces = os.networkInterfaces();
    const localIps = [];
    
    console.log('Network interfaces:', interfaces);
    
    Object.keys(interfaces).forEach(name => {
      const interfaceList = interfaces[name];
      if (interfaceList) {
        interfaceList.forEach(iface => {
          // 只處理IPv4地址
          if (iface.family === 'IPv4') {
            localIps.push({
              address: iface.address,
              interface: name,
              internal: iface.internal
            });
            console.log(`Found IPv4 interface: ${name} - ${iface.address} (internal: ${iface.internal})`);
          }
        });
      }
    });
    
    console.log('Local IPs found:', localIps);
    return localIps;
  } catch (error) {
    console.error('Error getting local IPs:', error);
    // 返回基本的本機地址作為後備
    return [
      {
        address: '127.0.0.1',
        interface: 'Loopback',
        internal: true
      }
    ];
  }
});

// 檢查節點連接性
async function checkNodeConnection(nodeIp, port = 50052) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    
    const timeout = setTimeout(() => {
      socket.destroy();
      resolve(false);
    }, 5000); // 5秒超時
    
    socket.connect(port, nodeIp, () => {
      clearTimeout(timeout);
      socket.destroy();
      resolve(true);
    });
    
    socket.on('error', () => {
      clearTimeout(timeout);
      resolve(false);
    });
  });
}

ipcMain.handle('check-node-connection', async (event, nodeIp) => {
  try {
    console.log(`Checking connection to ${nodeIp}:50052...`);
    const isConnectable = await checkNodeConnection(nodeIp);
    
    if (isConnectable) {
      console.log(`Node ${nodeIp} is reachable`);
      return { 
        success: true, 
        reachable: true, 
        message: `節點 ${nodeIp} 連接成功，RPC 服務正在運行` 
      };
    } else {
      console.log(`Node ${nodeIp} is not reachable`);
      return { 
        success: true, 
        reachable: false, 
        message: `無法連接到節點 ${nodeIp}:50052，請確認目標設備已啟動此程式` 
      };
    }
  } catch (error) {
    console.error('Error checking node connection:', error);
    return { 
      success: false, 
      reachable: false, 
      message: `檢查連接時發生錯誤: ${error.message}` 
    };
  }
});

ipcMain.handle('add-manual-node', async (event, nodeIp) => {
  try {
    // 驗證 IP 格式
    const ipRegex = /^(?:(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.){3}(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)$/;
    if (!ipRegex.test(nodeIp)) {
      return { success: false, message: '無效的 IP 地址格式' };
    }
    
    // 檢查是否已存在
    if (discoveredNodes.has(nodeIp)) {
      return { success: false, message: '該節點已存在' };
    }
    
    // 檢查是否為本機IP
    const interfaces = os.networkInterfaces();
    let isLocalIp = false;
    Object.keys(interfaces).forEach(name => {
      const interfaceList = interfaces[name];
      if (interfaceList) {
        interfaceList.forEach(iface => {
          // 只檢查IPv4地址
          if (iface.family === 'IPv4' && iface.address === nodeIp) {
            isLocalIp = true;
          }
        });
      }
    });
    
    if (isLocalIp) {
      // 如果是本機IP，只允許添加 127.0.0.1
      if (nodeIp === '127.0.0.1') {
        // 允許添加 127.0.0.1
      } else {
        return { success: false, message: '本機節點請使用 127.0.0.1，其他本機IP不允許添加' };
      }
    }
    
    // 檢查節點連接性
    console.log(`Checking connectivity for node: ${nodeIp}`);
    const connectionResult = await checkNodeConnection(nodeIp);
    
    // 無論是否可連接都添加節點，但返回連接狀態
    discoveredNodes.add(nodeIp);
    console.log('Manually added node:', nodeIp, 'Reachable:', connectionResult);
    
    // 通知前端更新
    mainWindow?.webContents.send('node-update', Array.from(discoveredNodes));
    
    if (connectionResult) {
      return { 
        success: true, 
        reachable: true,
        message: `節點 ${nodeIp} 已添加並驗證連接成功` 
      };
    } else {
      return { 
        success: true, 
        reachable: false,
        message: `節點 ${nodeIp} 已添加，但無法連接到 RPC 服務 (端口 50052)。請確認目標設備已啟動此程式。` 
      };
    }
  } catch (error) {
    console.error('Error adding manual node:', error);
    return { success: false, message: error.message };
  }
});

ipcMain.handle('remove-node', async (event, nodeIp) => {
  try {
    if (discoveredNodes.has(nodeIp)) {
      discoveredNodes.delete(nodeIp);
      console.log('Removed node:', nodeIp);
      
      // 通知前端更新
      mainWindow?.webContents.send('node-update', Array.from(discoveredNodes));
      
      return { success: true, message: `節點 ${nodeIp} 已移除` };
    } else {
      return { success: false, message: '節點不存在' };
    }
  } catch (error) {
    console.error('Error removing node:', error);
    return { success: false, message: error.message };
  }
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
  if (global.cleanupDiscovery) {
    global.cleanupDiscovery();
  }
});