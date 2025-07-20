// 全域變數
let discoveredNodes = [];
let selectedNodes = [];
let rpcServerRunning = false;
let apiServerRunning = false;

// DOM 元素
const elements = {
    rpcStatus: document.getElementById('rpc-status'),
    apiStatus: document.getElementById('api-status'),
    apiUrl: document.getElementById('api-url'),
    nodeCount: document.getElementById('node-count'),
    nodesContainer: document.getElementById('nodes-container'),
    modelSelect: document.getElementById('model-select'),
    gpuLayers: document.getElementById('gpu-layers'),
    gpuSlider: document.getElementById('gpu-slider'),
    mainActionBtn: document.getElementById('main-action-btn'),
    themeToggle: document.getElementById('theme-toggle'),
    settingsBtn: document.getElementById('settings-btn'),
    apiKeyModal: document.getElementById('api-key-modal'),
    apiKeyInput: document.getElementById('api-key-input'),
    saveApiKeyBtn: document.getElementById('save-api-key'),
    cancelApiKeyBtn: document.getElementById('cancel-api-key'),
    closeModal: document.querySelector('.close'),
    systemLog: document.getElementById('system-log'),
    rpcLog: document.getElementById('rpc-log'),
    apiLog: document.getElementById('api-log'),
    tabBtns: document.querySelectorAll('.tab-btn')
};

// 初始化應用程式
async function initApp() {
    logMessage('系統', '應用程式啟動中...', 'info');
    
    // 初始化主題
    initTheme();
    
    // 載入模型列表
    await loadModels();
    
    // 載入已儲存的 API Key
    await loadApiKey();
    
    // 載入已發現的節點
    await loadDiscoveredNodes();
    
    // 設定事件監聽器
    setupEventListeners();
    
    logMessage('系統', '應用程式初始化完成', 'success');
    logMessage('系統', '正在啟動網路節點發現...', 'info');
}

// 載入模型列表
async function loadModels() {
    try {
        const models = await window.electronAPI.getModels();
        elements.modelSelect.innerHTML = '';
        
        if (models.length === 0) {
            elements.modelSelect.innerHTML = '<option value="">請將 .gguf 模型檔案放入 models 資料夾</option>';
            logMessage('系統', '未找到任何模型檔案，請將 .gguf 檔案放入 models 資料夾', 'info');
        } else {
            elements.modelSelect.innerHTML = '<option value="">請選擇模型...</option>';
            models.forEach(model => {
                const option = document.createElement('option');
                option.value = model;
                option.textContent = model;
                elements.modelSelect.appendChild(option);
            });
            logMessage('系統', `找到 ${models.length} 個模型檔案`, 'success');
        }
    } catch (error) {
        logMessage('系統', `載入模型列表失敗: ${error.message}`, 'error');
    }
}

// 載入已儲存的 API Key
async function loadApiKey() {
    try {
        const apiKey = await window.electronAPI.getApiKey();
        elements.apiKeyInput.value = apiKey;
    } catch (error) {
        logMessage('系統', `載入 API Key 失敗: ${error.message}`, 'error');
    }
}

// 載入已發現的節點
async function loadDiscoveredNodes() {
    try {
        const nodes = await window.electronAPI.getDiscoveredNodes();
        console.log('Initial nodes loaded:', nodes);
        updateNodesDisplay(nodes);
        if (nodes.length === 0) {
            logMessage('系統', '尚未發現任何節點，請稍候...', 'info');
        }
    } catch (error) {
        logMessage('系統', `載入節點列表失敗: ${error.message}`, 'error');
    }
}

// 更新節點顯示
function updateNodesDisplay(nodes) {
    discoveredNodes = nodes;
    
    if (nodes.length === 0) {
        elements.nodesContainer.innerHTML = '<p class="loading"><i class="fas fa-search"></i> 正在搜尋網路節點...</p>';
        updateNodeCount(0, 0);
        return;
    }
    
    elements.nodesContainer.innerHTML = '';
    
    nodes.forEach(nodeIp => {
        const nodeItem = document.createElement('div');
        nodeItem.className = 'node-item';
        
        const isLocalhost = nodeIp === '127.0.0.1' || nodeIp.includes('localhost');
        const nodeId = `node-${nodeIp.replace(/\./g, '-')}`;
        
        nodeItem.innerHTML = `
            <div class="node-info">
                <i class="node-icon fas fa-desktop"></i>
                <div class="node-details">
                    <span class="node-ip">${nodeIp}</span>
                    ${isLocalhost ? '<span class="node-label">本機</span>' : ''}
                </div>
            </div>
            <div class="node-controls">
                <div class="node-toggle ${isLocalhost ? 'active' : ''}" data-node="${nodeIp}">
                </div>
            </div>
        `;
        
        const toggle = nodeItem.querySelector('.node-toggle');
        toggle.addEventListener('click', () => toggleNode(nodeIp, toggle));
        
        elements.nodesContainer.appendChild(nodeItem);
    });
    
    updateSelectedNodes();
}

// 切換節點狀態
function toggleNode(nodeIp, toggleElement) {
    toggleElement.classList.toggle('active');
    updateSelectedNodes();
}

// 更新選中的節點
function updateSelectedNodes() {
    const activeToggles = document.querySelectorAll('.node-toggle.active');
    selectedNodes = Array.from(activeToggles).map(toggle => toggle.dataset.node);
    updateNodeCount(selectedNodes.length, discoveredNodes.length);
    if (selectedNodes.length > 0) {
        logMessage('系統', `已選擇 ${selectedNodes.length} 個節點: ${selectedNodes.join(', ')}`, 'info');
    }
}

// 更新節點計數顯示
function updateNodeCount(selected, total) {
    elements.nodeCount.textContent = `${selected}/${total}`;
}

// 更新狀態指示器
function updateStatusIndicator(dotElement, textElement, running) {
    dotElement.className = 'status-dot fas fa-circle';
    if (running === null) {
        dotElement.className += ' starting';
        textElement.textContent = '啟動中...';
    } else if (running) {
        dotElement.className += ' running';
        textElement.textContent = '運行中';
    } else {
        dotElement.className += ' stopped';
        textElement.textContent = '已停止';
    }
}

// 更新主操作按鈕
function updateMainActionButton(state) {
    const btnIcon = elements.mainActionBtn.querySelector('.btn-icon');
    const btnText = elements.mainActionBtn.querySelector('.btn-text');
    
    elements.mainActionBtn.className = 'main-action-btn';
    elements.mainActionBtn.disabled = false;
    
    switch (state) {
        case 'start':
            btnIcon.className = 'btn-icon fas fa-play';
            btnText.textContent = '啟動 API 伺服器';
            break;
        case 'loading':
            elements.mainActionBtn.classList.add('loading');
            btnIcon.className = 'btn-icon fas fa-spinner fa-spin';
            btnText.textContent = '啟動中...';
            elements.mainActionBtn.disabled = true;
            break;
        case 'stop':
            elements.mainActionBtn.classList.add('danger');
            btnIcon.className = 'btn-icon fas fa-stop';
            btnText.textContent = '停止 API 伺服器';
            break;
    }
}

// 啟動或停止 API 伺服器
async function toggleApiServer() {
    if (apiServerRunning) {
        await stopApiServer();
    } else {
        await startApiServer();
    }
}

// 啟動 API 伺服器
async function startApiServer() {
    const modelName = elements.modelSelect.value;
    const ngl = parseInt(elements.gpuLayers.value) || 0;
    const apiKey = elements.apiKeyInput.value;
    
    if (!modelName) {
        alert('請選擇一個模型');
        return;
    }
    
    if (selectedNodes.length === 0) {
        const confirm = window.confirm('未選擇任何節點，將僅使用本機進行推理。是否繼續？');
        if (!confirm) return;
    }
    
    try {
        updateMainActionButton('loading');
        
        const result = await window.electronAPI.startApiServer({
            modelName,
            apiKey,
            rpcNodes: selectedNodes,
            ngl
        });
        
        if (result.success) {
            logMessage('系統', result.message, 'success');
            logMessage('系統', `使用模型: ${modelName}`, 'info');
            logMessage('系統', `GPU 層數: ${ngl}`, 'info');
            logMessage('系統', `選擇的節點: ${selectedNodes.join(', ') || '僅本機'}`, 'info');
        } else {
            logMessage('系統', result.message, 'error');
            updateMainActionButton('start');
        }
    } catch (error) {
        logMessage('系統', `啟動 API 伺服器失敗: ${error.message}`, 'error');
        updateMainActionButton('start');
    }
}

// 停止 API 伺服器
async function stopApiServer() {
    try {
        const result = await window.electronAPI.stopApiServer();
        
        if (result.success) {
            logMessage('系統', result.message, 'success');
        } else {
            logMessage('系統', result.message, 'error');
        }
    } catch (error) {
        logMessage('系統', `停止 API 伺服器失敗: ${error.message}`, 'error');
    }
}

// 同步滑動條和輸入框
function syncGpuControls() {
    elements.gpuSlider.addEventListener('input', (e) => {
        elements.gpuLayers.value = e.target.value;
    });
    
    elements.gpuLayers.addEventListener('input', (e) => {
        const value = Math.max(0, Math.min(100, parseInt(e.target.value) || 0));
        elements.gpuLayers.value = value;
        elements.gpuSlider.value = value;
    });
}

// 主題切換功能
function toggleTheme() {
    const body = document.body;
    const themeIcon = elements.themeToggle.querySelector('.theme-icon');
    
    body.classList.toggle('dark-mode');
    
    if (body.classList.contains('dark-mode')) {
        themeIcon.className = 'theme-icon fas fa-sun';
        localStorage.setItem('theme', 'dark');
        logMessage('系統', '已切換至深色模式', 'info');
    } else {
        themeIcon.className = 'theme-icon fas fa-moon';
        localStorage.setItem('theme', 'light');
        logMessage('系統', '已切換至明亮模式', 'info');
    }
}

// 初始化主題
function initTheme() {
    const savedTheme = localStorage.getItem('theme');
    const themeIcon = elements.themeToggle.querySelector('.theme-icon');
    
    // 預設為明亮模式
    if (savedTheme === 'dark') {
        document.body.classList.add('dark-mode');
        themeIcon.className = 'theme-icon fas fa-sun';
    } else {
        themeIcon.className = 'theme-icon fas fa-moon';
    }
}

// 儲存 API Key
async function saveApiKey() {
    try {
        const apiKey = elements.apiKeyInput.value;
        const result = await window.electronAPI.setApiKey(apiKey);
        
        if (result.success) {
            logMessage('系統', 'API Key 已儲存', 'success');
            elements.apiKeyModal.style.display = 'none';
        } else {
            logMessage('系統', '儲存 API Key 失敗', 'error');
        }
    } catch (error) {
        logMessage('系統', `儲存 API Key 失敗: ${error.message}`, 'error');
    }
}

// 記錄訊息
function logMessage(category, message, type = 'info') {
    const timestamp = new Date().toLocaleTimeString();
    const logEntry = document.createElement('div');
    logEntry.className = `log-entry ${type}`;
    logEntry.textContent = `[${timestamp}] ${message}`;
    
    let targetLog;
    switch (category) {
        case 'RPC':
            targetLog = elements.rpcLog;
            break;
        case 'API':
            targetLog = elements.apiLog;
            break;
        default:
            targetLog = elements.systemLog;
    }
    
    targetLog.appendChild(logEntry);
    targetLog.scrollTop = targetLog.scrollHeight;
    
    // 限制日誌條目數量
    while (targetLog.children.length > 100) {
        targetLog.removeChild(targetLog.firstChild);
    }
}

// 設定事件監聽器
function setupEventListeners() {
    // 主操作按鈕
    elements.mainActionBtn.addEventListener('click', toggleApiServer);
    
    // 主題切換按鈕
    elements.themeToggle.addEventListener('click', toggleTheme);
    
    // 設定按鈕
    elements.settingsBtn.addEventListener('click', () => {
        elements.apiKeyModal.style.display = 'block';
    });
    
    // GPU 控制同步
    syncGpuControls();
    
    // 模態框事件
    elements.saveApiKeyBtn.addEventListener('click', saveApiKey);
    elements.cancelApiKeyBtn.addEventListener('click', () => {
        elements.apiKeyModal.style.display = 'none';
    });
    elements.closeModal.addEventListener('click', () => {
        elements.apiKeyModal.style.display = 'none';
    });
    
    // 點擊模態框外部關閉
    window.addEventListener('click', (event) => {
        if (event.target === elements.apiKeyModal) {
            elements.apiKeyModal.style.display = 'none';
        }
    });
    
    // 日誌標籤切換
    elements.tabBtns.forEach(btn => {
        btn.addEventListener('click', () => {
            const tabName = btn.dataset.tab;
            
            // 更新標籤狀態
            elements.tabBtns.forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            
            // 更新面板顯示
            document.querySelectorAll('.log-panel').forEach(panel => {
                panel.classList.remove('active');
            });
            document.getElementById(`${tabName}-log`).classList.add('active');
        });
    });
    
    // Electron IPC 事件監聽
    window.electronAPI.onNodeUpdate((event, nodes) => {
        console.log('Received node update:', nodes);
        updateNodesDisplay(nodes);
        logMessage('系統', `節點列表已更新，發現 ${nodes.length} 個節點: ${nodes.join(', ')}`, 'info');
    });
    
    window.electronAPI.onRpcServerStatus((event, running) => {
        rpcServerRunning = running;
        const rpcStatusText = elements.rpcStatus.nextElementSibling;
        updateStatusIndicator(elements.rpcStatus, rpcStatusText, running);
        if (running) {
            logMessage('RPC', 'RPC 伺服器已啟動', 'success');
        } else {
            logMessage('RPC', 'RPC 伺服器已停止', 'info');
        }
    });
    
    window.electronAPI.onApiServerStatus((event, running) => {
        apiServerRunning = running;
        const apiStatusText = elements.apiStatus.nextElementSibling;
        updateStatusIndicator(elements.apiStatus, apiStatusText, running);
        
        if (running) {
            updateMainActionButton('stop');
            elements.apiUrl.textContent = 'http://localhost:8080';
            elements.apiUrl.style.cursor = 'pointer';
            elements.apiUrl.onclick = () => window.open('http://localhost:8080');
            logMessage('API', 'API 伺服器已啟動，可在 http://localhost:8080 存取', 'success');
        } else {
            updateMainActionButton('start');
            elements.apiUrl.textContent = 'N/A';
            elements.apiUrl.style.cursor = 'default';
            elements.apiUrl.onclick = null;
            logMessage('API', 'API 伺服器已停止', 'info');
        }
    });
    
    window.electronAPI.onRpcServerLog((event, data) => {
        logMessage('RPC', data.trim(), 'info');
    });
    
    window.electronAPI.onRpcServerError((event, data) => {
        logMessage('RPC', data.trim(), 'error');
    });
    
    window.electronAPI.onApiServerLog((event, data) => {
        logMessage('API', data.trim(), 'info');
    });
    
    window.electronAPI.onApiServerError((event, data) => {
        logMessage('API', data.trim(), 'error');
    });
}

// 頁面載入完成後初始化
document.addEventListener('DOMContentLoaded', initApp);