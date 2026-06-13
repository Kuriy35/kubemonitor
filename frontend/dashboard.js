let activeNamespace = "all";
let currentData = null;
const expandedPods = new Set();
let filterSecurityIssuesOnly = false;
let activeEventFilter = 'all';
let lastPodStatuses = {};
let podsChart = null;

let sparklinePods = null;
let sparklineRunning = null;
let sparklineRestarts = null;

const podsHistory = [];
const runningHistory = [];
const restartsHistory = [];

function updateSparkline(canvasId, history, color, fillGradStart, fillGradStop) {
    const canvas = document.getElementById(canvasId);
    if (!canvas) return null;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;

    let chartInstance = Chart.getChart(canvas);
    if (chartInstance) {
        chartInstance.data.labels = history.map((_, i) => i);
        chartInstance.data.datasets[0].data = history;
        chartInstance.update('none');
        return chartInstance;
    }

    const gradient = ctx.createLinearGradient(0, 0, 0, 35);
    gradient.addColorStop(0, fillGradStart);
    gradient.addColorStop(1, fillGradStop);

    return new Chart(canvas, {
        type: 'line',
        data: {
            labels: history.map((_, i) => i),
            datasets: [{
                data: history,
                borderColor: color,
                borderWidth: 1.5,
                fill: true,
                backgroundColor: gradient,
                tension: 0.4,
                pointRadius: 0,
                pointHoverRadius: 3
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                legend: { display: false },
                tooltip: {
                    enabled: true,
                    intersect: false,
                    callbacks: {
                        label: function(context) {
                            return context.parsed.y;
                        }
                    }
                }
            },
            scales: {
                x: { display: false },
                y: { display: false }
            }
        }
    });
}

// Pagination state for all tables
window.paginationState = {
    nodes: { currentPage: 1, pageSize: 10 },
    pods: { currentPage: 1, pageSize: 10 },
    deployments: { currentPage: 1, pageSize: 10 },
    services: { currentPage: 1, pageSize: 10 },
    events: { currentPage: 1, pageSize: 10 },
    trivy: { currentPage: 1, pageSize: 10 },
    nodePods: { currentPage: 1, pageSize: 10 }
};

window.changePageSize = function(tableKey, size) {
    window.paginationState[tableKey].pageSize = parseInt(size, 10);
    window.paginationState[tableKey].currentPage = 1;
    if (tableKey === 'trivy') {
        window.filterTrivyTable();
    } else if (tableKey === 'events') {
        window.renderEventsTable();
    } else if (tableKey === 'nodePods') {
        window.renderNodePodsTable();
    } else {
        window.renderUI();
    }
};

window.changePage = function(tableKey, delta) {
    window.paginationState[tableKey].currentPage += delta;
    if (tableKey === 'trivy') {
        window.filterTrivyTable();
    } else if (tableKey === 'events') {
        window.renderEventsTable();
    } else if (tableKey === 'nodePods') {
        window.renderNodePodsTable();
    } else {
        window.renderUI();
    }
};

function renderPaginationHTML(tableKey, totalItems) {
    const state = window.paginationState[tableKey];
    const totalPages = Math.max(1, Math.ceil(totalItems / state.pageSize));
    if (state.currentPage > totalPages) {
        state.currentPage = totalPages;
    }
    
    return `
        <div class="pagination-controls" style="display: flex; justify-content: space-between; align-items: center; margin-top: 1rem; flex-wrap: wrap; gap: 0.75rem; font-size: 0.85rem; padding: 0.5rem 0; border-top: 1px solid rgba(255,255,255,0.03);">
            <div style="display: flex; align-items: center; gap: 0.5rem;">
                <span style="color: var(--text-muted);">Show:</span>
                <select onchange="window.changePageSize('${tableKey}', this.value)" style="background: rgba(0,0,0,0.3); border: 1px solid var(--card-border); color: var(--text-main); padding: 0.3rem 0.6rem; border-radius: 6px; outline: none; cursor: pointer;">
                    <option value="5" ${state.pageSize === 5 ? 'selected' : ''}>5</option>
                    <option value="10" ${state.pageSize === 10 ? 'selected' : ''}>10</option>
                    <option value="25" ${state.pageSize === 25 ? 'selected' : ''}>25</option>
                    <option value="50" ${state.pageSize === 50 ? 'selected' : ''}>50</option>
                    <option value="100" ${state.pageSize === 100 ? 'selected' : ''}>100</option>
                </select>
                <span style="color: var(--text-muted);">entries (total: ${totalItems})</span>
            </div>
            <div style="display: flex; align-items: center; gap: 0.6rem;">
                <button onclick="window.changePage('${tableKey}', -1)" ${state.currentPage <= 1 ? 'disabled style="opacity: 0.5; cursor: not-allowed;"' : ''} class="action-btn" style="padding: 0.3rem 0.75rem; width: auto; font-weight: 500;">
                    <i class="fa-solid fa-angle-left"></i> Prev
                </button>
                <span style="color: var(--text-muted); min-width: 100px; text-align: center;">
                    Page <strong style="color: var(--text-main);">${state.currentPage}</strong> of <strong style="color: var(--text-main);">${totalPages}</strong>
                </span>
                <button onclick="window.changePage('${tableKey}', 1)" ${state.currentPage >= totalPages ? 'disabled style="opacity: 0.5; cursor: not-allowed;"' : ''} class="action-btn" style="padding: 0.3rem 0.75rem; width: auto; font-weight: 500;">
                    Next <i class="fa-solid fa-angle-right"></i>
                </button>
            </div>
        </div>
    `;
}


function showToast(type, message, onClickAction = null) {
    const container = document.getElementById('toast-container');
    if (!container) return;
    
    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    if (onClickAction) {
        toast.style.cursor = 'pointer';
    }
    
    let iconClass = 'fa-info-circle';
    if (type === 'success') iconClass = 'fa-circle-check';
    else if (type === 'error') iconClass = 'fa-circle-exclamation';
    else if (type === 'warning') iconClass = 'fa-triangle-exclamation';
    
    toast.innerHTML = `
        <div class="toast-content">
            <i class="fa-solid ${iconClass} toast-icon"></i>
            <span class="toast-message">${message}</span>
        </div>
        <button class="toast-close" style="z-index: 10;">&times;</button>
    `;
    
    container.appendChild(toast);
    
    const closeBtn = toast.querySelector('.toast-close');
    closeBtn.onclick = (e) => {
        e.stopPropagation();
        toast.remove();
    };
    
    if (onClickAction) {
        toast.onclick = (e) => {
            if (e.target !== closeBtn) {
                onClickAction();
            }
        };
    }
    
    setTimeout(() => {
        if (toast.parentNode) {
            toast.remove();
        }
    }, 5000);
}

function checkPodStatusChanges(pods) {
    pods.forEach(pod => {
        const prevStatus = lastPodStatuses[pod.name];
        if (prevStatus && prevStatus !== pod.status) {
            let toastType = 'info';
            let msg = `Pod ${pod.name} changed state to ${pod.status}`;
            
            if (pod.status === 'Running') {
                toastType = 'success';
                msg = `Pod ${pod.name} is now Running`;
            } else if (pod.status === 'Pending') {
                toastType = 'warning';
                msg = `Pod ${pod.name} is Pending`;
            } else if (['Failed', 'CrashLoopBackOff', 'Error'].includes(pod.status)) {
                toastType = 'error';
                msg = `Pod ${pod.name} failed (${pod.status})`;
            }
            
            const onClickAction = () => {
                const nsSelect = document.getElementById('namespace-select');
                if (nsSelect) {
                    nsSelect.value = pod.namespace;
                    activeNamespace = pod.namespace;
                }
                switchTab('pods-tab');
                window.paginationState.pods.currentPage = 1;
                renderUI();
                
                setTimeout(() => {
                    if (!expandedPods.has(pod.name)) {
                        togglePodExpand(pod.name);
                    }
                    const row = document.getElementById(`pod-row-${pod.name}`);
                    if (row) {
                        row.scrollIntoView({ behavior: 'smooth', block: 'center' });
                        row.style.outline = '2px solid var(--primary)';
                        setTimeout(() => {
                            row.style.outline = 'none';
                        }, 2000);
                    }
                }, 100);
            };
            
            showToast(toastType, msg, onClickAction);
        }
        lastPodStatuses[pod.name] = pod.status;
    });
}

function initChart(running = 0, pending = 0, failed = 0) {
    const ctx = document.getElementById('podsChart');
    if (!ctx) return;
    
    const legRunning = document.getElementById('legend-running');
    const legPending = document.getElementById('legend-pending');
    const legFailed = document.getElementById('legend-failed');
    if (legRunning) legRunning.textContent = running;
    if (legPending) legPending.textContent = pending;
    if (legFailed) legFailed.textContent = failed;
    
    if (podsChart) {
        const oldData = podsChart.data.datasets[0].data;
        if (oldData[0] === running && oldData[1] === pending && oldData[2] === failed) {
            return;
        }
        podsChart.data.datasets[0].data = [running, pending, failed];
        podsChart.update();
        return;
    }
    
    podsChart = new Chart(ctx, {
        type: 'doughnut',
        data: {
            labels: ['Running', 'Pending', 'Failed'],
            datasets: [{
                data: [running, pending, failed],
                backgroundColor: ['#10b981', '#f59e0b', '#f43f5e'],
                borderWidth: 0
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            cutout: '75%',
            animation: {
                duration: 500
            },
            plugins: {
                legend: {
                    display: false
                }
            }
        }
    });
}

function switchTab(tabId) {
    document.querySelectorAll('.tab-btn').forEach(btn => btn.classList.remove('active'));
    document.querySelectorAll('.tab-content').forEach(content => content.classList.remove('active'));
    
    const btn = document.getElementById(`btn-${tabId}`);
    if (btn) btn.classList.add('active');
    
    const pane = document.getElementById(tabId);
    if (pane) pane.classList.add('active');
}

async function loadNamespaces() {
    try {
        const res = await fetch('/api/namespaces');
        const nsList = await res.json();
        const select = document.getElementById('namespace-select');
        if (!select) return;
        
        select.innerHTML = '<option value="all">All Namespaces</option>';
        nsList.forEach(ns => {
            select.innerHTML += `<option value="${ns}">${ns}</option>`;
        });
        select.value = activeNamespace;
    } catch (e) {}
}

function toggleSecurityFilter() {
    filterSecurityIssuesOnly = !filterSecurityIssuesOnly;
    window.paginationState.pods.currentPage = 1;
    const card = document.getElementById('security-score-card');
    if (card) {
        if (filterSecurityIssuesOnly) {
            card.classList.add('active');
        } else {
            card.classList.remove('active');
        }
    }
    renderUI();
}

function filterEvents(type) {
    activeEventFilter = type;
    window.paginationState.events.currentPage = 1;
    document.querySelectorAll('.filter-chip').forEach(btn => btn.classList.remove('active'));
    
    const activeBtn = document.getElementById(`event-filter-${type.toLowerCase()}`);
    if (activeBtn) activeBtn.classList.add('active');
    
    renderEventsTable();
}

function closeWelcomeBanner() {
    const banner = document.getElementById('welcome-banner');
    if (banner) banner.classList.add('hidden');
}

function initWelcomeBanner() {
    const banner = document.getElementById('welcome-banner');
    if (!banner) return;
    
    const visited = localStorage.getItem('kubemonitor_visited');
    if (!visited) {
        banner.classList.remove('hidden');
        localStorage.setItem('kubemonitor_visited', 'true');
        
        setTimeout(() => {
            closeWelcomeBanner();
        }, 5000);
    }
}

function togglePodExpand(podName) {
    if (expandedPods.has(podName)) {
        expandedPods.delete(podName);
    } else {
        expandedPods.add(podName);
    }
    renderUI();
}

let currentLogNamespace = '';
let currentLogPodName = '';
let rawLogData = '';

async function showLogs(namespace, podName) {
    currentLogNamespace = namespace;
    currentLogPodName = podName;
    
    const modal = document.getElementById('log-modal');
    const podNameSpan = document.getElementById('log-pod-name');
    const logContainer = document.getElementById('log-container');
    const searchInput = document.getElementById('log-search-input');
    const searchCount = document.getElementById('log-search-count');
    
    if (podNameSpan) podNameSpan.textContent = podName;
    if (logContainer) logContainer.textContent = "Loading logs...";
    if (searchInput) searchInput.value = '';
    if (searchCount) searchCount.textContent = '';
    if (modal) modal.classList.add('active');
    
    await reloadLogs();
}

async function reloadLogs() {
    const logContainer = document.getElementById('log-container');
    if (!logContainer) return;
    
    const linesSelect = document.getElementById('log-lines-select');
    const lines = linesSelect ? linesSelect.value : 100;
    
    try {
        const res = await fetch(`/api/logs/${currentLogNamespace}/${currentLogPodName}?lines=${lines}`);
        const data = await res.json();
        rawLogData = data.logs || '';
        
        displayLogs(rawLogData);
    } catch (err) {
        logContainer.textContent = "Failed to load logs: " + err;
    }
}

function displayLogs(logsText) {
    const logContainer = document.getElementById('log-container');
    if (!logContainer) return;
    
    if (!logsText.trim()) {
        logContainer.innerHTML = '<span style="color: var(--text-muted);">No logs available or container has not started yet.</span>';
        return;
    }
    
    const lines = logsText.split('\n');
    const formattedLines = lines.map(line => {
        if (!line.trim()) return '';
        
        let formattedLine = escapeHTML(line);
        
        formattedLine = formattedLine.replace(/^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[^\s]*)/g, '<span style="color: var(--text-muted); font-size: 0.8rem;">$1</span>');
        
        if (formattedLine.includes('ERROR') || formattedLine.includes('Error') || formattedLine.includes('Fail') || formattedLine.includes('failed')) {
            formattedLine = `<span style="color: #ff7b72;">${formattedLine}</span>`;
        } else if (formattedLine.includes('WARN') || formattedLine.includes('Warning') || formattedLine.includes('warning')) {
            formattedLine = `<span style="color: #d29922;">${formattedLine}</span>`;
        } else if (formattedLine.includes('SUCCESS') || formattedLine.includes('success') || formattedLine.includes('Successfully')) {
            formattedLine = `<span style="color: #3fb950;">${formattedLine}</span>`;
        }
        
        return `<div class="log-line">${formattedLine}</div>`;
    }).join('');
    
    logContainer.innerHTML = formattedLines;
    
    const autoscrollCheck = document.getElementById('log-autoscroll-check');
    if (autoscrollCheck && autoscrollCheck.checked) {
        logContainer.scrollTop = logContainer.scrollHeight;
    }
    
    filterLogLines();
}

function escapeHTML(str) {
    return str.replace(/[&<>'"]/g, 
        tag => ({
            '&': '&amp;',
            '<': '&lt;',
            '>': '&gt;',
            "'": '&#39;',
            '"': '&quot;'
        }[tag] || tag)
    );
}

function filterLogLines() {
    const searchInput = document.getElementById('log-search-input');
    const searchCount = document.getElementById('log-search-count');
    const logContainer = document.getElementById('log-container');
    if (!searchInput || !logContainer) return;
    
    const query = searchInput.value.toLowerCase().trim();
    const lines = logContainer.querySelectorAll('.log-line');
    
    if (!query) {
        lines.forEach(l => {
            l.style.display = '';
            l.innerHTML = l.innerHTML.replace(/<mark style="background: rgba\(255,215,0,0.4\); color: white; border-radius: 2px;">(.*?)<\/mark>/gi, '$1');
        });
        if (searchCount) searchCount.textContent = '';
        return;
    }
    
    let matchCount = 0;
    lines.forEach(l => {
        const text = l.innerText.toLowerCase();
        if (text.includes(query)) {
            l.style.display = '';
            matchCount++;
            
            const escapedQuery = query.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&');
            const regex = new RegExp(`(${escapedQuery})`, 'gi');
            
            l.innerHTML = l.innerHTML.replace(/<mark style="background: rgba\(255,215,0,0.4\); color: white; border-radius: 2px;">(.*?)<\/mark>/gi, '$1');
            l.innerHTML = l.innerHTML.replace(regex, '<mark style="background: rgba(255,215,0,0.4); color: white; border-radius: 2px;">$1</mark>');
        } else {
            l.style.display = 'none';
        }
    });
    
    if (searchCount) {
        searchCount.textContent = `Found: ${matchCount}`;
    }
}

function copyLogsToClipboard() {
    if (!rawLogData) return;
    navigator.clipboard.writeText(rawLogData)
        .then(() => showToast('success', 'Logs copied to clipboard!'))
        .catch(err => showToast('error', 'Copy failed: ' + err));
}

function downloadLogs() {
    if (!rawLogData) return;
    const blob = new Blob([rawLogData], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${currentLogPodName}_logs.txt`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    showToast('success', 'Log download started');
}

function closeLogModal() {
    const modal = document.getElementById('log-modal');
    if (modal) modal.classList.remove('active');
}

let currentDetailResource = null;
let lastFetchedDetails = null;
let trivyScanResults = {};

function calculateAge(timestamp) {
    if (!timestamp) return 'N/A';
    const created = new Date(timestamp);
    const diff = new Date() - created;
    const minutes = Math.floor(diff / 60000);
    const hours = Math.floor(minutes / 60);
    const days = Math.floor(hours / 24);
    
    if (days > 0) return `${days}d`;
    if (hours > 0) return `${hours}h`;
    return `${minutes}m`;
}

function formatCreationTimestamp(timestamp) {
    if (!timestamp) return 'N/A';
    const d = new Date(timestamp);
    const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    const pad = (n) => n.toString().padStart(2, '0');
    return `${d.getDate()} ${months[d.getMonth()]} ${d.getFullYear()}, ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

async function navigateToDetails(type, namespace, name, isPopState = false) {
    currentDetailResource = { type, namespace, name };
    
    if (!isPopState) {
        if (type === 'node') {
            history.pushState(null, '', `/node/${name}`);
        } else {
            history.pushState(null, '', `/${type}/${namespace}/${name}`);
        }
    }
    
    const mainScreen = document.querySelector('main');
    const detailView = document.getElementById('detail-view');
    const headerControls = document.querySelector('.header-controls');
    
    if (mainScreen) mainScreen.classList.add('hidden');
    if (headerControls) headerControls.classList.add('hidden');
    
    if (detailView) {
        detailView.classList.remove('hidden');
        detailView.innerHTML = `
            <div style="display: flex; align-items: center; gap: 0.5rem; color: var(--text-muted); padding: 2rem;">
                <i class="fa-solid fa-circle-notch fa-spin"></i> Loading details...
            </div>
        `;
    }
    
    try {
        const url = type === 'node' ? `/api/nodes/${name}` : `/api/details/${type}/${namespace}/${name}`;
        const res = await fetch(url);
        const data = await res.json();
        
        if (data.error) {
            if (detailView) {
                detailView.innerHTML = `
                    <div class="detail-header">
                        <button class="detail-back-btn" onclick="goBackToDashboard()">
                            <i class="fa-solid fa-arrow-left"></i> Back to list
                        </button>
                    </div>
                    <div class="diagnostic-box" style="margin-top: 1.5rem;">
                        <div class="diagnostic-title"><i class="fa-solid fa-circle-xmark"></i> Error</div>
                        <div class="diagnostic-text">${data.error}</div>
                    </div>
                `;
            }
            return;
        }
        
        if (type === 'node') {
            try {
                const mRes = await fetch(`/api/nodes/${name}/metrics`);
                const mData = await mRes.json();
                data.metrics = mData;
            } catch (me) {
                data.metrics = { cpu_usage_pct: 0, ram_usage_pct: 0, cpu_usage_m: 0, ram_usage_mib: 0 };
            }
        }
        
        renderDetailsPage(type, namespace, name, data);
    } catch (err) {
        if (detailView) {
            detailView.innerHTML = `
                <div class="detail-header">
                    <button class="detail-back-btn" onclick="goBackToDashboard()">
                        <i class="fa-solid fa-arrow-left"></i> Back to list
                    </button>
                </div>
                <div class="diagnostic-box" style="margin-top: 1.5rem;">
                    <div class="diagnostic-title"><i class="fa-solid fa-circle-xmark"></i> Connection Error</div>
                    <div class="diagnostic-text">${err}</div>
                </div>
            `;
        }
    }
}

function goBackToDashboard(isPopState = false) {
    currentDetailResource = null;
    lastFetchedDetails = null;
    
    if (!isPopState) {
        history.pushState(null, '', '/');
    }
    
    const mainScreen = document.querySelector('main');
    const detailView = document.getElementById('detail-view');
    const headerControls = document.querySelector('.header-controls');
    
    if (mainScreen) mainScreen.classList.remove('hidden');
    if (detailView) detailView.classList.add('hidden');
    if (headerControls) headerControls.classList.remove('hidden');
    
    renderUI();
}

let confirmActionCallback = null;

function showConfirmModal(message, actionCallback) {
    const modal = document.getElementById('confirm-modal');
    const msgEl = document.getElementById('confirm-message');
    const confirmBtn = document.getElementById('confirm-btn');
    
    if (msgEl) msgEl.textContent = message;
    confirmActionCallback = actionCallback;
    
    if (modal) modal.classList.add('active');
    
    if (confirmBtn) {
        confirmBtn.onclick = () => {
            if (confirmActionCallback) {
                confirmActionCallback();
            }
            closeConfirmModal();
        };
    }
}

function closeConfirmModal() {
    const modal = document.getElementById('confirm-modal');
    if (modal) modal.classList.remove('active');
    confirmActionCallback = null;
}

function triggerDeletePod(namespace, name) {
    showConfirmModal(`Are you sure you want to delete pod "${name}" in namespace "${namespace}"? This may cause a temporary service disruption.`, async () => {
        try {
            const res = await fetch(`/api/pods/${namespace}/${name}`, { method: 'DELETE' });
            const result = await res.json();
            if (result.status === 'success') {
                showToast('success', `Pod ${name} deleted successfully`);
                goBackToDashboard();
            } else {
                showToast('error', `Delete failed: ${result.message}`);
            }
        } catch (err) {
            showToast('error', `Network error: ${err}`);
        }
    });
}

function triggerRestartPod(namespace, name) {
    showConfirmModal(`Are you sure you want to restart pod "${name}" in namespace "${namespace}"? The pod will be deleted and Kubernetes will recreate it automatically.`, async () => {
        try {
            const res = await fetch(`/api/pods/${namespace}/${name}`, { method: 'DELETE' });
            const result = await res.json();
            if (result.status === 'success') {
                showToast('success', `Restart request sent for pod ${name}`);
                goBackToDashboard();
            } else {
                showToast('error', `Restart failed: ${result.message}`);
            }
        } catch (err) {
            showToast('error', `Network error: ${err}`);
        }
    });
}

async function triggerScaleDeployment(namespace, name, replicas) {
    if (replicas < 0) return;
    try {
        const res = await fetch(`/api/deployments/${namespace}/${name}/scale`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ replicas })
        });
        const result = await res.json();
        if (result.status === 'success') {
            showToast('success', `Deployment ${name} scaled to ${replicas} replicas`);
            navigateToDetails('deployment', namespace, name);
        } else {
            showToast('error', `Scale failed: ${result.message}`);
        }
    } catch (err) {
        showToast('error', `Network error: ${err}`);
    }
}

function triggerRestartDeployment(namespace, name) {
    showConfirmModal(`Are you sure you want to trigger a Rolling Restart for deployment "${name}" in namespace "${namespace}"? All pods will be restarted sequentially with no downtime.`, async () => {
        try {
            const res = await fetch(`/api/deployments/${namespace}/${name}/restart`, { method: 'POST' });
            const result = await res.json();
            if (result.status === 'success') {
                showToast('success', `Rolling Restart for ${name} started successfully`);
                navigateToDetails('deployment', namespace, name);
            } else {
                showToast('error', `Restart failed: ${result.message}`);
            }
        } catch (err) {
            showToast('error', `Network error: ${err}`);
        }
    });
}

async function runTrivyScan(imageName) {
    const box = document.getElementById('trivy-scan-box');
    if (!box) return;
    
    box.innerHTML = `
        <div style="display: flex; flex-direction: column; align-items: center; gap: 0.75rem; padding: 1rem; text-align: center;">
            <i class="fa-solid fa-circle-notch fa-spin" style="font-size: 1.5rem; color: var(--primary);"></i>
            <span style="font-size: 0.9rem; color: var(--text-main);">Running Trivy security scan...</span>
            <span style="font-size: 0.75rem; color: var(--text-muted);">This may take 1-2 minutes on the first scan.</span>
        </div>
    `;
    
    try {
        const res = await fetch('/api/scan/trivy', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ image: imageName })
        });
        const data = await res.json();
        
        if (data.error) {
            box.innerHTML = `
                <div class="diagnostic-box" style="margin-top: 0; width: 100%;">
                    <div class="diagnostic-title"><i class="fa-solid fa-circle-exclamation"></i> Scan Error</div>
                    <div class="diagnostic-text">${data.message || 'Unknown Trivy error'}</div>
                </div>
                <button class="action-btn" style="width: auto; margin-top: 0.5rem; background: var(--primary); color: #0d111a; border: none; padding: 0.5rem 1rem;" onclick="runTrivyScan('${imageName}')">
                    <i class="fa-solid fa-rotate-right"></i> Retry
                </button>
            `;
            return;
        }
        
        trivyScanResults[imageName] = data;
        box.innerHTML = renderTrivyScanHTML(data);
    } catch (err) {
        box.innerHTML = `
            <div class="diagnostic-box" style="margin-top: 0; width: 100%;">
                <div class="diagnostic-title"><i class="fa-solid fa-circle-exclamation"></i> Network Error</div>
                <div class="diagnostic-text">${err}</div>
            </div>
            <button class="action-btn" style="width: auto; margin-top: 0.5rem; background: var(--primary); color: #0d111a; border: none; padding: 0.5rem 1rem;" onclick="runTrivyScan('${imageName}')">
                <i class="fa-solid fa-rotate-right"></i> Retry
            </button>
        `;
    }
}

function renderTrivyScanHTML(data) {
    window.currentTrivyData = data;
    window.currentTrivyFilter = 'all';
    window.paginationState.trivy.currentPage = 1;

    const counts = data.counts || { CRITICAL: 0, HIGH: 0, MEDIUM: 0, LOW: 0 };
    const total = counts.CRITICAL + counts.HIGH + counts.MEDIUM + counts.LOW;
    
    let vulnsHtml = '';
    if (data.vulnerabilities && data.vulnerabilities.length > 0) {
        vulnsHtml = `
            <div style="display: flex; gap: 0.75rem; align-items: center; margin-top: 1rem; flex-wrap: wrap; margin-bottom: 0.75rem;">
                <div style="flex: 1; min-width: 250px;">
                    <input type="text" id="trivy-search" placeholder="Search by CVE or package name..." oninput="filterTrivyTable()" style="width: 100%; padding: 0.5rem 0.75rem; border: 1px solid var(--card-border); border-radius: 6px; background: rgba(0,0,0,0.25); color: var(--text-main); font-size: 0.85rem; outline: none; transition: border-color 0.2s;" onfocus="this.style.borderColor='var(--primary)'" onblur="this.style.borderColor='var(--card-border)'" />
                </div>
                <div style="display: flex; gap: 0.4rem; flex-wrap: wrap;">
                    <button class="trivy-filter-btn active" id="filter-all" onclick="setTrivyFilter('all')" style="padding: 0.5rem 1rem; border: 1px solid var(--card-border); border-radius: 6px; background: rgba(255,255,255,0.12); color: var(--text-main); cursor: pointer; font-size: 0.8rem; font-weight: 600; transition: all 0.2s;">All</button>
                    <button class="trivy-filter-btn" id="filter-critical" onclick="setTrivyFilter('critical')" style="padding: 0.5rem 1rem; border: 1px solid rgba(244, 63, 94, 0.3); border-radius: 6px; background: rgba(244, 63, 94, 0.05); color: #ff7b72; cursor: pointer; font-size: 0.8rem; font-weight: 500; transition: all 0.2s;">Critical</button>
                    <button class="trivy-filter-btn" id="filter-high" onclick="setTrivyFilter('high')" style="padding: 0.5rem 1rem; border: 1px solid rgba(245, 158, 11, 0.3); border-radius: 6px; background: rgba(245, 158, 11, 0.05); color: #f59e0b; cursor: pointer; font-size: 0.8rem; font-weight: 500; transition: all 0.2s;">High</button>
                    <button class="trivy-filter-btn" id="filter-medium" onclick="setTrivyFilter('medium')" style="padding: 0.5rem 1rem; border: 1px solid rgba(59, 130, 246, 0.3); border-radius: 6px; background: rgba(59, 130, 246, 0.05); color: #58a6ff; cursor: pointer; font-size: 0.8rem; font-weight: 500; transition: all 0.2s;">Medium</button>
                    <button class="trivy-filter-btn" id="filter-low" onclick="setTrivyFilter('low')" style="padding: 0.5rem 1rem; border: 1px solid rgba(156, 163, 175, 0.3); border-radius: 6px; background: rgba(156, 163, 175, 0.05); color: #8b949e; cursor: pointer; font-size: 0.8rem; font-weight: 500; transition: all 0.2s;">Low</button>
                </div>
            </div>
            <div style="border: 1px solid var(--card-border); border-radius: 8px; margin-top: 0.5rem; overflow-x: auto; background: rgba(0,0,0,0.15);">
                <table class="cve-table">
                    <thead>
                        <tr>
                            <th style="width: 20%; padding: 0.75rem;">CVE ID</th>
                            <th style="width: 35%; padding: 0.75rem;">Package</th>
                            <th style="width: 15%; padding: 0.75rem;">Severity</th>
                            <th style="width: 30%; padding: 0.75rem;">Fixed In</th>
                        </tr>
                    </thead>
                    <tbody id="trivy-tbody">
                    </tbody>
                </table>
            </div>
            <div id="trivy-pagination"></div>
        `;
    } else {
        vulnsHtml = ["<div style='text-align:center;color:var(--emerald);padding:2rem;font-weight:500;font-size:0.95rem;'>",
            "<i class='fa-solid fa-circle-check'></i> No vulnerabilities found!",
            "</div>"].join("");
    }
    
    return `
        <div class="trivy-results">
            <div style="font-size: 0.85rem; color: var(--text-muted);">
                Scan time: ${data.scan_time || 'N/A'} • Total vulnerabilities: <strong>${total}</strong>
            </div>
            <div class="trivy-summary">
                <div class="trivy-summary-box critical" style="cursor: pointer;" onclick="setTrivyFilter('critical')">CRITICAL: ${counts.CRITICAL}</div>
                <div class="trivy-summary-box high" style="cursor: pointer;" onclick="setTrivyFilter('high')">HIGH: ${counts.HIGH}</div>
                <div class="trivy-summary-box medium" style="cursor: pointer;" onclick="setTrivyFilter('medium')">MEDIUM: ${counts.MEDIUM}</div>
                <div class="trivy-summary-box low" style="cursor: pointer;" onclick="setTrivyFilter('low')">LOW: ${counts.LOW}</div>
            </div>
            ${vulnsHtml}
        </div>
    `;
}

window.setTrivyFilter = function(severity) {
    window.currentTrivyFilter = severity;
    window.paginationState.trivy.currentPage = 1;
    document.querySelectorAll('.trivy-filter-btn').forEach(btn => {
        btn.classList.remove('active');
        btn.style.background = 'rgba(255, 255, 255, 0.04)';
        btn.style.borderColor = 'var(--card-border)';
        btn.style.color = btn.id === 'filter-critical' ? '#ff7b72' : 
                          (btn.id === 'filter-high' ? '#f59e0b' : 
                          (btn.id === 'filter-medium' ? '#58a6ff' : 
                          (btn.id === 'filter-low' ? '#8b949e' : 'var(--text-main)')));
        btn.style.fontWeight = '500';
    });
    
    const activeBtn = document.getElementById(`filter-${severity}`);
    if (activeBtn) {
        activeBtn.classList.add('active');
        activeBtn.style.fontWeight = '600';
        if (severity === 'all') {
            activeBtn.style.background = 'rgba(255, 255, 255, 0.15)';
            activeBtn.style.color = 'var(--text-main)';
        } else if (severity === 'critical') {
            activeBtn.style.background = 'rgba(244, 63, 94, 0.2)';
            activeBtn.style.borderColor = '#ff7b72';
            activeBtn.style.color = '#ff7b72';
        } else if (severity === 'high') {
            activeBtn.style.background = 'rgba(245, 158, 11, 0.2)';
            activeBtn.style.borderColor = '#f59e0b';
            activeBtn.style.color = '#f59e0b';
        } else if (severity === 'medium') {
            activeBtn.style.background = 'rgba(59, 130, 246, 0.2)';
            activeBtn.style.borderColor = '#58a6ff';
            activeBtn.style.color = '#58a6ff';
        } else if (severity === 'low') {
            activeBtn.style.background = 'rgba(156, 163, 175, 0.2)';
            activeBtn.style.borderColor = '#8b949e';
            activeBtn.style.color = '#8b949e';
        }
    }
    filterTrivyTable();
};

window.filterTrivyTable = function() {
    const searchVal = document.getElementById('trivy-search')?.value.toLowerCase() || '';
    const severityFilter = window.currentTrivyFilter || 'all';
    const tbody = document.getElementById('trivy-tbody');
    const paginationDiv = document.getElementById('trivy-pagination');
    if (!tbody || !window.currentTrivyData) return;
    
    const filtered = window.currentTrivyData.vulnerabilities.filter(v => {
        const matchesSearch = v.cve.toLowerCase().includes(searchVal) || v.package.toLowerCase().includes(searchVal);
        const matchesSeverity = severityFilter === 'all' || v.severity.toLowerCase() === severityFilter;
        return matchesSearch && matchesSeverity;
    });
    
    if (filtered.length === 0) {
        tbody.innerHTML = `
            <tr>
                <td colspan="4" style="text-align: center; color: var(--text-muted); padding: 2.5rem; font-size: 0.9rem;">
                    No results match the current filters
                </td>
            </tr>
        `;
        if (paginationDiv) paginationDiv.innerHTML = '';
        return;
    }
    
    const trivyPageSize = window.paginationState.trivy.pageSize;
    const trivyTotalPages = Math.max(1, Math.ceil(filtered.length / trivyPageSize));
    if (window.paginationState.trivy.currentPage > trivyTotalPages) {
        window.paginationState.trivy.currentPage = trivyTotalPages;
    }
    const trivyStartIdx = (window.paginationState.trivy.currentPage - 1) * trivyPageSize;
    const trivyPageData = filtered.slice(trivyStartIdx, trivyStartIdx + trivyPageSize);
    
    tbody.innerHTML = trivyPageData.map(v => `
        <tr>
            <td class="mono-text" style="color: var(--primary); white-space: nowrap; padding: 0.75rem; font-weight: 500;">${v.cve}</td>
            <td class="mono-text" style="padding: 0.75rem; word-break: break-all;">${v.package}</td>
            <td style="padding: 0.75rem; white-space: nowrap;"><span class="severity-badge ${v.severity.toLowerCase()}">${v.severity}</span></td>
            <td class="mono-text" style="padding: 0.75rem; word-break: break-all;">${v.fixed_in}</td>
        </tr>
    `).join('');
    
    if (paginationDiv) {
        paginationDiv.innerHTML = renderPaginationHTML('trivy', filtered.length);
    }
};

function renderDetailsPage(type, namespace, name, data) {
    lastFetchedDetails = data;
    const detailView = document.getElementById('detail-view');
    if (!detailView) return;
    
    const age = (data.metadata && data.metadata.creationTimestamp) ? calculateAge(data.metadata.creationTimestamp) : '—';
    const creationTimeFormatted = (data.metadata && data.metadata.creationTimestamp) ? formatCreationTimestamp(data.metadata.creationTimestamp) : '—';
    
    if (type === 'pod') {
        const status = data.status.phase || 'Unknown';
        const node = data.spec.nodeName || 'N/A';
        const ip = data.status.podIP || 'N/A';
        const restarts = data.status.containerStatuses ? data.status.containerStatuses.reduce((acc, c) => acc + c.restartCount, 0) : 0;
        const containers = data.spec.containers || [];
        const primaryImage = containers[0]?.image || 'N/A';
        
        const runAsNonRoot = data.spec.securityContext?.runAsNonRoot || containers.some(c => c.securityContext?.runAsNonRoot);
        const readOnlyRootFilesystem = containers.some(c => c.securityContext?.readOnlyRootFilesystem);
        const privileged = containers.some(c => c.securityContext?.privileged);
        
        const formatRes = (val) => {
            if (!val || val === '-') {
                return `<span style="color: var(--amber); cursor: help; font-weight: 500;" title="Missing resource limits can cause cluster instability"><i class="fa-solid fa-triangle-exclamation"></i> Not defined</span>`;
            }
            return val;
        };

        const limitsCpuHtml = formatRes(containers[0]?.resources?.limits?.cpu);
        const limitsMemHtml = formatRes(containers[0]?.resources?.limits?.memory);
        const requestsCpuHtml = formatRes(containers[0]?.resources?.requests?.cpu);
        const requestsMemHtml = formatRes(containers[0]?.resources?.requests?.memory);
        
        const hasLiveness = !!containers[0]?.livenessProbe;
        const hasReadiness = !!containers[0]?.readinessProbe;
        
        const labels = data.metadata.labels || {};
        const labelsHtml = Object.entries(labels).map(([k, v]) => `<span class="label-badge">${k}=${v}</span>`).join('') || '<span class="text-muted">No labels</span>';
        
        const isLatest = !primaryImage.includes(':') || primaryImage.endsWith(':latest');
        const imageCheckHtml = isLatest 
            ? `<span style="color: var(--rose);"><i class="fa-solid fa-triangle-exclamation"></i> Warning: using :latest or no tag specified</span>`
            : `<span style="color: var(--emerald);"><i class="fa-solid fa-circle-check"></i> Image uses a pinned version</span>`;
            
        const scanResult = trivyScanResults[primaryImage];
        let trivyInnerHtml = '';
        if (scanResult) {
            trivyInnerHtml = renderTrivyScanHTML(scanResult);
        } else {
            trivyInnerHtml = `
                <div class="trivy-results">
                    <p class="detail-subtitle" style="margin-bottom: 0.75rem; font-size: 0.95rem;">Check container image for known security vulnerabilities using Trivy.</p>
                    <button class="action-btn" style="width: auto; background: var(--primary); color: #0d111a; border: none; padding: 0.6rem 1.2rem; font-weight: 600;" onclick="runTrivyScan('${primaryImage}')">
                        <i class="fa-solid fa-shield-halved"></i> Run Trivy Scan
                    </button>
                </div>
            `;
        }

        const statusClass = status === 'Running' ? 'success' : (status === 'Pending' ? 'warning' : 'danger');
        
        detailView.innerHTML = `
            <div class="detail-header">
                <div class="detail-title-area">
                    <button class="detail-back-btn" onclick="goBackToDashboard()" style="margin-bottom: 0.5rem; align-self: flex-start;">
                        <i class="fa-solid fa-arrow-left"></i> Back to list
                    </button>
                    <div class="detail-title-row">
                        <span class="detail-title">Pod: ${name}</span>
                        <span id="detail-pod-status-badge" class="badge ${statusClass}">${status}</span>
                    </div>
                    <span class="detail-subtitle">Namespace: ${namespace} • Created ${age} ago (${creationTimeFormatted})</span>
                </div>
                <div class="detail-actions">
                    <button class="action-btn" style="background: transparent; border-color: var(--card-border);" onclick="triggerRestartPod('${namespace}', '${name}')">
                        <i class="fa-solid fa-rotate-right"></i> Restart Pod
                    </button>
                    <button class="action-btn" style="background: var(--rose); color: white; border-color: transparent;" onclick="triggerDeletePod('${namespace}', '${name}')">
                        <i class="fa-solid fa-trash"></i> Delete Pod
                    </button>
                </div>
            </div>
            
            <div class="detail-grid">
                <div class="detail-card">
                    <div class="detail-card-title">General Info</div>
                    <div class="detail-info-grid">
                        <div class="detail-info-label">Namespace</div>
                        <div class="detail-info-value">${namespace}</div>
                        <div class="detail-info-label">Status</div>
                        <div class="detail-info-value"><span class="badge ${statusClass}">${status}</span></div>
                        <div class="detail-info-label">Age</div>
                        <div class="detail-info-value">${age} ago (${creationTimeFormatted})</div>
                        <div class="detail-info-label">Node</div>
                        <div class="detail-info-value">${node}</div>
                        <div class="detail-info-label">IP Address</div>
                        <div class="detail-info-value">${ip}</div>
                        <div class="detail-info-label">Restarts</div>
                        <div id="detail-pod-restarts" class="detail-info-value">${restarts}</div>
                    </div>
                </div>
                
                <div class="detail-card">
                    <div class="detail-card-title">Container Image</div>
                    <div class="detail-info-grid">
                        <div class="detail-info-label">Image Name</div>
                        <div class="detail-info-value mono-text">${primaryImage}</div>
                        <div class="detail-info-label">Tag Check</div>
                        <div class="detail-info-value">${imageCheckHtml}</div>
                    </div>
                </div>
                
                <div class="detail-card">
                    <div class="detail-card-title">Resource Allocation</div>
                    <div class="detail-info-grid">
                        <div class="detail-info-label">Requests CPU</div>
                        <div class="detail-info-value">${requestsCpuHtml}</div>
                        <div class="detail-info-label">Limits CPU</div>
                        <div class="detail-info-value">${limitsCpuHtml}</div>
                        <div class="detail-info-label">Requests Memory</div>
                        <div class="detail-info-value">${requestsMemHtml}</div>
                        <div class="detail-info-label">Limits Memory</div>
                        <div class="detail-info-value">${limitsMemHtml}</div>
                    </div>
                </div>
                
                <div class="detail-card">
                    <div class="detail-card-title">Health Checks</div>
                    <div class="detail-info-grid">
                        <div class="detail-info-label">Readiness Probe</div>
                        <div class="detail-info-value">
                            ${hasReadiness ? '<span style="color: var(--emerald);"><i class="fa-solid fa-circle-check"></i> Configured</span>' : '<span style="color: var(--amber);"><i class="fa-solid fa-triangle-exclamation"></i> Not set</span>'}
                        </div>
                        <div class="detail-info-label">Liveness Probe</div>
                        <div class="detail-info-value">
                            ${hasLiveness ? '<span style="color: var(--emerald);"><i class="fa-solid fa-circle-check"></i> Configured</span>' : '<span style="color: var(--amber);"><i class="fa-solid fa-triangle-exclamation"></i> Not set</span>'}
                        </div>
                    </div>
                </div>
                
                <div class="detail-card">
                    <div class="detail-card-title">Security Context</div>
                    <div class="detail-info-grid">
                        <div class="detail-info-label">Non-Root User</div>
                        <div class="detail-info-value">
                            ${runAsNonRoot ? '<span style="color: var(--emerald);"><i class="fa-solid fa-circle-check"></i> Non-Root</span>' : '<span style="color: var(--rose);"><i class="fa-solid fa-triangle-exclamation"></i> Runs as root allowed</span>'}
                        </div>
                        <div class="detail-info-label">ReadOnly FS</div>
                        <div class="detail-info-value">
                            ${readOnlyRootFilesystem ? '<span style="color: var(--emerald);"><i class="fa-solid fa-circle-check"></i> Read-only</span>' : '<span style="color: var(--amber);"><i class="fa-solid fa-triangle-exclamation"></i> Filesystem is writable</span>'}
                        </div>
                        <div class="detail-info-label">Privileged Mode</div>
                        <div class="detail-info-value">
                            ${privileged ? '<span style="color: var(--rose);"><i class="fa-solid fa-triangle-exclamation"></i> Enabled (Dangerous)</span>' : '<span style="color: var(--emerald);"><i class="fa-solid fa-circle-check"></i> Disabled (Safe)</span>'}
                        </div>
                    </div>
                </div>
            </div>
            
            <div style="margin-top: 2rem; display: flex; flex-direction: column; gap: 2rem;">
                <div class="trivy-report-section" style="background: var(--card-bg); border: 1px solid var(--card-border); border-radius: 8px; padding: 2rem; display: flex; flex-direction: column; gap: 1.5rem;">
                    <div style="font-size: 1.35rem; font-weight: 700; color: #ffffff; border-bottom: 1px solid rgba(255, 255, 255, 0.08); padding-bottom: 0.75rem; display: flex; align-items: center; gap: 0.6rem;">
                        <i class="fa-solid fa-shield-halved" style="color: var(--primary);"></i> Container Image Security Report (Trivy)
                    </div>
                    <div id="trivy-scan-box">
                        ${trivyInnerHtml}
                    </div>
                </div>
                
                <div class="detail-card">
                    <div class="detail-card-title" style="display: flex; justify-content: space-between; align-items: center; width: 100%;">
                        <span><i class="fa-solid fa-tags" style="color: var(--cyan); margin-right: 0.5rem;"></i>Labels</span>
                        <button class="action-btn" style="width: auto; padding: 0.3rem 0.6rem; font-size: 0.8rem; background: var(--card-border); color: var(--text-main); border: 1px solid rgba(255,255,255,0.08);" onclick="copyLabelsToClipboard('${btoa(JSON.stringify(labels))}')">
                            <i class="fa-solid fa-copy"></i> Copy all labels
                        </button>
                    </div>
                    <div class="label-container">${labelsHtml}</div>
                </div>
            </div>
        `;
        if (scanResult) {
            filterTrivyTable();
        }
    } else if (type === 'deployment') {
        const replicas = data.spec.replicas || 0;
        const readyReplicas = data.status.readyReplicas || 0;
        const availableReplicas = data.status.availableReplicas || 0;
        
        const containers = data.spec.template.spec.containers || [];
        const primaryImage = containers[0]?.image || 'N/A';
        
        const strategy = data.spec.strategy?.type || 'RollingUpdate';
        const labels = data.metadata.labels || {};
        const labelsHtml = Object.entries(labels).map(([k, v]) => `<span class="label-badge">${k}=${v}</span>`).join('') || '<span class="text-muted">No labels</span>';
        
        const pct = replicas > 0 ? Math.round((readyReplicas / replicas) * 100) : 0;
        
        detailView.innerHTML = `
            <div class="detail-header">
                <div class="detail-title-area">
                    <button class="detail-back-btn" onclick="goBackToDashboard()" style="margin-bottom: 0.5rem; align-self: flex-start;">
                        <i class="fa-solid fa-arrow-left"></i> Back to list
                    </button>
                    <div class="detail-title-row">
                        <span class="detail-title">Deployment: ${name}</span>
                        <span id="detail-dep-status-badge" class="badge ${readyReplicas === replicas ? 'success' : 'warning'}">
                            ${readyReplicas} / ${replicas} ready
                        </span>
                    </div>
                    <span class="detail-subtitle">Namespace: ${namespace} • Created ${age} ago (${creationTimeFormatted})</span>
                </div>
                <div class="detail-actions">
                    <button class="action-btn" style="background: transparent; border-color: var(--card-border);" onclick="triggerScaleDeployment('${namespace}', '${name}', ${replicas - 1})">
                        <i class="fa-solid fa-minus"></i> Scale Down
                    </button>
                    <button class="action-btn" style="background: var(--primary); color: #0d111a; border-color: transparent;" onclick="triggerScaleDeployment('${namespace}', '${name}', ${replicas + 1})">
                        <i class="fa-solid fa-plus"></i> Scale Up
                    </button>
                    <button class="action-btn" style="background: transparent; border-color: var(--card-border);" onclick="triggerRestartDeployment('${namespace}', '${name}')">
                        <i class="fa-solid fa-rotate-right"></i> Rolling Restart
                    </button>
                </div>
            </div>
            
            <div class="detail-grid">
                <div class="detail-card">
                    <div class="detail-card-title">Replica Status</div>
                    <div class="detail-info-grid">
                        <div class="detail-info-label">Desired</div>
                        <div id="detail-dep-replicas" class="detail-info-value">${replicas}</div>
                        <div class="detail-info-label">Ready</div>
                        <div id="detail-dep-ready" class="detail-info-value">${readyReplicas}</div>
                        <div class="detail-info-label">Available</div>
                        <div id="detail-dep-available" class="detail-info-value">${availableReplicas}</div>
                    </div>
                    <div style="margin-top: 0.5rem; display: flex; flex-direction: column; gap: 0.25rem;">
                        <span style="font-size: 0.8rem; color: var(--text-muted); font-weight: 500;">Pod readiness: ${pct}%</span>
                        <div class="progress-bar-container">
                            <div id="detail-dep-progress-bar" class="progress-bar-fill" style="width: ${pct}%;"></div>
                        </div>
                    </div>
                </div>
                
                <div class="detail-card">
                    <div class="detail-card-title">Template Container Image</div>
                    <div class="detail-info-grid">
                        <div class="detail-info-label">Image Name</div>
                        <div class="detail-info-value mono-text">${primaryImage}</div>
                    </div>
                </div>
                
                <div class="detail-card">
                    <div class="detail-card-title">Update Strategy</div>
                    <div class="detail-info-grid">
                        <div class="detail-info-label">Strategy Type</div>
                        <div class="detail-info-value">${strategy}</div>
                    </div>
                </div>
                
                <div class="detail-card" style="grid-column: 1 / -1;">
                    <div class="detail-card-title">Labels</div>
                    <div class="label-container">${labelsHtml}</div>
                </div>
            </div>
        `;
    } else if (type === 'service') {
        const svcType = data.spec.type || 'ClusterIP';
        const clusterIP = data.spec.clusterIP || 'N/A';
        const ports = data.spec.ports || [];
        const labels = data.metadata.labels || {};
        const labelsHtml = Object.entries(labels).map(([k, v]) => `<span class="label-badge">${k}=${v}</span>`).join('') || '<span class="text-muted">No labels</span>';
        
        const portsHtml = ports.map(p => {
            return `<div class="mono-text" style="font-size: 0.85rem; margin-bottom: 0.25rem;">${p.name || 'default'} : ${p.port} → ${p.targetPort || p.port} / ${p.protocol}</div>`;
        }).join('') || '<span class="text-muted">No ports</span>';
        
        detailView.innerHTML = `
            <div class="detail-header">
                <div class="detail-title-area">
                    <button class="detail-back-btn" onclick="goBackToDashboard()">
                        <i class="fa-solid fa-arrow-left"></i> Back to list
                    </button>
                    <div class="detail-title-row">
                        <span class="detail-title">Service: ${name}</span>
                        <span class="badge info">${svcType}</span>
                    </div>
                    <span class="detail-subtitle">Namespace: ${namespace} • Created ${age} ago (${creationTimeFormatted})</span>
                </div>
            </div>
            
            <div class="detail-grid">
                <div class="detail-card">
                    <div class="detail-card-title">Network Parameters</div>
                    <div class="detail-info-grid">
                        <div class="detail-info-label">Service Type</div>
                        <div class="detail-info-value">${svcType}</div>
                        <div class="detail-info-label">Cluster IP</div>
                        <div class="detail-info-value mono-text">${clusterIP}</div>
                    </div>
                </div>
                
                <div class="detail-card">
                    <div class="detail-card-title">Service Ports</div>
                    <div style="display: flex; flex-direction: column;">
                        ${portsHtml}
                    </div>
                </div>
                
                <div class="detail-card" style="grid-column: 1 / -1;">
                    <div class="detail-card-title">Labels</div>
                    <div class="label-container">${labelsHtml}</div>
                </div>
            </div>
        `;
    } else if (type === 'node') {
        const m = data.metrics || { cpu_usage_pct: 0, ram_usage_pct: 0, cpu_usage_m: 0, ram_usage_mib: 0 };
        const cpuCapacity = data.cpu?.capacity || '—';
        const cpuAllocatable = data.cpu?.allocatable || '—';
        const memCapacity = data.memory?.capacity || '—';
        const memAllocatable = data.memory?.allocatable || '—';

        const parseK8sMemToMi = (str) => {
            if (!str || str === '—') return 0;
            if (str.endsWith('Ki')) return Math.round(parseInt(str) / 1024);
            if (str.endsWith('Mi')) return parseInt(str);
            if (str.endsWith('Gi')) return parseInt(str) * 1024;
            return Math.round(parseInt(str) / (1024 * 1024));
        };
        const memCapMi = parseK8sMemToMi(memCapacity);
        const memAllocMi = parseK8sMemToMi(memAllocatable);

        const conditionConfig = {
            'Ready': {
                label: 'Ready',
                iconOk: 'fa-circle-check',
                iconErr: 'fa-circle-xmark',
                colorOk: 'var(--emerald)',
                colorErr: 'var(--rose)',
                descOk: 'Node is healthy and ready to accept pods',
                descErr: 'Node is unhealthy or not ready to accept pods',
                checkOk: (v) => v === true
            },
            'MemoryPressure': {
                label: 'Memory Pressure',
                iconOk: 'fa-circle-check',
                iconErr: 'fa-triangle-exclamation',
                colorOk: 'var(--emerald)',
                colorErr: 'var(--rose)',
                descOk: 'Memory resources are sufficient',
                descErr: 'Node memory is critically low',
                checkOk: (v) => v === false
            },
            'DiskPressure': {
                label: 'Disk Pressure',
                iconOk: 'fa-circle-check',
                iconErr: 'fa-triangle-exclamation',
                colorOk: 'var(--emerald)',
                colorErr: 'var(--rose)',
                descOk: 'Disk space is sufficient',
                descErr: 'Node disk space is critically low',
                checkOk: (v) => v === false
            },
            'PIDPressure': {
                label: 'PID Pressure',
                iconOk: 'fa-circle-check',
                iconErr: 'fa-triangle-exclamation',
                colorOk: 'var(--emerald)',
                colorErr: 'var(--rose)',
                descOk: 'Process count is within healthy limits',
                descErr: 'Node process count is too high',
                checkOk: (v) => v === false
            },
            'NetworkUnavailable': {
                label: 'Network Unavailable',
                iconOk: 'fa-circle-check',
                iconErr: 'fa-triangle-exclamation',
                colorOk: 'var(--emerald)',
                colorErr: 'var(--rose)',
                descOk: 'Network is configured and available',
                descErr: 'Node network connection is unavailable',
                checkOk: (v) => v === false
            }
        };

        const condHtml = Object.entries(data.conditions || {}).map(([k, v]) => {
            const config = conditionConfig[k] || {
                label: k,
                iconOk: 'fa-circle-check',
                iconErr: 'fa-circle-exclamation',
                colorOk: 'var(--emerald)',
                colorErr: 'var(--rose)',
                descOk: 'Condition is normal',
                descErr: 'Condition is abnormal',
                checkOk: (val) => val === false
            };
            const isOk = config.checkOk(v);
            const icon = isOk ? config.iconOk : config.iconErr;
            const color = isOk ? config.colorOk : config.colorErr;
            const desc = isOk ? config.descOk : config.descErr;
            
            return `
                <div style="display: flex; align-items: flex-start; gap: 0.75rem; padding: 0.6rem 0.8rem; border-radius: 8px; background: rgba(255,255,255,0.02); border: 1px solid var(--card-border); width: 100%;">
                    <div style="font-size: 1.1rem; color: ${color}; padding-top: 0.1rem;">
                        <i class="fa-solid ${icon}"></i>
                    </div>
                    <div style="display: flex; flex-direction: column; gap: 0.15rem; flex: 1;">
                        <span style="font-size: 0.85rem; font-weight: 600; color: var(--text-main);">${config.label}</span>
                        <span style="font-size: 0.72rem; color: var(--text-muted); line-height: 1.3;">${desc}</span>
                    </div>
                    <span class="badge ${isOk ? 'success' : 'danger'}" style="font-size: 0.7rem; padding: 0.15rem 0.4rem; white-space: nowrap; margin-left: 0.5rem;">${v ? 'True' : 'False'}</span>
                </div>
            `;
        }).join('');

        window._nodePodsData = data.pods || [];
        window.paginationState.nodePods.currentPage = 1;

        window.renderNodePodsTable = function() {
            const allPods = window._nodePodsData;
            const state = window.paginationState.nodePods;
            const totalPages = Math.max(1, Math.ceil(allPods.length / state.pageSize));
            if (state.currentPage > totalPages) state.currentPage = totalPages;
            const startIdx = (state.currentPage - 1) * state.pageSize;
            const pagePods = allPods.slice(startIdx, startIdx + state.pageSize);

            const tbody = document.getElementById('node-pods-tbody');
            const paginationDiv = document.getElementById('node-pods-pagination');
            if (!tbody) return;

            tbody.innerHTML = pagePods.length > 0
                ? pagePods.map(p => `
                    <tr onclick="navigateToDetails('pod', '${p.namespace || 'default'}', '${p.name}')" style="cursor: pointer;">
                        <td class="mono-text">${p.name}</td>
                        <td class="mono-text">${p.namespace}</td>
                        <td><span class="badge ${p.status === 'Running' ? 'success' : (p.status === 'Pending' ? 'warning' : 'danger')}">${p.status}</span></td>
                        <td>${p.restarts ?? 0}</td>
                        <td class="mono-text" style="max-width:220px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font-size:0.78rem;">${p.image}</td>
                        <td class="actions-cell"><div class="actions-cell-container"><button class="action-btn" style="padding:0.25rem 0.6rem;font-size:0.8rem;width:auto;" onclick="event.stopPropagation();navigateToDetails('pod','${p.namespace || 'default'}','${p.name}')"><i class="fa-solid fa-circle-info"></i> Details</button></div></td>
                    </tr>`).join('')
                : '<tr><td colspan="6" style="text-align: center; color: var(--text-muted);">No pods found on this node</td></tr>';

            if (paginationDiv) {
                paginationDiv.innerHTML = renderPaginationHTML('nodePods', allPods.length);
            }
        };

        const isReady = data.conditions?.Ready === true;

        detailView.innerHTML = `
            <div class="detail-header">
                <div class="detail-title-area">
                    <button class="detail-back-btn" onclick="goBackToDashboard()">
                        <i class="fa-solid fa-arrow-left"></i> Back to list
                    </button>
                    <div class="detail-title-row">
                        <span class="detail-title">Node: ${name}</span>
                        <span class="badge ${isReady ? 'success' : 'danger'}">${isReady ? 'Ready' : 'NotReady'}</span>
                    </div>
                    <span class="detail-subtitle">${data.internal_ip || '—'} &bull; ${data.os || '—'} &bull; Kubelet ${data.kubelet_version || '—'}</span>
                </div>
            </div>
            
            <div class="detail-grid">
                <div class="detail-card">
                    <div class="detail-card-title">General Information</div>
                    <div class="detail-info-grid">
                        <div class="detail-info-label">OS</div>
                        <div class="detail-info-value">${data.os || '—'}</div>
                        <div class="detail-info-label">Architecture</div>
                        <div class="detail-info-value mono-text">${data.architecture || '—'}</div>
                        <div class="detail-info-label">Kubelet Version</div>
                        <div class="detail-info-value mono-text">${data.kubelet_version || '—'}</div>
                        <div class="detail-info-label">Container Runtime</div>
                        <div class="detail-info-value mono-text">${data.container_runtime || '—'}</div>
                        <div class="detail-info-label">Internal IP</div>
                        <div class="detail-info-value mono-text">${data.internal_ip || '—'}</div>
                        <div class="detail-info-label">External IP</div>
                        <div class="detail-info-value mono-text">${data.external_ip || '—'}</div>
                    </div>
                </div>
                
                <div class="detail-card">
                    <div class="detail-card-title">Node Conditions</div>
                    <div style="display: flex; flex-direction: column; gap: 0.5rem; margin-top: 1rem;">
                        ${condHtml}
                    </div>
                </div>
                
                <div class="detail-card" style="grid-column: 1 / -1;">
                    <div class="detail-card-title">Node Resource Usage</div>
                    <div style="display: flex; flex-direction: column; gap: 1.5rem; margin-top: 1rem;">
                        <div>
                            <div style="display: flex; justify-content: space-between; margin-bottom: 0.5rem; font-size: 0.9rem;">
                                <span><i class="fa-solid fa-microchip" style="color: var(--primary);"></i> CPU Usage</span>
                                <span class="mono-text">${m.cpu_usage_m}m / ${cpuCapacity} (${m.cpu_usage_pct}%)</span>
                            </div>
                            <div class="progress-bar-container" style="background: rgba(255, 255, 255, 0.05); height: 16px; border-radius: 8px; overflow: hidden; border: 1px solid var(--card-border);">
                                <div style="width: ${m.cpu_usage_pct}%; background: linear-gradient(90deg, var(--primary), var(--cyan)); height: 100%; transition: width 0.3s ease;"></div>
                            </div>
                            <span style="font-size: 0.75rem; color: var(--text-muted); margin-top: 0.25rem; display: block;">Allocatable CPU: ${cpuAllocatable}</span>
                        </div>
                        <div>
                            <div style="display: flex; justify-content: space-between; margin-bottom: 0.5rem; font-size: 0.9rem;">
                                <span><i class="fa-solid fa-memory" style="color: var(--cyan);"></i> RAM Usage</span>
                                <span class="mono-text">${m.ram_usage_mib}Mi / ${memCapMi}Mi (${m.ram_usage_pct}%)</span>
                            </div>
                            <div class="progress-bar-container" style="background: rgba(255, 255, 255, 0.05); height: 16px; border-radius: 8px; overflow: hidden; border: 1px solid var(--card-border);">
                                <div style="width: ${m.ram_usage_pct}%; background: linear-gradient(90deg, var(--cyan), var(--emerald)); height: 100%; transition: width 0.3s ease;"></div>
                            </div>
                            <span style="font-size: 0.75rem; color: var(--text-muted); margin-top: 0.25rem; display: block;">Allocatable RAM: ${memAllocMi}Mi</span>
                        </div>
                    </div>
                </div>

                <div class="detail-card" style="grid-column: 1 / -1;">
                    <div class="detail-card-title">Pods on this Node
                        <span style="font-size:0.8rem;font-weight:400;color:var(--text-muted);margin-left:0.5rem;">
                            ${(() => { const pods = data.pods||[]; const r=pods.filter(p=>p.status==='Running').length; const pe=pods.filter(p=>p.status==='Pending').length; const f=pods.filter(p=>p.status==='Failed'||p.status==='CrashLoopBackOff'||p.status==='Error').length; return `Total: ${pods.length} &nbsp;<span style="color:var(--emerald);">${r} running</span>${pe>0?` &nbsp;<span style="color:var(--amber);">${pe} pending</span>`:``}${f>0?` &nbsp;<span style="color:var(--rose);">${f} failed</span>`:``}`; })()}
                        </span>
                    </div>
                    <div class="table-responsive" style="margin-top: 1rem;">
                        <table>
                            <thead>
                                <tr>
                                    <th>Pod Name</th>
                                    <th>Namespace</th>
                                    <th>Status</th>
                                    <th>Restarts</th>
                                    <th>Image</th>
                                    <th>Actions</th>
                                </tr>
                            </thead>
                            <tbody id="node-pods-tbody">
                            </tbody>
                        </table>
                    </div>
                    <div id="node-pods-pagination"></div>
                </div>
            </div>
        `;
        window.renderNodePodsTable();
    }
}

const K8S_DIAGNOSTICS = {
    'CrashLoopBackOff': {
        reason: 'Container starts and immediately exits (likely a config or code error)',
        action: 'Check container logs using the Logs button or kubectl logs'
    },
    'OOMKilled': {
        reason: 'Container ran out of memory (exceeded limits.memory)',
        action: 'Increase the memory limit (limits.memory) in the pod spec'
    },
    'ImagePullBackOff': {
        reason: 'Failed to pull the container image',
        action: 'Check the image name and pull secrets (imagePullSecrets)'
    },
    'ErrImagePull': {
        reason: 'Failed to pull the container image',
        action: 'Check the image name and pull secrets (imagePullSecrets)'
    },
    'Pending': {
        reason: 'Pod is waiting to be scheduled (possibly insufficient cluster resources)',
        action: 'Check available CPU/Memory on nodes or review events in the Events tab'
    },
    'Failed': {
        reason: 'Container exited with an error',
        action: 'Check the exit code and container logs'
    },
    'Error': {
        reason: 'Container exited with an error',
        action: 'Check the exit code and container logs'
    }
};

function renderEventsTable() {
    if (!currentData || !currentData.events) return;
    
    const eventsBody = document.querySelector('#events-tab tbody');
    if (!eventsBody) return;
    
    const ns = activeNamespace;
    let filteredEvents = ns === "all" ? currentData.events : currentData.events.filter(e => e.namespace === ns);
    
    if (activeEventFilter !== 'all') {
        filteredEvents = filteredEvents.filter(e => e.type === activeEventFilter);
    }
    
    const eventsPagination = document.getElementById('events-pagination');
    
    if (filteredEvents.length === 0) {
        eventsBody.innerHTML = '<tr><td colspan="6" style="text-align: center; color: var(--text-muted);">No events found</td></tr>';
        if (eventsPagination) eventsPagination.innerHTML = '';
        return;
    }
    
    const eventsPageSize = window.paginationState.events.pageSize;
    const eventsTotalPages = Math.max(1, Math.ceil(filteredEvents.length / eventsPageSize));
    if (window.paginationState.events.currentPage > eventsTotalPages) {
        window.paginationState.events.currentPage = eventsTotalPages;
    }
    const eventsStartIdx = (window.paginationState.events.currentPage - 1) * eventsPageSize;
    const eventsPageData = filteredEvents.slice(eventsStartIdx, eventsStartIdx + eventsPageSize);
    
    eventsBody.innerHTML = eventsPageData.map(e => `
        <tr>
            <td class="mono-text">${e.time}</td>
            <td><span class="badge ${e.type === 'Warning' ? 'danger' : 'success'}">${e.type}</span></td>
            <td class="mono-text">${e.reason}</td>
            <td class="mono-text">${e.object}</td>
            <td>${e.message}</td>
            <td class="mono-text">${e.namespace}</td>
        </tr>
    `).join('');
    
    if (eventsPagination) {
        eventsPagination.innerHTML = renderPaginationHTML('events', filteredEvents.length);
    }
}

function renderUI() {
    if (!currentData) return;
    
    const ns = activeNamespace;
    const overview = currentData.overview;
    
    const nodesVal = document.getElementById('stats-nodes');
    if (nodesVal) nodesVal.textContent = `${overview.nodes.ready} / ${overview.nodes.total}`;

    const healthBadge = document.getElementById('cluster-health-badge');
    const healthStatus = document.getElementById('cluster-health-status');
    if (healthBadge && healthStatus) {
        if (overview.cluster_health === "healthy") {
            healthBadge.className = "health-badge success";
            healthStatus.textContent = "Cluster: Healthy";
        } else {
            healthBadge.className = "health-badge warning";
            healthStatus.textContent = "Cluster: Degraded";
        }
    }

    const lastUpdatedEl = document.getElementById('cluster-last-updated');
    if (lastUpdatedEl) {
        const now = new Date();
        lastUpdatedEl.textContent = `Updated ${now.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}`;
    }

    const envContainer = document.getElementById('env-badge-container');
    if (envContainer) {
        const isProd = ["gke", "aws eks", "aks"].includes((overview.env || "").toLowerCase());
        envContainer.innerHTML = `
            <span class="env-badge ${isProd ? 'prod' : 'dev'}">${overview.env || 'Minikube'}</span>
            <span class="env-badge version">${overview.version || 'v1.28.3'}</span>
            ${overview.argocd_status ? '<span class="env-badge dev">ArgoCD</span>' : ''}
        `;
    }

    const allPods = currentData.pods || [];
    const nsPods = ns === "all" ? allPods : allPods.filter(p => p.namespace === ns);

    let compliantCount = 0;
    nsPods.forEach(p => {
        if (p.security && Object.values(p.security).every(v => v === true)) {
            compliantCount++;
        }
    });

    const score = nsPods.length > 0 ? Math.round((compliantCount / nsPods.length) * 100) : 100;
    const scoreVal = document.getElementById('stats-security');
    const scoreSub = document.getElementById('stats-security-sub');
    if (scoreVal) scoreVal.textContent = `${score}%`;
    if (scoreSub) {
        const nonCompliant = nsPods.length - compliantCount;
        scoreSub.textContent = nonCompliant === 0
            ? 'All pods are compliant'
            : `${nonCompliant} of ${nsPods.length} need attention`;
    }

    let filteredPods = nsPods;
    if (filterSecurityIssuesOnly) {
        filteredPods = nsPods.filter(p => p.security && !Object.values(p.security).every(v => v === true));
    }

    const runningCount = filteredPods.filter(p => p.status === "Running").length;
    const pendingCount = filteredPods.filter(p => p.status === "Pending").length;
    const failedCount = filteredPods.filter(p => p.status === "Failed" || p.status === "CrashLoopBackOff" || p.status === "Error").length;
    const issuesCount = pendingCount + failedCount;

    const statsPods = document.getElementById('stats-pods');
    const statsRunning = document.getElementById('stats-running');
    const statsFailed = document.getElementById('stats-failed');
    if (statsPods) statsPods.textContent = filteredPods.length;
    if (statsRunning) statsRunning.textContent = `${runningCount} / ${filteredPods.length}`;
    if (statsFailed) statsFailed.textContent = issuesCount;
    
    const badgePods = document.getElementById('badge-pods');
    if (badgePods) badgePods.textContent = filteredPods.length;
    
    podsHistory.push(filteredPods.length);
    runningHistory.push(runningCount);
    restartsHistory.push(issuesCount);
    
    if (podsHistory.length > 20) podsHistory.shift();
    if (runningHistory.length > 20) runningHistory.shift();
    if (restartsHistory.length > 20) restartsHistory.shift();
    
    // Draw sparklines
    sparklinePods = updateSparkline('sparkline-pods', podsHistory, '#38bdf8', 'rgba(56, 189, 248, 0.25)', 'rgba(56, 189, 248, 0)');
    sparklineRunning = updateSparkline('sparkline-running', runningHistory, '#10b981', 'rgba(16, 185, 129, 0.25)', 'rgba(16, 185, 129, 0)');
    sparklineRestarts = updateSparkline('sparkline-restarts', restartsHistory, '#f43f5e', 'rgba(244, 63, 94, 0.25)', 'rgba(244, 63, 94, 0)');
    
    initChart(runningCount, pendingCount, failedCount);
    
    const podsBody = document.getElementById('pods-table-body');
    const podsPagination = document.getElementById('pods-pagination');
    if (podsBody) {
        if (filteredPods.length === 0) {
            podsBody.innerHTML = '<tr><td colspan="11" style="text-align: center; color: var(--text-muted);">No pods found</td></tr>';
            if (podsPagination) podsPagination.innerHTML = '';
        } else {
            const podsPageSize = window.paginationState.pods.pageSize;
            const podsTotalPages = Math.max(1, Math.ceil(filteredPods.length / podsPageSize));
            if (window.paginationState.pods.currentPage > podsTotalPages) {
                window.paginationState.pods.currentPage = podsTotalPages;
            }
            const podsStartIdx = (window.paginationState.pods.currentPage - 1) * podsPageSize;
            const podsPageData = filteredPods.slice(podsStartIdx, podsStartIdx + podsPageSize);
            
            podsBody.innerHTML = podsPageData.map(p => {
                const isExpanded = expandedPods.has(p.name);
                const isLatest = p.security && p.security.no_latest === false;
                
                let rowHtml = `
                    <tr id="pod-row-${p.name}" onclick="togglePodExpand('${p.name}')" style="cursor: pointer;" class="${isExpanded ? 'expanded-row' : ''}">
                        <td class="mono-text">${p.name}</td>
                        <td class="mono-text">${p.namespace}</td>
                        <td class="mono-text">${p.cpu_usage || '—'}</td>
                        <td class="mono-text">${p.memory_usage || '—'}</td>
                        <td class="mono-text">
                            ${p.image || 'N/A'}
                            ${isLatest ? '<i class="fa-solid fa-triangle-exclamation" style="color: var(--amber); margin-left: 0.25rem;" title="Uses :latest tag"></i>' : ''}
                        </td>
                        <td><span class="badge ${p.status === 'Running' ? 'success' : (p.status === 'Pending' ? 'warning' : 'danger')}">${p.status}</span></td>
                        <td>${p.restarts}</td>
                        <td class="mono-text">${p.node}</td>
                        <td class="mono-text">${p.ip}</td>
                        <td>${p.age}</td>
                        <td class="actions-cell">
                            <div class="actions-cell-container">
                                <button class="action-btn" onclick="event.stopPropagation(); showLogs('${p.namespace}', '${p.name}')">
                                    <i class="fa-solid fa-terminal"></i> Logs
                                </button>
                                <button class="action-btn" onclick="event.stopPropagation(); navigateToDetails('pod', '${p.namespace}', '${p.name}')">
                                    <i class="fa-solid fa-circle-info"></i> Details
                                </button>
                            </div>
                        </td>
                    </tr>
                `;
                
                if (isExpanded) {
                    const sec = p.security || {};
                    const diag = K8S_DIAGNOSTICS[p.status];
                    
                    rowHtml += `
                        <tr class="expanded-row">
                            <td colspan="11">
                                <div class="expanded-content-container">
                                    <div>
                                        <div class="security-score-banner">
                                            <i class="fa-solid fa-shield-halved" style="color: var(--primary);"></i>
                                            Security Best Practices
                                        </div>
                                        <div class="security-checklist">
                                            <div class="checklist-item ${sec.no_latest ? 'pass' : 'fail'}">
                                                <i class="fa-solid ${sec.no_latest ? 'fa-circle-check' : 'fa-circle-xmark'}"></i>
                                                No :latest image tag
                                            </div>
                                            <div class="checklist-item ${sec.has_limits ? 'pass' : 'fail'}">
                                                <i class="fa-solid ${sec.has_limits ? 'fa-circle-check' : 'fa-circle-xmark'}"></i>
                                                Resource limits defined (CPU/Memory)
                                            </div>
                                            <div class="checklist-item ${sec.has_requests ? 'pass' : 'fail'}">
                                                <i class="fa-solid ${sec.has_requests ? 'fa-circle-check' : 'fa-circle-xmark'}"></i>
                                                Resource requests defined (CPU/Memory)
                                            </div>
                                            <div class="checklist-item ${sec.has_readiness ? 'pass' : 'fail'}">
                                                <i class="fa-solid ${sec.has_readiness ? 'fa-circle-check' : 'fa-circle-xmark'}"></i>
                                                readinessProbe configured
                                            </div>
                                            <div class="checklist-item ${sec.has_liveness ? 'pass' : 'fail'}">
                                                <i class="fa-solid ${sec.has_liveness ? 'fa-circle-check' : 'fa-circle-xmark'}"></i>
                                                livenessProbe configured
                                            </div>
                                            <div class="checklist-item ${sec.run_as_non_root ? 'pass' : 'fail'}">
                                                <i class="fa-solid ${sec.run_as_non_root ? 'fa-circle-check' : 'fa-circle-xmark'}"></i>
                                                Container runs as non-root
                                            </div>
                                        </div>
                                    </div>
                                    ${diag ? `
                                        <div class="diagnostic-box">
                                            <div class="diagnostic-title">
                                                <i class="fa-solid fa-triangle-exclamation"></i>
                                                Diagnostic Tip
                                            </div>
                                            <div class="diagnostic-text">
                                                <strong>Possible cause:</strong> ${diag.reason}<br>
                                                <strong>Recommended action:</strong> ${diag.action}
                                            </div>
                                        </div>
                                    ` : ''}
                                </div>
                            </td>
                        </tr>
                    `;
                }
                return rowHtml;
            }).join('');
            if (podsPagination) {
                podsPagination.innerHTML = renderPaginationHTML('pods', filteredPods.length);
            }
        }
    }
    
    const allNodes = currentData.nodes || [];
    const badgeNodes = document.getElementById('badge-nodes');
    if (badgeNodes) badgeNodes.textContent = allNodes.length;
    
    const nodesBody = document.getElementById('nodes-table-body');
    const nodesPagination = document.getElementById('nodes-pagination');
    if (nodesBody) {
        if (allNodes.length === 0) {
            nodesBody.innerHTML = '<tr><td colspan="6" style="text-align: center; color: var(--text-muted);">No nodes found</td></tr>';
            if (nodesPagination) nodesPagination.innerHTML = '';
        } else {
            const nodesPageSize = window.paginationState.nodes.pageSize;
            const nodesTotalPages = Math.max(1, Math.ceil(allNodes.length / nodesPageSize));
            if (window.paginationState.nodes.currentPage > nodesTotalPages) {
                window.paginationState.nodes.currentPage = nodesTotalPages;
            }
            const nodesStartIdx = (window.paginationState.nodes.currentPage - 1) * nodesPageSize;
            const nodesPageData = allNodes.slice(nodesStartIdx, nodesStartIdx + nodesPageSize);
            
            nodesBody.innerHTML = nodesPageData.map(n => `
                <tr>
                    <td class="mono-text">${n.name}</td>
                    <td><span class="badge ${n.status === 'Ready' ? 'success' : 'danger'}">${n.status}</span></td>
                    <td>${n.version}</td>
                    <td>${n.pods_count}</td>
                    <td>${n.age}</td>
                    <td class="actions-cell">
                        <div class="actions-cell-container">
                            <button class="action-btn" onclick="navigateToDetails('node', '_', '${n.name}')">
                                <i class="fa-solid fa-circle-info"></i> Details
                            </button>
                        </div>
                    </td>
                </tr>
            `).join('');
            if (nodesPagination) {
                nodesPagination.innerHTML = renderPaginationHTML('nodes', allNodes.length);
            }
        }
    }

    const allDeps = currentData.deployments || [];
    const filteredDeps = ns === "all" ? allDeps : allDeps.filter(d => d.namespace === ns);
    const badgeDeps = document.getElementById('badge-deployments');
    if (badgeDeps) badgeDeps.textContent = filteredDeps.length;
    
    const depsBody = document.getElementById('deployments-table-body');
    const depsPagination = document.getElementById('deployments-pagination');
    if (depsBody) {
        if (filteredDeps.length === 0) {
            depsBody.innerHTML = '<tr><td colspan="6" style="text-align: center; color: var(--text-muted);">No deployments found</td></tr>';
            if (depsPagination) depsPagination.innerHTML = '';
        } else {
            const depsPageSize = window.paginationState.deployments.pageSize;
            const depsTotalPages = Math.max(1, Math.ceil(filteredDeps.length / depsPageSize));
            if (window.paginationState.deployments.currentPage > depsTotalPages) {
                window.paginationState.deployments.currentPage = depsTotalPages;
            }
            const depsStartIdx = (window.paginationState.deployments.currentPage - 1) * depsPageSize;
            const depsPageData = filteredDeps.slice(depsStartIdx, depsStartIdx + depsPageSize);
            
            depsBody.innerHTML = depsPageData.map(d => `
                <tr>
                    <td class="mono-text">${d.name}</td>
                    <td class="mono-text">${d.namespace}</td>
                    <td>${d.replicas}</td>
                    <td>${d.ready}</td>
                    <td>${d.available}</td>
                    <td class="actions-cell">
                        <div class="actions-cell-container">
                            <button class="action-btn" onclick="navigateToDetails('deployment', '${d.namespace}', '${d.name}')">
                                <i class="fa-solid fa-circle-info"></i> Details
                            </button>
                        </div>
                    </td>
                </tr>
            `).join('');
            if (depsPagination) {
                depsPagination.innerHTML = renderPaginationHTML('deployments', filteredDeps.length);
            }
        }
    }
    
    const allSvcs = currentData.services || [];
    const filteredSvcs = ns === "all" ? allSvcs : allSvcs.filter(s => s.namespace === ns);
    const badgeSvcs = document.getElementById('badge-services');
    if (badgeSvcs) badgeSvcs.textContent = filteredSvcs.length;
    
    const svcsBody = document.getElementById('services-table-body');
    const svcsPagination = document.getElementById('services-pagination');
    if (svcsBody) {
        if (filteredSvcs.length === 0) {
            svcsBody.innerHTML = '<tr><td colspan="6" style="text-align: center; color: var(--text-muted);">No services found</td></tr>';
            if (svcsPagination) svcsPagination.innerHTML = '';
        } else {
            const svcsPageSize = window.paginationState.services.pageSize;
            const svcsTotalPages = Math.max(1, Math.ceil(filteredSvcs.length / svcsPageSize));
            if (window.paginationState.services.currentPage > svcsTotalPages) {
                window.paginationState.services.currentPage = svcsTotalPages;
            }
            const svcsStartIdx = (window.paginationState.services.currentPage - 1) * svcsPageSize;
            const svcsPageData = filteredSvcs.slice(svcsStartIdx, svcsStartIdx + svcsPageSize);
            
            svcsBody.innerHTML = svcsPageData.map(s => {
                const ports = s.ports.map(p => `${p.port}:${p.target}/${p.protocol}`).join(', ');
                return `
                    <tr>
                        <td class="mono-text">${s.name}</td>
                        <td class="mono-text">${s.namespace}</td>
                        <td><span class="badge info">${s.type}</span></td>
                        <td class="mono-text">${s.cluster_ip}</td>
                        <td class="mono-text">${ports}</td>
                        <td class="actions-cell">
                            <div class="actions-cell-container">
                                <button class="action-btn" onclick="navigateToDetails('service', '${s.namespace}', '${s.name}')">
                                    <i class="fa-solid fa-circle-info"></i> Details
                                </button>
                            </div>
                        </td>
                    </tr>
                `;
            }).join('');
            if (svcsPagination) {
                svcsPagination.innerHTML = renderPaginationHTML('services', filteredSvcs.length);
            }
        }
    }
    
    const badgeEvents = document.getElementById('badge-events');
    if (badgeEvents) {
        const events = currentData.events || [];
        const nsEvents = ns === "all" ? events : events.filter(e => e.namespace === ns);
        badgeEvents.textContent = nsEvents.length;
    }
    
    renderEventsTable();
    
    if (currentDetailResource) {
        const { type, namespace, name } = currentDetailResource;
        if (type === 'pod') {
            const pod = allPods.find(p => p.name === name && p.namespace === namespace);
            if (pod) {
                const statusBadge = document.getElementById('detail-pod-status-badge');
                if (statusBadge) {
                    statusBadge.textContent = pod.status;
                    statusBadge.className = `badge ${pod.status === 'Running' ? 'success' : (pod.status === 'Pending' ? 'warning' : 'danger')}`;
                }
                const restartsVal = document.getElementById('detail-pod-restarts');
                if (restartsVal) {
                    restartsVal.textContent = pod.restarts;
                }
            }
        } else if (type === 'deployment') {
            const dep = allDeps.find(d => d.name === name && d.namespace === namespace);
            if (dep) {
                const replicasVal = document.getElementById('detail-dep-replicas');
                const readyVal = document.getElementById('detail-dep-ready');
                const availableVal = document.getElementById('detail-dep-available');
                const progressBar = document.getElementById('detail-dep-progress-bar');
                const statusBadge = document.getElementById('detail-dep-status-badge');
                
                if (replicasVal) replicasVal.textContent = dep.replicas;
                if (readyVal) readyVal.textContent = dep.ready;
                if (availableVal) availableVal.textContent = dep.available;
                
                const pct = dep.replicas > 0 ? Math.round((dep.ready / dep.replicas) * 100) : 0;
                if (progressBar) progressBar.style.width = `${pct}%`;
                
                if (statusBadge) {
                    statusBadge.textContent = `${dep.ready} / ${dep.replicas} ready`;
                    statusBadge.className = `badge ${dep.ready === dep.replicas ? 'success' : 'warning'}`;
                }
            }
        }
    }
}

function connectWebSocket() {
    const loc = window.location;
    const wsProtocol = loc.protocol === "https:" ? "wss:" : "ws:";
    const wsUrl = `${wsProtocol}//${loc.host}/ws`;
    
    const ws = new WebSocket(wsUrl);
    const statusDiv = document.getElementById('connection-status');
    const statusText = document.getElementById('connection-text');
    
    ws.onopen = () => {
        if (statusDiv) statusDiv.className = "connection-status";
        if (statusText) statusText.textContent = "WebSocket Active";
        loadNamespaces();
    };
    
    ws.onmessage = (event) => {
        const msg = JSON.parse(event.data);
        if (msg.type === "state_update" || msg.type === "initial_state") {
            currentData = msg.data;
            if (currentData && currentData.pods) {
                checkPodStatusChanges(currentData.pods);
            }
            renderUI();
        }
    };
    
    ws.onclose = () => {
        if (statusDiv) statusDiv.className = "connection-status disconnected";
        if (statusText) statusText.textContent = "Disconnected (Reconnecting...)";
        setTimeout(connectWebSocket, 3000);
    };
    
    ws.onerror = () => {
        ws.close();
    };
}

function handleRouting() {
    const path = window.location.pathname;
    const parts = path.split('/').filter(Boolean);
    if (parts.length === 3) {
        const [type, namespace, name] = parts;
        if (['pod', 'deployment', 'service'].includes(type)) {
            navigateToDetails(type, namespace, name, true);
            return;
        }
    }
    goBackToDashboard(true);
}

function copyLabelsToClipboard(base64Labels) {
    try {
        const labels = JSON.parse(atob(base64Labels));
        const text = Object.entries(labels).map(([k, v]) => `${k}=${v}`).join(', ');
        navigator.clipboard.writeText(text).then(() => {
            showToast('success', 'Labels copied to clipboard!');
        }).catch(err => {
            console.error("Failed to copy labels: ", err);
            showToast('error', 'Failed to copy labels: ' + err);
        });
    } catch (e) {
        console.error("Error parsing labels: ", e);
    }
}

document.addEventListener('DOMContentLoaded', () => {
    const nsSelect = document.getElementById('namespace-select');
    if (nsSelect) {
        nsSelect.addEventListener('change', (e) => {
            activeNamespace = e.target.value;
            window.paginationState.pods.currentPage = 1;
            window.paginationState.deployments.currentPage = 1;
            window.paginationState.services.currentPage = 1;
            window.paginationState.events.currentPage = 1;
            renderUI();
        });
    }
    
    initWelcomeBanner();
    initChart();
    connectWebSocket();
    
    window.addEventListener('popstate', handleRouting);
    handleRouting();
    
    fetch('/api/overview')
        .then(r => r.json())
        .then(o => {
            if (!currentData) {
                currentData = {
                    overview: o,
                    pods: [],
                    deployments: [],
                    services: [],
                    events: []
                };
            } else {
                currentData.overview = o;
            }
            renderUI();
        }).catch(() => {});
});