const { contextBridge, ipcRenderer } = require('electron');

// 暴露安全的 API 給渲染進程
contextBridge.exposeInMainWorld('electronAPI', {
  // 模型管理
  getModels: () => ipcRenderer.invoke('get-models'),
  
  // API 伺服器控制
  startApiServer: (options) => ipcRenderer.invoke('start-api-server', options),
  stopApiServer: () => ipcRenderer.invoke('stop-api-server'),
  
  // API Key 管理
  getApiKey: () => ipcRenderer.invoke('get-api-key'),
  setApiKey: (apiKey) => ipcRenderer.invoke('set-api-key', apiKey),
  
  // 節點發現
  getDiscoveredNodes: () => ipcRenderer.invoke('get-discovered-nodes'),
  
  // 事件監聽
  onNodeUpdate: (callback) => ipcRenderer.on('node-update', callback),
  onRpcServerStatus: (callback) => ipcRenderer.on('rpc-server-status', callback),
  onApiServerStatus: (callback) => ipcRenderer.on('api-server-status', callback),
  onRpcServerLog: (callback) => ipcRenderer.on('rpc-server-log', callback),
  onRpcServerError: (callback) => ipcRenderer.on('rpc-server-error', callback),
  onApiServerLog: (callback) => ipcRenderer.on('api-server-log', callback),
  onApiServerError: (callback) => ipcRenderer.on('api-server-error', callback),
  
  // 移除事件監聽
  removeAllListeners: (channel) => ipcRenderer.removeAllListeners(channel)
});