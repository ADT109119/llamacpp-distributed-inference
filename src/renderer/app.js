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
    localIpsContainer: document.getElementById('local-ips-container'),
    nodesContainer: document.getElementById('nodes-container'),
    modelSelect: document.getElementById('model-select'),
    gpuLayers: document.getElementById('gpu-layers'),
    gpuSlider: document.getElementById('gpu-slider'),
    mainActionBtn: document.getElementById('main-action-btn'),
    themeToggle: document.getElementById('theme-toggle'),
    settingsBtn: document.getElementById('settings-btn'),
    addNodeBtn: document.getElementById('add-node-btn'),
    apiKeyModal: document.getElementById('api-key-modal'),
    apiKeyInput: document.getElementById('api-key-input'),
    saveApiKeyBtn: document.getElementById('save-api-key'),
    cancelApiKeyBtn: document.getElementById('cancel-api-key'),
    closeModal: document.querySelector('.close'),
    addNodeModal: document.getElementById('add-node-modal'),
    nodeIpInput: document.getElementById('node-ip-input'),
    addNodeConfirm: document.getElementById('add-node-confirm'),
    addNodeCancel: document.getElementById('add-node-cancel'),
    closeAddNodeModal: document.querySelector('.close-add-node'),
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
    
    // 載入本機IP地址
    await loadLocalIps();
    
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

// 載入本機IP地址
async function loadLocalIps() {
    try {
        console.log('Loading local IPs...');
        const localIps = await window.electronAPI.getLocalIps();
        console.log('Local IPs loaded:', localIps);
        
        if (localIps && localIps.length > 0) {
            updateLocalIpsDisplay(localIps);
            logMessage('系統', `載入 ${localIps.length} 個網路介面`, 'success');
        } else {
            elements.localIpsContainer.innerHTML = '<p class="loading">未找到網路介面</p>';
            logMessage('系統', '未找到任何網路介面', 'error');
        }
    } catch (error) {
        console.error('Error loading local IPs:', error);
        elements.localIpsContainer.innerHTML = '<p class="loading">載入網路介面失敗</p>';
        logMessage('系統', `載入本機IP失敗: ${error.message}`, 'error');
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

// 更新本機IP顯示
function updateLocalIpsDisplay(localIps) {
    console.log('Updating local IPs display with:', localIps);
    
    if (!localIps || localIps.length === 0) {
        elements.localIpsContainer.innerHTML = '<p class="loading">無法獲取本機IP地址</p>';
        return;
    }
    
    elements.localIpsContainer.innerHTML = '';
    
    localIps.forEach(ipInfo => {
        const ipItem = document.createElement('div');
        ipItem.className = 'local-ip-item';
        
        // 處理介面名稱顯示
        let interfaceLabel;
        if (ipInfo.internal) {
            interfaceLabel = '本機回環';
        } else {
            // 簡化介面名稱顯示
            const name = ipInfo.interface || 'Unknown';
            if (name.toLowerCase().includes('wi-fi') || name.toLowerCase().includes('wireless')) {
                interfaceLabel = 'Wi-Fi';
            } else if (name.toLowerCase().includes('ethernet') || name.toLowerCase().includes('乙太網路')) {
                interfaceLabel = '乙太網路';
            } else {
                interfaceLabel = name.length > 15 ? name.substring(0, 15) + '...' : name;
            }
        }
        
        const iconClass = ipInfo.internal ? 'fas fa-home' : 'fas fa-network-wired';
        
        ipItem.innerHTML = `
            <div class="local-ip-info">
                <i class="${iconClass}"></i>
                <span class="local-ip-address">${ipInfo.address}</span>
                <span class="local-ip-interface">${interfaceLabel}</span>
            </div>
        `;
        
        elements.localIpsContainer.appendChild(ipItem);
    });
    
    console.log('Local IPs display updated successfully');
}

// 檢查是否為本機IP
function isLocalIpAddress(ip) {
    // 檢查是否為 localhost
    if (ip === '127.0.0.1' || ip === 'localhost') {
        return true;
    }
    
    // 檢查是否為IPv6地址
    if (ip.includes(':')) {
        // 檢查常見的IPv6本機地址
        if (ip === '::1' || ip.toLowerCase().startsWith('fe80:')) {
            return true;
        }
    }
    
    // 檢查是否為本機的任何網路介面IP
    const localIps = Array.from(document.querySelectorAll('.local-ip-address')).map(el => el.textContent);
    return localIps.includes(ip);
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
        
        const isLocalhost = isLocalIpAddress(nodeIp);
        
        nodeItem.innerHTML = `
            <div class="node-info">
                <i class="node-icon fas fa-server"></i>
                <div class="node-details">
                    <span class="node-ip">${nodeIp}</span>
                    ${isLocalhost ? '<span class="node-label">本機</span>' : ''}
                    ${isLocalhost ? '<span class="node-note">API伺服器運行時自動參與計算</span>' : ''}
                </div>
            </div>
            <div class="node-controls">
                <button class="check-connection-btn" data-node="${nodeIp}" title="檢查連接">
                    <i class="fas fa-wifi"></i>
                </button>
                ${isLocalhost ? 
                    '<div class="node-status">自動參與</div>' : 
                    `<div class="node-toggle" data-node="${nodeIp}"></div>`
                }
                <button class="remove-node-btn" data-node="${nodeIp}" title="移除節點" ${isLocalhost && nodeIp === '127.0.0.1' ? 'style="display:none"' : ''}>
                    <i class="fas fa-times"></i>
                </button>
            </div>
        `;
        
        const toggle = nodeItem.querySelector('.node-toggle');
        if (toggle) {
            toggle.addEventListener('click', () => toggleNode(nodeIp, toggle));
        }
        
        const checkBtn = nodeItem.querySelector('.check-connection-btn');
        checkBtn.addEventListener('click', () => checkNodeConnection(nodeIp));
        
        const removeBtn = nodeItem.querySelector('.remove-node-btn');
        if (removeBtn) {
            removeBtn.addEventListener('click', () => removeNode(nodeIp));
        }
        
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
    
    // 計算總參與節點數：選中的遠程節點 + 本機(如果存在)
    const rpcNodes = selectedNodes.filter(ip => ip !== '127.0.0.1');
    const hasLocalhost = discoveredNodes.includes('127.0.0.1');
    const totalParticipating = rpcNodes.length + (hasLocalhost ? 1 : 0);
    const totalAvailable = discoveredNodes.length;
    
    updateNodeCount(totalParticipating, totalAvailable);
    
    if (rpcNodes.length > 0) {
        logMessage('系統', `已選擇 ${rpcNodes.length} 個RPC節點: ${rpcNodes.join(', ')}`, 'info');
    }
    if (hasLocalhost) {
        logMessage('系統', '本機將作為API伺服器自動參與計算', 'info');
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
    
    // 過濾掉本機IP，因為API伺服器會自動參與計算
    const rpcNodes = selectedNodes.filter(ip => ip !== '127.0.0.1');
    
    if (rpcNodes.length === 0) {
        const confirm = window.confirm('未選擇任何RPC節點，將僅使用本機進行推理。是否繼續？');
        if (!confirm) return;
    }
    
    try {
        updateMainActionButton('loading');
        
        const result = await window.electronAPI.startApiServer({
            modelName,
            apiKey,
            rpcNodes: rpcNodes, // 使用過濾後的RPC節點
            ngl
        });
        
        if (result.success) {
            logMessage('系統', result.message, 'success');
            logMessage('系統', `使用模型: ${modelName}`, 'info');
            logMessage('系統', `GPU 層數: ${ngl}`, 'info');
            logMessage('系統', `RPC節點: ${rpcNodes.join(', ') || '無'}`, 'info');
            logMessage('系統', `本機作為API伺服器參與計算`, 'info');
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

// 檢查節點連接
async function checkNodeConnection(nodeIp) {
    try {
        logMessage('系統', `正在檢查節點 ${nodeIp} 的連接...`, 'info');
        
        // 顯示檢查狀態
        const checkBtn = document.querySelector(`[data-node="${nodeIp}"].check-connection-btn`);
        if (checkBtn) {
            checkBtn.disabled = true;
            checkBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i>';
        }
        
        const result = await window.electronAPI.checkNodeConnection(nodeIp);
        
        if (result.success) {
            if (result.reachable) {
                logMessage('系統', result.message, 'success');
                // 顯示成功提示
                showConnectionStatus(nodeIp, true);
            } else {
                logMessage('系統', result.message, 'error');
                // 顯示失敗提示
                showConnectionStatus(nodeIp, false);
            }
            return result.reachable;
        } else {
            logMessage('系統', result.message, 'error');
            showConnectionStatus(nodeIp, false);
            return false;
        }
    } catch (error) {
        logMessage('系統', `檢查連接失敗: ${error.message}`, 'error');
        showConnectionStatus(nodeIp, false);
        return false;
    } finally {
        // 恢復按鈕狀態
        const checkBtn = document.querySelector(`[data-node="${nodeIp}"].check-connection-btn`);
        if (checkBtn) {
            checkBtn.disabled = false;
            checkBtn.innerHTML = '<i class="fas fa-wifi"></i>';
        }
    }
}

// 顯示連接狀態提示
function showConnectionStatus(nodeIp, success) {
    const nodeItem = document.querySelector(`[data-node="${nodeIp}"]`).closest('.node-item');
    if (!nodeItem) return;
    
    // 移除舊的狀態提示
    const oldStatus = nodeItem.querySelector('.connection-status');
    if (oldStatus) {
        oldStatus.remove();
    }
    
    // 創建新的狀態提示
    const statusDiv = document.createElement('div');
    statusDiv.className = `connection-status ${success ? 'success' : 'error'}`;
    statusDiv.innerHTML = success ? 
        '<i class="fas fa-check-circle"></i> 連接成功' : 
        '<i class="fas fa-times-circle"></i> 連接失敗';
    
    // 添加到節點項目
    nodeItem.appendChild(statusDiv);
    
    // 3秒後自動移除
    setTimeout(() => {
        if (statusDiv.parentNode) {
            statusDiv.remove();
        }
    }, 3000);
}

// 手動添加節點
async function addManualNode() {
    const nodeIp = elements.nodeIpInput.value.trim();
    
    if (!nodeIp) {
        alert('請輸入節點IP地址');
        return;
    }
    
    try {
        // 顯示載入狀態
        elements.addNodeConfirm.disabled = true;
        elements.addNodeConfirm.innerHTML = '<i class="fas fa-spinner fa-spin"></i> 檢查中...';
        
        const result = await window.electronAPI.addManualNode(nodeIp);
        
        if (result.success) {
            if (result.reachable) {
                logMessage('系統', result.message, 'success');
            } else {
                logMessage('系統', result.message, 'error');
            }
            elements.addNodeModal.style.display = 'none';
            elements.nodeIpInput.value = '';
        } else {
            logMessage('系統', result.message, 'error');
        }
    } catch (error) {
        logMessage('系統', `添加節點失敗: ${error.message}`, 'error');
    } finally {
        // 恢復按鈕狀態
        elements.addNodeConfirm.disabled = false;
        elements.addNodeConfirm.innerHTML = '<i class="fas fa-plus"></i> 添加';
    }
}

// 移除節點
async function removeNode(nodeIp) {
    // 檢查是否為本機IP
    if (isLocalIpAddress(nodeIp)) {
        logMessage('系統', '無法移除本機節點', 'error');
        return;
    }
    
    const confirm = window.confirm(`確定要移除節點 ${nodeIp} 嗎？`);
    if (!confirm) return;
    
    try {
        const result = await window.electronAPI.removeNode(nodeIp);
        
        if (result.success) {
            logMessage('系統', result.message, 'success');
        } else {
            logMessage('系統', result.message, 'error');
        }
    } catch (error) {
        logMessage('系統', `移除節點失敗: ${error.message}`, 'error');
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
    
    // 自動滾動到底部
    setTimeout(() => {
        targetLog.scrollTop = targetLog.scrollHeight;
    }, 10);
    
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
    
    // 手動添加節點按鈕 (移除重複的事件監聽器)
    
    // GPU 控制同步
    syncGpuControls();
    
    // API Key 模態框事件
    elements.saveApiKeyBtn.addEventListener('click', saveApiKey);
    elements.cancelApiKeyBtn.addEventListener('click', () => {
        elements.apiKeyModal.style.display = 'none';
    });
    elements.closeModal.addEventListener('click', () => {
        elements.apiKeyModal.style.display = 'none';
    });
    
    // 添加節點模態框事件
    elements.addNodeConfirm.addEventListener('click', addManualNode);
    elements.addNodeCancel.addEventListener('click', () => {
        elements.addNodeModal.style.display = 'none';
        elements.nodeIpInput.value = '';
    });
    elements.closeAddNodeModal.addEventListener('click', () => {
        elements.addNodeModal.style.display = 'none';
        elements.nodeIpInput.value = '';
    });
    
    // Enter 鍵添加節點
    elements.nodeIpInput.addEventListener('keypress', (e) => {
        if (e.key === 'Enter') {
            e.preventDefault();
            addManualNode();
        }
    });
    
    // 確保輸入框可以獲得焦點
    elements.addNodeBtn.addEventListener('click', () => {
        elements.addNodeModal.style.display = 'block';
        // 延遲一點讓模態框完全顯示後再聚焦
        setTimeout(() => {
            elements.nodeIpInput.focus();
        }, 100);
    });
    
    // 點擊模態框外部關閉
    window.addEventListener('click', (event) => {
        if (event.target === elements.apiKeyModal) {
            elements.apiKeyModal.style.display = 'none';
        }
        if (event.target === elements.addNodeModal) {
            elements.addNodeModal.style.display = 'none';
            elements.nodeIpInput.value = '';
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