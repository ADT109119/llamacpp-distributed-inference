// 全域變數
let discoveredNodes = [];
let selectedNodes = [];
let rpcServerRunning = false;
let apiServerRunning = false;
let currentlyActiveModel = null;

// DOM 元素
const elements = {
    rpcStatus: document.getElementById('rpc-status'),
    apiStatus: document.getElementById('api-status'),
    apiUrl: document.getElementById('api-url'),
    nodeCount: document.getElementById('node-count'),
    llamacppVersion: document.getElementById('llamacpp-version'),
    localIpsContainer: document.getElementById('local-ips-container'),
    nodesContainer: document.getElementById('nodes-container'),
    modelSelect: document.getElementById('model-select'),
    gpuLayers: document.getElementById('gpu-layers'),
    gpuSlider: document.getElementById('gpu-slider'),
    parallelRequests: document.getElementById('parallel-requests'),
    parallelSlider: document.getElementById('parallel-slider'),
    contextSize: document.getElementById('context-size'),
    contextSlider: document.getElementById('context-slider'),
    flashAttention: document.getElementById('flash-attention'),
    cacheTypeK: document.getElementById('cache-type-k'),
    cacheTypeV: document.getElementById('cache-type-v'),
    advancedSettingsToggle: document.getElementById('advanced-settings-toggle'),
    advancedSettingsContent: document.getElementById('advanced-settings-content'),
    mainActionBtn: document.getElementById('main-action-btn'),
    themeToggle: document.getElementById('theme-toggle'),
    modelsPathBtn: document.getElementById('models-path-btn'),
    settingsBtn: document.getElementById('settings-btn'),
    addNodeBtn: document.getElementById('add-node-btn'),
    restartRpcBtn: document.getElementById('restart-rpc-btn'),
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
    modelsPathModal: document.getElementById('models-path-modal'),
    currentModelsPath: document.getElementById('current-models-path'),
    newModelsPath: document.getElementById('new-models-path'),
    browseModelsPath: document.getElementById('browse-models-path'),
    saveModelsPath: document.getElementById('save-models-path'),
    resetModelsPath: document.getElementById('reset-models-path'),
    cancelModelsPath: document.getElementById('cancel-models-path'),
    closeModelsPathModal: document.querySelector('.close-models-path'),
    openModelsFolder: document.getElementById('open-models-folder'),
    systemLog: document.getElementById('system-log'),
    rpcLog: document.getElementById('rpc-log'),
    apiLog: document.getElementById('api-log'),
    tabBtns: document.querySelectorAll('.tab-btn'),
    // Auto Offload & Memory Limit
    idleTimeout: document.getElementById('idle-timeout'),
    idleTimeoutSlider: document.getElementById('idle-timeout-slider'),
    autoLoadToggle: document.getElementById('auto-load-toggle'),
    maxMemoryLimit: document.getElementById('max-memory-limit'),
    maxMemorySlider: document.getElementById('max-memory-slider'),
    rememberModelSettings: document.getElementById('remember-model-settings'),
    // Speculative Decoding
    specEnabled: document.getElementById('spec-enabled'),
    specOptions: document.getElementById('spec-options'),
    draftModelSelect: document.getElementById('draft-model-select'),
    draftGpuLayers: document.getElementById('draft-gpu-layers'),
    draftGpuSlider: document.getElementById('draft-gpu-slider'),
    draftMax: document.getElementById('draft-max'),
    draftMaxSlider: document.getElementById('draft-max-slider'),
    draftMin: document.getElementById('draft-min'),
    draftMinSlider: document.getElementById('draft-min-slider'),
    draftPMin: document.getElementById('draft-p-min'),
    draftPMinSlider: document.getElementById('draft-p-min-slider'),
    // llama.cpp 更新
    updateBtn: document.getElementById('update-btn'),
    inlineUpdateBtn: document.getElementById('inline-update-btn'),
    updateModal: document.getElementById('update-modal'),
    closeUpdateModal: document.querySelector('.close-update-modal'),
    updateCurrentVersion: document.getElementById('update-current-version'),
    updateLatestVersion: document.getElementById('update-latest-version'),
    updateVariantSelect: document.getElementById('update-variant-select'),
    updateProgressSection: document.getElementById('update-progress-section'),
    updateProgressBar: document.getElementById('update-progress-bar'),
    updateProgressText: document.getElementById('update-progress-text'),
    startUpdateBtn: document.getElementById('start-update-btn'),
    cancelUpdateBtn: document.getElementById('cancel-update-btn'),
    // HF 模型下載
    hfDownloadBtn: document.getElementById('hf-download-btn'),
    hfModal: document.getElementById('hf-modal'),
    closeHfModal: document.querySelector('.close-hf-modal'),
    hfRepoInput: document.getElementById('hf-repo-input'),
    hfSearchBtn: document.getElementById('hf-search-btn'),
    hfRepoInfo: document.getElementById('hf-repo-info'),
    hfRepoName: document.getElementById('hf-repo-name'),
    hfRepoDownloads: document.getElementById('hf-repo-downloads'),
    hfVariantsContainer: document.getElementById('hf-variants-container'),
    hfVariantsList: document.getElementById('hf-variants-list'),
    hfProgressSection: document.getElementById('hf-progress-section'),
    hfProgressBar: document.getElementById('hf-progress-bar'),
    hfProgressText: document.getElementById('hf-progress-text'),
    hfCurrentFile: document.getElementById('hf-current-file'),
    hfDownloadSelectedBtn: document.getElementById('hf-download-selected-btn'),
    hfCancelDownloadBtn: document.getElementById('hf-cancel-download-btn'),
    hfCloseBtn: document.getElementById('hf-close-btn'),
    // Loaded Model Info
    loadedModelInfo: document.getElementById('loaded-model-info'),
    loadedModelName: document.getElementById('loaded-model-name'),
    unloadModelBtn: document.getElementById('unload-model-btn'),
    // Advanced Settings additions
    restrictSingleModel: document.getElementById('restrict-single-model'),
    cudaDeviceId: document.getElementById('cuda-device-id'),
    cpuThreads: document.getElementById('cpu-threads'),
    threadsSlider: document.getElementById('threads-slider')
};

// ==================== 客製化選擇器元件 ====================

function createCustomSelect(selectId) {
    const select = document.getElementById(selectId);
    if (!select) return;
    
    // 隱藏原生 select
    select.style.display = 'none';
    
    // 移除已有的客製化容器，以防重複建立
    const existingContainer = select.parentNode.querySelector(`.custom-select-container[data-select="${selectId}"]`);
    if (existingContainer) {
        existingContainer.remove();
    }
    
    // 建立外層容器
    const container = document.createElement('div');
    container.className = 'custom-select-container';
    container.setAttribute('data-select', selectId);
    
    // 建立 Trigger
    const trigger = document.createElement('div');
    trigger.className = 'custom-select-trigger';
    
    const triggerText = document.createElement('span');
    triggerText.className = 'custom-select-text';
    
    const activeOption = select.options[select.selectedIndex];
    let triggerLabel = activeOption ? activeOption.textContent : '請選擇...';
    if (selectId === 'model-select' && activeOption && currentlyActiveModel && activeOption.value === currentlyActiveModel) {
        triggerLabel = `🟢 ${activeOption.textContent} (作用中)`;
    }
    triggerText.textContent = triggerLabel;
    
    const icon = document.createElement('i');
    icon.className = 'fas fa-chevron-down';
    
    trigger.appendChild(triggerText);
    trigger.appendChild(icon);
    container.appendChild(trigger);
    
    // 建立選項列表
    const optionsList = document.createElement('div');
    optionsList.className = 'custom-select-options';
    
    // 建立各個選項
    Array.from(select.options).forEach((opt, idx) => {
        const optionEl = document.createElement('div');
        optionEl.className = 'custom-select-option';
        if (opt.selected) optionEl.classList.add('selected');
        
        let labelText = opt.textContent;
        if (selectId === 'model-select' && currentlyActiveModel && opt.value === currentlyActiveModel) {
            optionEl.classList.add('active-running');
            labelText = `🟢 ${opt.textContent} (作用中)`;
        }
        
        optionEl.textContent = labelText;
        optionEl.setAttribute('data-value', opt.value);
        
        optionEl.addEventListener('click', (e) => {
            e.stopPropagation();
            
            // 更新選取狀態樣式
            optionsList.querySelectorAll('.custom-select-option').forEach(el => el.classList.remove('selected'));
            optionEl.classList.add('selected');
            
            // 更新 Trigger 顯示文字
            let selectedLabel = opt.textContent;
            if (selectId === 'model-select' && currentlyActiveModel && opt.value === currentlyActiveModel) {
                selectedLabel = `🟢 ${opt.textContent} (作用中)`;
            }
            triggerText.textContent = selectedLabel;
            
            // 關閉下拉選單
            container.classList.remove('open');
            
            // 更新原生 select 值並觸發 change 事件
            select.selectedIndex = idx;
            select.dispatchEvent(new Event('change'));
        });
        
        optionsList.appendChild(optionEl);
    });
    
    container.appendChild(optionsList);
    
    // Trigger 點擊開關
    trigger.addEventListener('click', (e) => {
        e.stopPropagation();
        
        // 關閉其他所有的客製化選擇器
        document.querySelectorAll('.custom-select-container').forEach(c => {
            if (c !== container) c.classList.remove('open');
        });
        
        container.classList.toggle('open');
    });
    
    // 插入到原生 select 的後面
    select.parentNode.insertBefore(container, select.nextSibling);
}

// 點擊頁面其他地方關閉下拉選單
document.addEventListener('click', () => {
    document.querySelectorAll('.custom-select-container').forEach(c => {
        c.classList.remove('open');
    });
});

// 初始化應用程式
async function initApp() {
    logMessage('系統', '應用程式啟動中...', 'info');
    
    // 初始化主題
    initTheme();
    
    // 初始化靜態下拉選單
    createCustomSelect('cache-type-k');
    createCustomSelect('cache-type-v');
    
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
        const modelsPath = await window.electronAPI.getModelsPath();
        elements.modelSelect.innerHTML = '';
        
        if (models.length === 0) {
            elements.modelSelect.innerHTML = '<option value="">請將 .gguf 模型檔案放入模型資料夾</option>';
            logMessage('系統', `未找到任何模型檔案，模型路徑: ${modelsPath}`, 'info');
        } else {
            elements.modelSelect.innerHTML = '<option value="">請選擇模型...</option>';
            elements.draftModelSelect.innerHTML = '<option value="">選擇 Draft Model...</option>';
            models.forEach(model => {
                const option = document.createElement('option');
                option.value = model;
                option.textContent = model;
                elements.modelSelect.appendChild(option);
                
                const draftOption = document.createElement('option');
                draftOption.value = model;
                draftOption.textContent = model;
                elements.draftModelSelect.appendChild(draftOption);
            });
            logMessage('系統', `找到 ${models.length} 個模型檔案，路徑: ${modelsPath}`, 'success');
        }
        createCustomSelect('model-select');
        createCustomSelect('draft-model-select');
    } catch (error) {
        logMessage('系統', `載入模型列表失敗: ${error.message}`, 'error');
    }
}

// 載入模型路徑設定
async function loadModelsPathSettings() {
    try {
        const currentPath = await window.electronAPI.getModelsPath();
        elements.currentModelsPath.value = currentPath;
        elements.newModelsPath.value = '';
    } catch (error) {
        logMessage('系統', `載入模型路徑設定失敗: ${error.message}`, 'error');
    }
}

// 瀏覽模型資料夾
async function browseModelsFolder() {
    try {
        const result = await window.electronAPI.browseModelsFolder();
        if (result.success) {
            elements.newModelsPath.value = result.path;
        } else {
            logMessage('系統', result.message, 'error');
        }
    } catch (error) {
        logMessage('系統', `瀏覽資料夾失敗: ${error.message}`, 'error');
    }
}

// 儲存模型路徑
async function saveModelsPath() {
    const newPath = elements.newModelsPath.value.trim();
    if (!newPath) {
        alert('請輸入或選擇新的模型路徑');
        return;
    }
    
    try {
        const result = await window.electronAPI.setModelsPath(newPath);
        if (result.success) {
            logMessage('系統', result.message, 'success');
            elements.modelsPathModal.style.display = 'none';
            // 重新載入模型列表
            await loadModels();
            await loadModelsPathSettings();
        } else {
            logMessage('系統', result.message, 'error');
        }
    } catch (error) {
        logMessage('系統', `儲存模型路徑失敗: ${error.message}`, 'error');
    }
}

// 重置模型路徑
async function resetModelsPath() {
    try {
        const result = await window.electronAPI.resetModelsPath();
        if (result.success) {
            logMessage('系統', result.message, 'success');
            elements.modelsPathModal.style.display = 'none';
            // 重新載入模型列表
            await loadModels();
            await loadModelsPathSettings();
        } else {
            logMessage('系統', result.message, 'error');
        }
    } catch (error) {
        logMessage('系統', `重置模型路徑失敗: ${error.message}`, 'error');
    }
}

// 開啟模型資料夾
async function openModelsFolder() {
    try {
        const result = await window.electronAPI.openModelsFolder();
        if (result.success) {
            logMessage('系統', result.message, 'success');
        } else {
            logMessage('系統', result.message, 'error');
        }
    } catch (error) {
        logMessage('系統', `開啟資料夾失敗: ${error.message}`, 'error');
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
    const version = await window.electronAPI.getCurrentLlamacppVersion();
    if (version === '未安裝') {
        alert('尚未安裝 llama.cpp 推理核心，請先下載安裝。');
        elements.updateBtn.click();
        return;
    }
    const modelName = elements.modelSelect.value;
    const ngl = parseInt(elements.gpuLayers.value) || 0;
    const np = parseInt(elements.parallelRequests.value) || 1;
    const ctxSize = parseInt(elements.contextSize.value) || 2048;
    const flashAttention = elements.flashAttention.checked;
    const cacheTypeK = elements.cacheTypeK.value;
    const cacheTypeV = elements.cacheTypeV.value;
    const apiKey = elements.apiKeyInput.value;
    const idleTimeout = parseInt(elements.idleTimeout.value) === 0 ? 0 : (parseInt(elements.idleTimeout.value) || 5);
    const autoLoadEnabled = elements.autoLoadToggle.checked;
    const maxMemoryLimit = parseInt(elements.maxMemoryLimit.value) || 0;
    const restrictSingleModel = elements.restrictSingleModel.checked;
    const cudaDeviceId = elements.cudaDeviceId.value || '';
    const cpuThreads = parseInt(elements.cpuThreads.value) || 0;
    
    // Speculative Decoding
    const specEnabled = elements.specEnabled.checked;
    const draftModel = elements.draftModelSelect.value;
    const draftNgl = parseInt(elements.draftGpuLayers.value) || 0;
    const draftMax = parseInt(elements.draftMax.value) || 16;
    const draftMin = parseInt(elements.draftMin.value) || 0;
    const draftPMin = parseFloat(elements.draftPMin.value) || 0.75;
    
    if (!modelName) {
        alert('請選擇一個主模型');
        return;
    }
    
    if (specEnabled && !draftModel) {
        alert('已啟用 Speculative Decoding，請選擇一個 Draft Model');
        return;
    }
    
    // 過濾掉本機IP，因為API伺服器會自動參與計算
    const rpcNodes = selectedNodes.filter(ip => ip !== '127.0.0.1');
    
    if (rpcNodes.length === 0) {
        const confirm = window.confirm('未選擇任何RPC節點，將僅使用本機進行推理。是否繼續？');
        if (!confirm) return;
    }
    
    // 啟動前若有勾選記住設定，則進行儲存
    saveIfRememberChecked();
    
    try {
        updateMainActionButton('loading');
        
        const result = await window.electronAPI.startApiServer({
            modelName,
            apiKey,
            rpcNodes: rpcNodes,
            ngl,
            np,
            ctxSize,
            flashAttention,
            cacheTypeK,
            cacheTypeV,
            specEnabled,
            draftModel,
            draftNgl,
            draftMax,
            draftMin,
            draftPMin,
            idleTimeout,
            autoLoadEnabled,
            maxMemoryLimit,
            restrictSingleModel,
            cudaDeviceId,
            cpuThreads
        });
        
        if (result.success) {
            logMessage('系統', result.message, 'success');
            logMessage('系統', `使用模型: ${modelName}`, 'info');
            logMessage('系統', `GPU 層數: ${ngl}`, 'info');
            logMessage('系統', `並行請求數: ${np}`, 'info');
            logMessage('系統', `Context Size: ${ctxSize}`, 'info');
            logMessage('系統', `Flash Attention: ${flashAttention ? '啟用' : '停用'}`, 'info');
            logMessage('系統', `KV Cache Type K: ${cacheTypeK}`, 'info');
            logMessage('系統', `KV Cache Type V: ${cacheTypeV}`, 'info');
            logMessage('系統', `RPC節點: ${rpcNodes.join(', ') || '無'}`, 'info');
            logMessage('系統', `自動卸載時間: ${idleTimeout === 0 ? '已停用' : idleTimeout + ' 分鐘'}`, 'info');
            logMessage('系統', `即時模型加載: ${autoLoadEnabled ? '啟用' : '停用'}`, 'info');
            logMessage('系統', `限制單一模型: ${restrictSingleModel ? '啟用' : '停用'}`, 'info');
            if (cudaDeviceId) logMessage('系統', `GPU 裝置: ${cudaDeviceId}`, 'info');
            if (cpuThreads > 0) logMessage('系統', `CPU 執行緒數: ${cpuThreads}`, 'info');
            logMessage('系統', `記憶體上限限制: ${maxMemoryLimit === 0 ? '無限制' : maxMemoryLimit + ' GB'}`, 'info');
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
// ==================== 模型專屬設定儲存/載入 ====================

function saveCurrentModelSettings() {
    const modelName = elements.modelSelect.value;
    if (!modelName) return;
    
    const isRememberChecked = elements.rememberModelSettings.checked;
    if (!isRememberChecked) {
        localStorage.removeItem(`model_settings_${modelName}`);
        return;
    }
    
    const settings = {
        ngl: parseInt(elements.gpuLayers.value) || 0,
        ctxSize: parseInt(elements.contextSize.value) || 2048,
        np: parseInt(elements.parallelRequests.value) || 1,
        flashAttention: elements.flashAttention.checked,
        cacheTypeK: elements.cacheTypeK.value,
        cacheTypeV: elements.cacheTypeV.value,
        specEnabled: elements.specEnabled.checked,
        draftModel: elements.draftModelSelect.value,
        draftNgl: parseInt(elements.draftGpuLayers.value) || 0,
        draftMax: parseInt(elements.draftMax.value) || 16,
        draftMin: parseInt(elements.draftMin.value) || 0,
        draftPMin: parseFloat(elements.draftPMin.value) || 0.75,
        idleTimeout: parseInt(elements.idleTimeout.value) === 0 ? 0 : (parseInt(elements.idleTimeout.value) || 5),
        maxMemoryLimit: parseInt(elements.maxMemoryLimit.value) || 0,
        restrictSingleModel: elements.restrictSingleModel.checked,
        cudaDeviceId: elements.cudaDeviceId.value || '',
        cpuThreads: parseInt(elements.cpuThreads.value) || 0,
        remember: true
    };
    
    localStorage.setItem(`model_settings_${modelName}`, JSON.stringify(settings));
    console.log(`Saved settings for model: ${modelName}`, settings);
}

function loadSettingsForModel(modelName) {
    if (!modelName) {
        elements.rememberModelSettings.checked = false;
        return;
    }
    
    const saved = localStorage.getItem(`model_settings_${modelName}`);
    if (!saved) {
        elements.rememberModelSettings.checked = false;
        // 重置為預設設定
        elements.restrictSingleModel.checked = false;
        elements.cudaDeviceId.value = '';
        elements.cpuThreads.value = 0;
        elements.threadsSlider.value = 0;
        return;
    }
    
    try {
        const settings = JSON.parse(saved);
        
        // 還原設定值到 UI
        if (settings.ngl !== undefined) {
            elements.gpuLayers.value = settings.ngl;
            elements.gpuSlider.value = Math.min(settings.ngl, 200);
        }
        if (settings.ctxSize !== undefined) {
            elements.contextSize.value = settings.ctxSize;
            elements.contextSlider.value = Math.min(settings.ctxSize, 131072);
        }
        if (settings.np !== undefined) {
            elements.parallelRequests.value = settings.np;
            elements.parallelSlider.value = Math.min(settings.np, 100);
        }
        if (settings.flashAttention !== undefined) {
            elements.flashAttention.checked = settings.flashAttention;
        }
        if (settings.cacheTypeK !== undefined) {
            elements.cacheTypeK.value = settings.cacheTypeK;
            createCustomSelect('cache-type-k');
        }
        if (settings.cacheTypeV !== undefined) {
            elements.cacheTypeV.value = settings.cacheTypeV;
            createCustomSelect('cache-type-v');
        }
        if (settings.specEnabled !== undefined) {
            elements.specEnabled.checked = settings.specEnabled;
            elements.specOptions.style.display = settings.specEnabled ? 'block' : 'none';
        }
        if (settings.draftModel !== undefined) {
            elements.draftModelSelect.value = settings.draftModel;
            createCustomSelect('draft-model-select');
        }
        if (settings.draftNgl !== undefined) {
            elements.draftGpuLayers.value = settings.draftNgl;
            elements.draftGpuSlider.value = Math.min(settings.draftNgl, 200);
        }
        if (settings.draftMax !== undefined) {
            elements.draftMax.value = settings.draftMax;
            elements.draftMaxSlider.value = Math.min(settings.draftMax, 64);
        }
        if (settings.draftMin !== undefined) {
            elements.draftMin.value = settings.draftMin;
            elements.draftMinSlider.value = Math.min(settings.draftMin, 32);
        }
        if (settings.draftPMin !== undefined) {
            elements.draftPMin.value = settings.draftPMin;
            elements.draftPMinSlider.value = Math.round(settings.draftPMin * 100);
        }
        if (settings.idleTimeout !== undefined) {
            elements.idleTimeout.value = settings.idleTimeout;
            elements.idleTimeoutSlider.value = Math.min(settings.idleTimeout, 60);
        }
        if (settings.maxMemoryLimit !== undefined) {
            elements.maxMemoryLimit.value = settings.maxMemoryLimit;
            elements.maxMemorySlider.value = Math.min(settings.maxMemoryLimit, 64);
        }
        if (settings.restrictSingleModel !== undefined) {
            elements.restrictSingleModel.checked = settings.restrictSingleModel;
        }
        if (settings.cudaDeviceId !== undefined) {
            elements.cudaDeviceId.value = settings.cudaDeviceId;
        }
        if (settings.cpuThreads !== undefined) {
            elements.cpuThreads.value = settings.cpuThreads;
            elements.threadsSlider.value = Math.min(settings.cpuThreads, 64);
        }
        
        elements.rememberModelSettings.checked = true;
        console.log(`Loaded settings for model: ${modelName}`, settings);
    } catch (e) {
        console.error(`Failed to parse saved settings for model: ${modelName}`, e);
        elements.rememberModelSettings.checked = false;
    }
}

function saveIfRememberChecked() {
    if (elements.rememberModelSettings && elements.rememberModelSettings.checked) {
        saveCurrentModelSettings();
    }
}

function syncGpuControls() {
    // GPU 層數控制
    elements.gpuSlider.addEventListener('input', (e) => {
        elements.gpuLayers.value = e.target.value;
        saveIfRememberChecked();
    });
    
    elements.gpuLayers.addEventListener('input', (e) => {
        const value = Math.max(0, parseInt(e.target.value) || 0);
        elements.gpuLayers.value = value;
        elements.gpuSlider.value = Math.min(value, 200); // 滑動條最大值限制為200，但輸入框無限制
        saveIfRememberChecked();
    });
    
    // 並行請求數控制
    elements.parallelSlider.addEventListener('input', (e) => {
        elements.parallelRequests.value = e.target.value;
        saveIfRememberChecked();
    });
    
    elements.parallelRequests.addEventListener('input', (e) => {
        const value = Math.max(1, parseInt(e.target.value) || 1);
        elements.parallelRequests.value = value;
        elements.parallelSlider.value = Math.min(value, 100); // 滑動條最大值限制為100，但輸入框無限制
        saveIfRememberChecked();
    });
    
    // Context Size 控制
    elements.contextSlider.addEventListener('input', (e) => {
        elements.contextSize.value = e.target.value;
        saveIfRememberChecked();
    });
    
    elements.contextSize.addEventListener('input', (e) => {
        const value = Math.max(512, parseInt(e.target.value) || 2048);
        // 確保值是512的倍數
        const roundedValue = Math.round(value / 512) * 512;
        elements.contextSize.value = roundedValue;
        elements.contextSlider.value = Math.min(roundedValue, 131072); // 滑動條最大值限制為128K，但輸入框無限制
        saveIfRememberChecked();
    });

    // 模型自動卸載時間控制
    const savedTimeout = localStorage.getItem('idleTimeout');
    if (savedTimeout !== null) {
        elements.idleTimeout.value = savedTimeout;
        elements.idleTimeoutSlider.value = Math.min(parseInt(savedTimeout) || 5, 60);
    } else {
        elements.idleTimeout.value = '5';
        elements.idleTimeoutSlider.value = 5;
    }

    elements.idleTimeoutSlider.addEventListener('input', (e) => {
        elements.idleTimeout.value = e.target.value;
        localStorage.setItem('idleTimeout', e.target.value);
        saveIfRememberChecked();
    });
    
    elements.idleTimeout.addEventListener('input', (e) => {
        const value = Math.max(0, parseInt(e.target.value) || 0);
        elements.idleTimeout.value = value;
        elements.idleTimeoutSlider.value = Math.min(value, 60);
        localStorage.setItem('idleTimeout', value.toString());
        saveIfRememberChecked();
    });

    // 記憶體上限限制控制
    const savedMaxMem = localStorage.getItem('maxMemoryLimit');
    if (savedMaxMem !== null) {
        elements.maxMemoryLimit.value = savedMaxMem;
        elements.maxMemorySlider.value = Math.min(parseInt(savedMaxMem) || 0, 64);
    } else {
        elements.maxMemoryLimit.value = '0';
        elements.maxMemorySlider.value = 0;
    }

    elements.maxMemorySlider.addEventListener('input', (e) => {
        elements.maxMemoryLimit.value = e.target.value;
        localStorage.setItem('maxMemoryLimit', e.target.value);
        saveIfRememberChecked();
    });

    elements.maxMemoryLimit.addEventListener('input', (e) => {
        const value = Math.max(0, parseInt(e.target.value) || 0);
        elements.maxMemoryLimit.value = value;
        elements.maxMemorySlider.value = Math.min(value, 64);
        localStorage.setItem('maxMemoryLimit', value.toString());
        saveIfRememberChecked();
    });

    // 即時加載控制
    const savedAutoLoad = localStorage.getItem('autoLoadEnabled');
    if (savedAutoLoad !== null) {
        elements.autoLoadToggle.checked = savedAutoLoad === 'true';
    } else {
        elements.autoLoadToggle.checked = true;
    }

    elements.autoLoadToggle.addEventListener('change', (e) => {
        localStorage.setItem('autoLoadEnabled', e.target.checked.toString());
    });
    
    // Speculative Decoding 開關
    elements.specEnabled.addEventListener('change', (e) => {
        elements.specOptions.style.display = e.target.checked ? 'block' : 'none';
        saveIfRememberChecked();
    });

    // Draft GPU 層數控制
    elements.draftGpuSlider.addEventListener('input', (e) => {
        elements.draftGpuLayers.value = e.target.value;
        saveIfRememberChecked();
    });
    elements.draftGpuLayers.addEventListener('input', (e) => {
        const value = Math.max(0, parseInt(e.target.value) || 0);
        elements.draftGpuLayers.value = value;
        elements.draftGpuSlider.value = Math.min(value, 200);
        saveIfRememberChecked();
    });

    // Draft Max 控制
    elements.draftMaxSlider.addEventListener('input', (e) => {
        elements.draftMax.value = e.target.value;
        saveIfRememberChecked();
    });
    elements.draftMax.addEventListener('input', (e) => {
        const value = Math.max(1, parseInt(e.target.value) || 16);
        elements.draftMax.value = value;
        elements.draftMaxSlider.value = Math.min(value, 64);
        saveIfRememberChecked();
    });

    // Draft Min 控制
    elements.draftMinSlider.addEventListener('input', (e) => {
        elements.draftMin.value = e.target.value;
        saveIfRememberChecked();
    });
    elements.draftMin.addEventListener('input', (e) => {
        const value = Math.max(0, parseInt(e.target.value) || 0);
        elements.draftMin.value = value;
        elements.draftMinSlider.value = Math.min(value, 32);
        saveIfRememberChecked();
    });

    // Draft P-Min 控制
    elements.draftPMinSlider.addEventListener('input', (e) => {
        elements.draftPMin.value = (e.target.value / 100).toFixed(2);
        saveIfRememberChecked();
    });
    elements.draftPMin.addEventListener('input', (e) => {
        let value = parseFloat(e.target.value) || 0.75;
        value = Math.max(0, Math.min(1, value));
        elements.draftPMin.value = value;
        elements.draftPMinSlider.value = Math.round(value * 100);
        saveIfRememberChecked();
    });

    elements.draftModelSelect.addEventListener('change', () => saveIfRememberChecked());

    // CPU 執行緒控制
    elements.threadsSlider.addEventListener('input', (e) => {
        elements.cpuThreads.value = e.target.value;
        saveIfRememberChecked();
    });
    elements.cpuThreads.addEventListener('input', (e) => {
        const value = Math.max(0, parseInt(e.target.value) || 0);
        elements.cpuThreads.value = value;
        elements.threadsSlider.value = Math.min(value, 64);
        saveIfRememberChecked();
    });

    // 限制單一模型與 GPU 裝置變更事件
    elements.restrictSingleModel.addEventListener('change', () => saveIfRememberChecked());
    elements.cudaDeviceId.addEventListener('input', () => saveIfRememberChecked());
}

// 設定進階設定摺疊功能
function setupAdvancedSettings() {
    elements.advancedSettingsToggle.addEventListener('click', () => {
        const header = elements.advancedSettingsToggle;
        const content = elements.advancedSettingsContent;
        
        header.classList.toggle('expanded');
        content.classList.toggle('expanded');
        
        if (content.classList.contains('expanded')) {
            logMessage('系統', '已展開進階設定', 'info');
        } else {
            logMessage('系統', '已收合進階設定', 'info');
        }
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

// 重啟 RPC server
async function restartRpcServer() {
    try {
        const version = await window.electronAPI.getCurrentLlamacppVersion();
        if (version === '未安裝') {
            alert('尚未安裝 llama.cpp 推理核心，請先下載安裝。');
            elements.updateBtn.click();
            return;
        }
        // 顯示正在重啟狀態
        elements.restartRpcBtn.disabled = true;
        elements.restartRpcBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> 重啟中...';
        
        const result = await window.electronAPI.restartRpcServer();
        
        if (result.success) {
            logMessage('系統', result.message, 'success');
        } else {
            logMessage('系統', result.message, 'error');
        }
    } catch (error) {
        logMessage('系統', `重啟 RPC server 失敗: ${error.message}`, 'error');
    } finally {
        // 恢復按鈕狀態
        elements.restartRpcBtn.disabled = false;
        elements.restartRpcBtn.innerHTML = '<i class="fas fa-redo"></i> 重啟 RPC 伺服器';
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
    
    // 強制重新計算並滾動到底部
    targetLog.scrollTop = targetLog.scrollHeight;
    
    // 使用 requestAnimationFrame 確保 DOM 更新完成後再滾動
    requestAnimationFrame(() => {
        targetLog.scrollTop = targetLog.scrollHeight;
    });
    
    // 限制日誌條目數量
    while (targetLog.children.length > 100) {
        targetLog.removeChild(targetLog.firstChild);
    }
}

// 設定事件監聽器
function setupEventListeners() {
    // 主操作按鈕
    elements.mainActionBtn.addEventListener('click', toggleApiServer);
    
    // 卸載模型按鈕
    elements.unloadModelBtn.addEventListener('click', async () => {
        if (!currentlyActiveModel) return;
        try {
            updateMainActionButton('loading');
            const result = await window.electronAPI.unloadModel();
            if (result.success) {
                logMessage('系統', result.message, 'success');
            } else {
                logMessage('系統', result.message, 'error');
            }
        } catch (error) {
            logMessage('系統', `卸載模型失敗: ${error.message}`, 'error');
        } finally {
            updateMainActionButton(apiServerRunning ? 'stop' : 'start');
        }
    });
    
    // 記住此模型的設定勾選變更
    elements.rememberModelSettings.addEventListener('change', () => {
        saveCurrentModelSettings();
    });

    // 模型選擇變更事件 (載入該模型的專屬設定)
    elements.modelSelect.addEventListener('change', (e) => {
        loadSettingsForModel(e.target.value);
    });
    
    // 主題切換按鈕
    elements.themeToggle.addEventListener('click', toggleTheme);
    
    // 模型路徑設定按鈕
    elements.modelsPathBtn.addEventListener('click', async () => {
        await loadModelsPathSettings();
        elements.modelsPathModal.style.display = 'block';
    });
    
    // 設定按鈕
    elements.settingsBtn.addEventListener('click', () => {
        elements.apiKeyModal.style.display = 'block';
    });
    
    // 重啟 RPC server 按鈕
    elements.restartRpcBtn.addEventListener('click', restartRpcServer);
    
    // 手動添加節點按鈕 (移除重複的事件監聽器)
    
    // GPU 控制同步
    syncGpuControls();
    
    // 進階設定摺疊功能
    setupAdvancedSettings();
    
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
    
    // 模型路徑設定模態框事件
    elements.browseModelsPath.addEventListener('click', browseModelsFolder);
    elements.saveModelsPath.addEventListener('click', saveModelsPath);
    elements.resetModelsPath.addEventListener('click', resetModelsPath);
    elements.openModelsFolder.addEventListener('click', openModelsFolder);
    elements.cancelModelsPath.addEventListener('click', () => {
        elements.modelsPathModal.style.display = 'none';
    });
    elements.closeModelsPathModal.addEventListener('click', () => {
        elements.modelsPathModal.style.display = 'none';
    });
    
    // Enter 鍵儲存模型路徑
    elements.newModelsPath.addEventListener('keypress', (e) => {
        if (e.key === 'Enter') {
            saveModelsPath();
        }
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
        if (event.target === elements.modelsPathModal) {
            elements.modelsPathModal.style.display = 'none';
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
            const activePanel = document.getElementById(`${tabName}-log`);
            activePanel.classList.add('active');
            
            // 切換標籤後自動滾動到底部
            setTimeout(() => {
                activePanel.scrollTop = activePanel.scrollHeight;
            }, 50);
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
    
    window.electronAPI.onApiServerStatus((event, status) => {
        let running = false;
        let statusMessage = '';
        let loadedModel = null;
        if (status && typeof status === 'object') {
            running = status.running;
            statusMessage = status.message || '';
            loadedModel = status.loadedModel || null;
        } else {
            running = !!status;
        }
        
        apiServerRunning = running;
        const apiStatusText = elements.apiStatus.nextElementSibling;
        updateStatusIndicator(elements.apiStatus, apiStatusText, running);
        
        if (running && statusMessage) {
            apiStatusText.textContent = statusMessage;
        }
        
        // 更新當前已載入模型 UI 狀態
        const prevActiveModel = currentlyActiveModel;
        if (running && loadedModel) {
            currentlyActiveModel = loadedModel;
            elements.loadedModelName.textContent = loadedModel;
            elements.loadedModelInfo.style.display = 'block';
        } else {
            currentlyActiveModel = null;
            elements.loadedModelInfo.style.display = 'none';
        }
        
        // 若載入的模型發生變化，重新建立選單以套用高亮樣式
        if (prevActiveModel !== currentlyActiveModel) {
            createCustomSelect('model-select');
        }
        
        if (running) {
            updateMainActionButton('stop');
            elements.apiUrl.textContent = 'http://localhost:8080';
            elements.apiUrl.style.cursor = 'pointer';
            elements.apiUrl.onclick = () => window.open('http://localhost:8080');
        } else {
            updateMainActionButton('start');
            elements.apiUrl.textContent = 'N/A';
            elements.apiUrl.style.cursor = 'default';
            elements.apiUrl.onclick = null;
            logMessage('API', 'API 伺服器已停止', 'info');
        }
    });
    
    window.electronAPI.onRpcServerLog((event, data) => {
        const lines = data.trim().split('\n');
        lines.forEach(line => {
            if (line.trim()) {
                logMessage('RPC', line.trim(), 'info');
            }
        });
    });
    
    window.electronAPI.onRpcServerError((event, data) => {
        const lines = data.trim().split('\n');
        lines.forEach(line => {
            if (line.trim()) {
                logMessage('RPC', line.trim(), 'error');
            }
        });
    });
    
    window.electronAPI.onApiServerLog((event, data) => {
        const lines = data.trim().split('\n');
        lines.forEach(line => {
            if (line.trim()) {
                logMessage('API', line.trim(), 'info');
            }
        });
    });
    
    window.electronAPI.onDownloadProgress((event, data) => {
        const { percent, message, currentFile, type } = data;
        
        if (type === 'llamacpp') {
            elements.updateProgressText.textContent = message;
            elements.updateProgressBar.style.width = `${percent}%`;
        } else if (type === 'hf') {
            elements.hfProgressText.textContent = message;
            elements.hfProgressBar.style.width = `${percent}%`;
            if (currentFile) {
                elements.hfCurrentFile.textContent = currentFile;
            }
        }
    });

    // ==================== llama.cpp 更新邏輯 ====================
    async function checkLlamacppVersion(onLaunch = false) {
        try {
            elements.llamacppVersion.textContent = '檢查中...';
            const result = await window.electronAPI.checkLlamacppUpdates();
            if (result.success) {
                elements.llamacppVersion.textContent = result.currentVersion;
                if (result.currentVersion === '未安裝') {
                    if (onLaunch) {
                        alert('尚未下載安裝 llama.cpp 推理核心，請點擊確定進行下載安裝。');
                        openUpdateModal();
                    }
                }
                if (result.hasUpdate) {
                    elements.llamacppVersion.innerHTML += ' <span style="color: #ef4444; font-size: 0.8em; margin-left: 5px;">(有更新)</span>';
                    if (elements.inlineUpdateBtn) {
                        elements.inlineUpdateBtn.className = 'btn btn-primary';
                        elements.inlineUpdateBtn.innerHTML = '<i class="fas fa-arrow-alt-circle-up"></i> 有新更新！';
                    }
                } else {
                    if (elements.inlineUpdateBtn) {
                        elements.inlineUpdateBtn.className = 'btn btn-secondary';
                        elements.inlineUpdateBtn.innerHTML = '<i class="fas fa-arrow-alt-circle-up"></i> 更新';
                    }
                }
            } else {
                elements.llamacppVersion.textContent = '檢查失敗';
            }
        } catch (error) {
            elements.llamacppVersion.textContent = '無法取得版本';
        }
    }

    const openUpdateModal = async () => {
        elements.updateModal.style.display = 'block';
        elements.updateCurrentVersion.textContent = '載入中...';
        elements.updateLatestVersion.textContent = '載入中...';
        elements.updateVariantSelect.innerHTML = '<option value="">載入中...</option>';
        createCustomSelect('update-variant-select');
        elements.updateProgressSection.style.display = 'none';
        elements.startUpdateBtn.disabled = true;

        try {
            const versionInfo = await window.electronAPI.checkLlamacppUpdates();
            if (versionInfo.success) {
                elements.updateCurrentVersion.textContent = versionInfo.currentVersion;
                elements.updateLatestVersion.textContent = versionInfo.latestVersion;
                
                const assetsInfo = await window.electronAPI.getLlamacppAssets();
                if (assetsInfo.success && assetsInfo.assets.length > 0) {
                    elements.updateVariantSelect.innerHTML = '';
                    assetsInfo.assets.forEach(asset => {
                        const option = document.createElement('option');
                        option.value = JSON.stringify({ url: asset.downloadUrl, name: asset.name, tag: versionInfo.latestVersion });
                        const sizeMb = (asset.size / (1024 * 1024)).toFixed(1);
                        option.textContent = `${asset.label} (${sizeMb} MB)`;
                        if (asset.isDefault) option.selected = true;
                        elements.updateVariantSelect.appendChild(option);
                    });
                    createCustomSelect('update-variant-select');
                    elements.startUpdateBtn.disabled = false;
                } else {
                    elements.updateVariantSelect.innerHTML = '<option value="">無可用更新</option>';
                    createCustomSelect('update-variant-select');
                }
            } else {
                elements.updateCurrentVersion.textContent = '錯誤';
                elements.updateLatestVersion.textContent = '錯誤';
            }
        } catch (error) {
            logMessage('系統', `更新檢查失敗: ${error.message}`, 'error');
        }
    };

    elements.updateBtn.addEventListener('click', openUpdateModal);
    if (elements.inlineUpdateBtn) {
        elements.inlineUpdateBtn.addEventListener('click', openUpdateModal);
    }

    elements.closeUpdateModal.addEventListener('click', () => { elements.updateModal.style.display = 'none'; });
    elements.cancelUpdateBtn.addEventListener('click', () => { elements.updateModal.style.display = 'none'; });

    elements.startUpdateBtn.addEventListener('click', async () => {
        const selectedValue = elements.updateVariantSelect.value;
        if (!selectedValue) return;

        const asset = JSON.parse(selectedValue);
        elements.updateProgressSection.style.display = 'block';
        elements.updateProgressText.textContent = '準備下載...';
        elements.updateProgressBar.style.width = '0%';
        elements.startUpdateBtn.disabled = true;
        elements.updateVariantSelect.disabled = true;

        try {
            const result = await window.electronAPI.downloadLlamacpp(asset.url, asset.name, asset.tag);
            if (result.success) {
                alert('更新成功！');
                checkLlamacppVersion();
                elements.updateModal.style.display = 'none';
            } else {
                alert(`更新失敗: ${result.message}`);
            }
        } catch (error) {
            alert(`更新發生錯誤: ${error.message}`);
        } finally {
            elements.startUpdateBtn.disabled = false;
            elements.updateVariantSelect.disabled = false;
        }
    });

    // ==================== Hugging Face 模型下載邏輯 ====================
    let currentHfVariants = [];

    elements.hfDownloadBtn.addEventListener('click', () => {
        elements.hfModal.style.display = 'block';
        elements.hfRepoInput.value = '';
        elements.hfRepoInfo.style.display = 'none';
        elements.hfVariantsContainer.style.display = 'none';
        elements.hfProgressSection.style.display = 'none';
        elements.hfDownloadSelectedBtn.style.display = 'none';
        elements.hfCancelDownloadBtn.style.display = 'none';
    });

    elements.closeHfModal.addEventListener('click', () => { elements.hfModal.style.display = 'none'; });
    elements.hfCloseBtn.addEventListener('click', () => { elements.hfModal.style.display = 'none'; });

    elements.hfRepoInput.addEventListener('keypress', (e) => {
        if (e.key === 'Enter') elements.hfSearchBtn.click();
    });

    elements.hfSearchBtn.addEventListener('click', async () => {
        const repoId = elements.hfRepoInput.value.trim();
        if (!repoId) return;

        elements.hfSearchBtn.disabled = true;
        elements.hfSearchBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> 搜尋中';
        elements.hfRepoInput.disabled = true;
        elements.hfRepoInfo.style.display = 'none';
        elements.hfVariantsContainer.style.display = 'none';

        try {
            const repoInfo = await window.electronAPI.searchHfRepo(repoId);
            if (!repoInfo.success) {
                alert(`找不到該倉庫或無權限存取：${repoId}`);
                return;
            }

            elements.hfRepoName.textContent = repoInfo.modelId;
            elements.hfRepoDownloads.innerHTML = `<i class="fas fa-download"></i> ${repoInfo.downloads.toLocaleString()}`;
            elements.hfRepoInfo.style.display = 'flex';

            const variantsResult = await window.electronAPI.listHfModels(repoId);
            if (variantsResult.success && variantsResult.variants.length > 0) {
                currentHfVariants = variantsResult.variants;
                renderHfVariants(variantsResult.variants);
                elements.hfVariantsContainer.style.display = 'block';
            } else {
                alert('該倉庫中沒有找到任何 GGUF 模型檔案。');
            }
        } catch (error) {
            alert(`搜尋發生錯誤: ${error.message}`);
        } finally {
            elements.hfSearchBtn.disabled = false;
            elements.hfSearchBtn.innerHTML = '<i class="fas fa-search"></i> 搜尋';
            elements.hfRepoInput.disabled = false;
            elements.hfRepoInput.focus();
        }
    });

    function renderHfVariants(variants) {
        elements.hfVariantsList.innerHTML = '';
        
        variants.forEach((variant, index) => {
            const sizeGb = (variant.totalSize / (1024 * 1024 * 1024)).toFixed(2);
            const variantDiv = document.createElement('div');
            variantDiv.className = 'hf-variant-item';
            
            const checkboxId = `variant-checkbox-${index}`;
            
            let shardInfo = '';
            if (variant.isSplit) {
                shardInfo = `<span class="variant-shards"><i class="fas fa-layer-group"></i> ${variant.shardCount} 個分片</span>`;
            }
            
            variantDiv.innerHTML = `
                <input type="checkbox" class="variant-checkbox" id="${checkboxId}" data-index="${index}">
                <div class="variant-info">
                    <label for="${checkboxId}" class="variant-name">${variant.variant}</label>
                    <div class="variant-meta">
                        <span class="variant-size">${sizeGb} GB</span>
                        ${shardInfo}
                    </div>
                </div>
            `;
            
            elements.hfVariantsList.appendChild(variantDiv);
        });

        // 監聽 Checkbox 變化，控制下載按鈕顯示
        const checkboxes = document.querySelectorAll('.variant-checkbox');
        checkboxes.forEach(cb => {
            cb.addEventListener('change', () => {
                const anyChecked = Array.from(checkboxes).some(c => c.checked);
                elements.hfDownloadSelectedBtn.style.display = anyChecked ? 'inline-flex' : 'none';
            });
        });
    }

    elements.hfDownloadSelectedBtn.addEventListener('click', async () => {
        const checkedBoxes = document.querySelectorAll('.variant-checkbox:checked');
        if (checkedBoxes.length === 0) return;

        const repoId = elements.hfRepoInput.value.trim();
        let filesToDownload = [];
        
        checkedBoxes.forEach(cb => {
            const index = cb.dataset.index;
            const variant = currentHfVariants[index];
            filesToDownload = filesToDownload.concat(variant.files.map(f => f.name));
        });

        elements.hfProgressSection.style.display = 'block';
        elements.hfProgressBar.style.width = '0%';
        elements.hfProgressText.textContent = '準備下載...';
        elements.hfCurrentFile.textContent = '';
        
        elements.hfDownloadSelectedBtn.style.display = 'none';
        elements.hfCancelDownloadBtn.style.display = 'inline-flex';
        
        // 禁用選項
        document.querySelectorAll('.variant-checkbox').forEach(cb => cb.disabled = true);
        elements.hfSearchBtn.disabled = true;

        try {
            const result = await window.electronAPI.downloadHfModel(repoId, filesToDownload);
            if (result.success) {
                alert(`下載完成！共下載 ${result.downloadedFiles.length} 個檔案。`);
                await loadModels(); // 重新載入模型列表
                elements.hfModal.style.display = 'none';
            } else if (result.message === '下載已取消') {
                alert('已取消下載。');
            } else {
                alert(`下載過程發生錯誤: ${result.message}`);
            }
        } catch (error) {
            alert(`下載失敗: ${error.message}`);
        } finally {
            elements.hfCancelDownloadBtn.style.display = 'none';
            document.querySelectorAll('.variant-checkbox').forEach(cb => cb.disabled = false);
            elements.hfSearchBtn.disabled = false;
            elements.hfProgressSection.style.display = 'none';
        }
    });

    elements.hfCancelDownloadBtn.addEventListener('click', async () => {
        await window.electronAPI.cancelHfDownload();
        elements.hfCancelDownloadBtn.disabled = true;
        elements.hfCancelDownloadBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> 取消中...';
    });

    // 啟動時檢查版本
    checkLlamacppVersion(true);
}

// 頁面載入完成後初始化
document.addEventListener('DOMContentLoaded', initApp);