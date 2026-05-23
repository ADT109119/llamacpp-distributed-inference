const { contextBridge, ipcRenderer } = require('electron');

// 暴露安全的 API 給渲染進程
contextBridge.exposeInMainWorld('electronAPI', {
  // ==================== 模型管理 ====================
  getModels: () => ipcRenderer.invoke('get-models'),
  
  // ==================== API 伺服器控制 ====================
  startApiServer: (options) => ipcRenderer.invoke('start-api-server', options),
  stopApiServer: () => ipcRenderer.invoke('stop-api-server'),
  
  // ==================== API Key 管理 ====================
  getApiKey: () => ipcRenderer.invoke('get-api-key'),
  setApiKey: (apiKey) => ipcRenderer.invoke('set-api-key', apiKey),
  
  // ==================== 模型路徑管理 ====================
  getModelsPath: () => ipcRenderer.invoke('get-models-path'),
  setModelsPath: (path) => ipcRenderer.invoke('set-models-path', path),
  resetModelsPath: () => ipcRenderer.invoke('reset-models-path'),
  browseModelsFolder: () => ipcRenderer.invoke('browse-models-folder'),
  openModelsFolder: () => ipcRenderer.invoke('open-models-folder'),
  
  // ==================== RPC server 控制 ====================
  restartRpcServer: () => ipcRenderer.invoke('restart-rpc-server'),
  
  // ==================== 節點發現 ====================
  getDiscoveredNodes: () => ipcRenderer.invoke('get-discovered-nodes'),
  getLocalIps: () => ipcRenderer.invoke('get-local-ips'),
  addManualNode: (nodeIp) => ipcRenderer.invoke('add-manual-node', nodeIp),
  removeNode: (nodeIp) => ipcRenderer.invoke('remove-node', nodeIp),
  checkNodeConnection: (nodeIp) => ipcRenderer.invoke('check-node-connection', nodeIp),
  
  // ==================== llama.cpp 更新 ====================
  checkLlamacppUpdates: () => ipcRenderer.invoke('check-llamacpp-updates'),
  getLlamacppAssets: () => ipcRenderer.invoke('get-llamacpp-assets'),
  downloadLlamacpp: (assetUrl, assetName, tag) => ipcRenderer.invoke('download-llamacpp', assetUrl, assetName, tag),
  getCurrentLlamacppVersion: () => ipcRenderer.invoke('get-current-llamacpp-version'),
  
  // ==================== Hugging Face 模型下載 ====================
  searchHfRepo: (repoId) => ipcRenderer.invoke('search-hf-repo', repoId),
  listHfModels: (repoId) => ipcRenderer.invoke('list-hf-models', repoId),
  downloadHfModel: (repoId, fileNames) => ipcRenderer.invoke('download-hf-model', repoId, fileNames),
  cancelHfDownload: () => ipcRenderer.invoke('cancel-hf-download'),
  
  // ==================== 事件監聽 ====================
  onNodeUpdate: (callback) => ipcRenderer.on('node-update', callback),
  onRpcServerStatus: (callback) => ipcRenderer.on('rpc-server-status', callback),
  onApiServerStatus: (callback) => ipcRenderer.on('api-server-status', callback),
  onRpcServerLog: (callback) => ipcRenderer.on('rpc-server-log', callback),
  onRpcServerError: (callback) => ipcRenderer.on('rpc-server-error', callback),
  onApiServerLog: (callback) => ipcRenderer.on('api-server-log', callback),
  onApiServerError: (callback) => ipcRenderer.on('api-server-error', callback),
  onDownloadProgress: (callback) => ipcRenderer.on('download-progress', callback),
  
  // ==================== 清理 ====================
  removeAllListeners: (channel) => ipcRenderer.removeAllListeners(channel)
});