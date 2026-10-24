// banuerllm UI state & API interaction
const API_BASE = window.location.origin;

let masterKey = localStorage.getItem('banuerllm_master_key') || '';
let currentTab = 'providers';
let logRefreshTimer = null;

// DOM Elements
const authBanner = document.getElementById('auth-banner');
const authForm = document.getElementById('auth-form');
const masterKeyInput = document.getElementById('master-key-input');
const authBtn = document.getElementById('auth-btn');
const mainView = document.getElementById('main-view');
const gatewayStatus = document.getElementById('gateway-status');

// Providers DOM
const providersList = document.getElementById('providers-list');
const providersCount = document.getElementById('providers-count');
const providersTableWrap = document.getElementById('providers-table-wrap');
const providersEmpty = document.getElementById('providers-empty');
const providerModal = document.getElementById('provider-modal');
const providerForm = document.getElementById('provider-form');
const providerModalTitle = document.getElementById('provider-modal-title');
const provIdInput = document.getElementById('prov-id');
const provNameInput = document.getElementById('prov-name');
const provBaseUrlInput = document.getElementById('prov-base-url');
const provApiKeyInput = document.getElementById('prov-api-key');
const provModelsInput = document.getElementById('prov-models');
const provPriorityInput = document.getElementById('prov-priority');
const provActiveInput = document.getElementById('prov-active');
const fetchModelsBtn = document.getElementById('fetch-models-btn');
const fetchModelsFeedback = document.getElementById('fetch-models-feedback');
const testProvBtn = document.getElementById('test-prov-btn');
const testProvResult = document.getElementById('test-prov-result');

// Keys DOM
const keysList = document.getElementById('keys-list');
const keysCount = document.getElementById('keys-count');
const keysTableWrap = document.getElementById('keys-table-wrap');
const keysEmpty = document.getElementById('keys-empty');
const keyModal = document.getElementById('key-modal');
const keyForm = document.getElementById('key-form');
const keyNameInput = document.getElementById('key-name');
const newKeyBanner = document.getElementById('new-key-banner');
const newKeyDisplay = document.getElementById('new-key-display');
const copyNewKeyBtn = document.getElementById('copy-new-key-btn');
const closeNewKeyBtn = document.getElementById('close-new-key-btn');

// Logs DOM
const logsList = document.getElementById('logs-list');
const logsCount = document.getElementById('logs-count');
const logsTableWrap = document.getElementById('logs-table-wrap');
const logsEmpty = document.getElementById('logs-empty');
const autoRefreshLogs = document.getElementById('auto-refresh-logs');
const refreshLogsBtn = document.getElementById('refresh-logs-btn');

// Settings DOM
const keepaliveForm = document.getElementById('keepalive-form');
const keepaliveUrlInput = document.getElementById('keepalive-url');
const keepaliveLastTime = document.getElementById('keepalive-last-time');
const endpointUrlDisplay = document.getElementById('endpoint-url-display');
const copyEndpointBtn = document.getElementById('copy-endpoint-btn');
const activeMasterKeyDisplay = document.getElementById('active-master-key-display');
const forgetMasterKeyBtn = document.getElementById('forget-master-key-btn');

// Helper API Fetch with Admin Token
async function apiFetch(endpoint, options = {}) {
  const headers = {
    'Content-Type': 'application/json',
    ...(options.headers || {})
  };

  if (masterKey) {
    headers['Authorization'] = `Bearer ${masterKey}`;
  }

  const res = await fetch(`${API_BASE}${endpoint}`, {
    ...options,
    headers
  });

  if (res.status === 401) {
    showAuthBarrier(true);
    throw new Error('Unauthorized');
  }

  return res;
}

// Auth Barrier Management
function showAuthBarrier(show) {
  if (show) {
    authBanner.hidden = false;
    mainView.hidden = true;
    authBtn.textContent = 'Войти';
    gatewayStatus.textContent = 'требуется ключ';
    gatewayStatus.className = 'brand-status error';
  } else {
    authBanner.hidden = false;
    authBanner.hidden = true;
    mainView.hidden = false;
    authBtn.textContent = 'Ключ активен';
    gatewayStatus.textContent = 'готов';
    gatewayStatus.className = 'brand-status live';
  }
}

authForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const inputKey = masterKeyInput.value.trim();
  if (!inputKey) return;

  try {
    const res = await fetch(`${API_BASE}/api/auth/check`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${inputKey}` }
    });
    const data = await res.json();
    if (data.valid) {
      masterKey = inputKey;
      localStorage.setItem('banuerllm_master_key', masterKey);
      masterKeyInput.value = '';
      showAuthBarrier(false);
      updateActiveKeyDisplay();
      refreshAll();
    } else {
      alert('Неверный мастер-ключ');
    }
  } catch {
    alert('Ошибка проверки ключа на сервере');
  }
});

authBtn.addEventListener('click', () => {
  showAuthBarrier(!authBanner.hidden ? false : true);
});

forgetMasterKeyBtn.addEventListener('click', () => {
  localStorage.removeItem('banuerllm_master_key');
  masterKey = '';
  updateActiveKeyDisplay();
  showAuthBarrier(true);
});

function updateActiveKeyDisplay() {
  if (masterKey) {
    activeMasterKeyDisplay.textContent = masterKey.slice(0, 10) + '...' + masterKey.slice(-4);
  } else {
    activeMasterKeyDisplay.textContent = 'не задан';
  }
}

// Navigation Tabs
document.querySelectorAll('.nav-tab').forEach(tab => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.nav-tab').forEach(t => {
      t.classList.remove('active');
      t.setAttribute('aria-selected', 'false');
    });
    tab.classList.add('active');
    tab.setAttribute('aria-selected', 'true');

    currentTab = tab.dataset.tab;
    document.querySelectorAll('.tab-pane').forEach(pane => {
      pane.hidden = pane.id !== `pane-${currentTab}`;
    });

    if (currentTab === 'logs') {
      loadLogs();
    } else if (currentTab === 'keys') {
      loadKeys();
    } else if (currentTab === 'providers') {
      loadProviders();
    } else if (currentTab === 'settings') {
      loadStatus();
    }
  });
});

// Providers Logic
async function loadProviders() {
  try {
    const res = await apiFetch('/api/providers');
    const providers = await res.json();
    providersCount.textContent = String(providers.length);

    if (providers.length === 0) {
      providersTableWrap.hidden = true;
      providersEmpty.hidden = false;
      return;
    }

    providersTableWrap.hidden = false;
    providersEmpty.hidden = true;

    providersList.innerHTML = providers.map(p => {
      const models = Array.isArray(p.models) ? p.models : [];
      const modelTags = models.slice(0, 4).map(m => `<span class="model-tag">${escapeHtml(m)}</span>`).join('');
      const moreModels = models.length > 4 ? `<span class="model-tag">+${models.length - 4}</span>` : '';

      return `
        <tr data-id="${p.id}">
          <td><strong>${escapeHtml(p.name)}</strong></td>
          <td><code class="num">${escapeHtml(p.base_url)}</code></td>
          <td><code class="num">${escapeHtml(p.api_key_masked)}</code></td>
          <td>${modelTags}${moreModels}</td>
          <td class="num">${p.priority}</td>
          <td>
            <span class="status-pill ${p.is_active ? 'active' : 'inactive'}">
              ${p.is_active ? 'активен' : 'отключен'}
            </span>
          </td>
          <td class="col-actions">
            <button class="btn btn-secondary btn-xs btn-sync-prov" data-id="${p.id}">Синхр.</button>
            <button class="btn btn-secondary btn-xs btn-test-prov" data-id="${p.id}" data-url="${escapeHtml(p.base_url)}">Тест</button>
            <button class="btn btn-secondary btn-xs btn-edit-prov" data-id="${p.id}">Изменить</button>
            <button class="btn btn-danger btn-xs btn-delete-prov" data-id="${p.id}">Удалить</button>
          </td>
        </tr>
      `;
    }).join('');

    bindProviderActions(providers);
  } catch (err) {
    console.error('Failed to load providers:', err);
  }
}

function bindProviderActions(providers) {
  document.querySelectorAll('.btn-delete-prov').forEach(btn => {
    btn.addEventListener('click', async () => {
      const id = btn.dataset.id;
      if (!confirm('Удалить этого провайдера?')) return;
      await apiFetch(`/api/providers/${id}`, { method: 'DELETE' });
      loadProviders();
    });
  });

  document.querySelectorAll('.btn-edit-prov').forEach(btn => {
    btn.addEventListener('click', () => {
      const id = btn.dataset.id;
      const prov = providers.find(p => p.id === id);
      if (!prov) return;

      providerModalTitle.textContent = 'Редактировать провайдера';
      provIdInput.value = prov.id;
      provNameInput.value = prov.name;
      provBaseUrlInput.value = prov.base_url;
      provApiKeyInput.value = '';
      provApiKeyInput.placeholder = 'Оставьте пустым, чтобы не менять';
      provApiKeyInput.required = false;
      provModelsInput.value = (prov.models || []).join(', ');
      provPriorityInput.value = prov.priority || 0;
      provActiveInput.checked = Boolean(prov.is_active);
      testProvResult.textContent = '';
      fetchModelsFeedback.textContent = '';

      providerModal.showModal();
    });
  });

  document.querySelectorAll('.btn-sync-prov').forEach(btn => {
    btn.addEventListener('click', async () => {
      const origText = btn.textContent;
      btn.textContent = '...';
      btn.disabled = true;
      try {
        const res = await apiFetch(`/api/providers/${btn.dataset.id}/sync`, { method: 'POST' });
        const data = await res.json();
        if (data.ok) {
          alert(`Синхронизировано: ${data.count} моделей`);
          loadProviders();
        } else {
          alert('Сбой синхронизации');
        }
      } catch {
        alert('Ошибка при синхронизации моделей');
      } finally {
        btn.textContent = origText;
        btn.disabled = false;
      }
    });
  });

  document.querySelectorAll('.btn-test-prov').forEach(btn => {
    btn.addEventListener('click', async () => {
      const origText = btn.textContent;
      btn.textContent = '...';
      btn.disabled = true;
      const id = btn.dataset.id;
      const prov = providers.find(p => p.id === id);
      if (!prov) return;

      try {
        const res = await apiFetch('/api/providers/test', {
          method: 'POST',
          body: JSON.stringify({ base_url: prov.base_url, api_key: prov.api_key })
        });
        const data = await res.json();
        if (data.ok) {
          alert(`Успех: ${data.latency_ms}ms · доступно моделей: ${data.models.length}`);
        } else {
          alert(`Ошибка: статус ${data.status} · ${data.error || 'не удалось подключиться'}`);
        }
      } catch (e) {
        alert('Ошибка при выполнении теста');
      } finally {
        btn.textContent = origText;
        btn.disabled = false;
      }
    });
  });
}

// Add/Edit Provider Modal
document.getElementById('open-add-provider-btn').addEventListener('click', openAddProviderModal);
document.getElementById('empty-add-provider-btn').addEventListener('click', openAddProviderModal);

function openAddProviderModal() {
  providerModalTitle.textContent = 'Новый провайдер';
  provIdInput.value = '';
  provNameInput.value = '';
  provBaseUrlInput.value = '';
  provApiKeyInput.value = '';
  provApiKeyInput.placeholder = 'sk-...';
  provApiKeyInput.required = true;
  provModelsInput.value = '*';
  provPriorityInput.value = '0';
  provActiveInput.checked = true;
  testProvResult.textContent = '';
  fetchModelsFeedback.textContent = '';
  providerModal.showModal();
}

document.getElementById('close-provider-modal-btn').addEventListener('click', () => providerModal.close());
document.getElementById('cancel-provider-btn').addEventListener('click', () => providerModal.close());

providerForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const id = provIdInput.value;
  const modelsRaw = provModelsInput.value.split(',').map(m => m.trim()).filter(Boolean);

  const payload = {
    name: provNameInput.value.trim(),
    base_url: provBaseUrlInput.value.trim(),
    models: modelsRaw.length ? modelsRaw : ['*'],
    priority: Number(provPriorityInput.value) || 0,
    is_active: provActiveInput.checked ? 1 : 0
  };

  if (provApiKeyInput.value.trim()) {
    payload.api_key = provApiKeyInput.value.trim();
  }

  try {
    if (id) {
      await apiFetch(`/api/providers/${id}`, {
        method: 'PUT',
        body: JSON.stringify(payload)
      });
    } else {
      await apiFetch('/api/providers', {
        method: 'POST',
        body: JSON.stringify(payload)
      });
    }
    providerModal.close();
    loadProviders();
  } catch (err) {
    alert('Не удалось сохранить провайдера');
  }
});

// Fetch Models Directly from Endpoint
fetchModelsBtn.addEventListener('click', async () => {
  const baseUrl = provBaseUrlInput.value.trim();
  const apiKey = provApiKeyInput.value.trim();

  if (!baseUrl) {
    fetchModelsFeedback.textContent = 'Укажите базовый URL';
    fetchModelsFeedback.className = 'field-feedback';
    return;
  }

  fetchModelsFeedback.textContent = 'Загрузка списка моделей...';
  fetchModelsFeedback.className = 'field-feedback';

  try {
    const res = await apiFetch('/api/providers/test', {
      method: 'POST',
      body: JSON.stringify({
        base_url: baseUrl,
        api_key: apiKey || 'test',
        name: provNameInput.value.trim()
      })
    });
    const data = await res.json();
    if (data.ok && data.models && data.models.length > 0) {
      provModelsInput.value = data.models.join(', ');
      fetchModelsFeedback.textContent = `Загружено моделей: ${data.models.length}`;
      fetchModelsFeedback.className = 'field-feedback';
    } else {
      fetchModelsFeedback.textContent = data.error || 'Модели не найдены';
    }
  } catch (e) {
    fetchModelsFeedback.textContent = 'Сетевая ошибка при запросе';
  }
});

// Test in modal
testProvBtn.addEventListener('click', async () => {
  const baseUrl = provBaseUrlInput.value.trim();
  const apiKey = provApiKeyInput.value.trim();

  if (!baseUrl) {
    testProvResult.textContent = 'Укажите URL';
    testProvResult.className = 'test-result-indicator fail';
    return;
  }

  testProvResult.textContent = 'Проверка...';
  testProvResult.className = 'test-result-indicator';

  try {
    const res = await apiFetch('/api/providers/test', {
      method: 'POST',
      body: JSON.stringify({ base_url: baseUrl, api_key: apiKey })
    });
    const data = await res.json();
    if (data.ok) {
      testProvResult.textContent = `OK (${data.latency_ms}ms)`;
      testProvResult.className = 'test-result-indicator ok';
    } else {
      testProvResult.textContent = `Ошибка ${data.status}`;
      testProvResult.className = 'test-result-indicator fail';
    }
  } catch {
    testProvResult.textContent = 'Сбой сети';
    testProvResult.className = 'test-result-indicator fail';
  }
});

// Virtual Keys Logic
async function loadKeys() {
  try {
    const res = await apiFetch('/api/keys');
    const keys = await res.json();
    keysCount.textContent = String(keys.length);

    if (keys.length === 0) {
      keysTableWrap.hidden = true;
      keysEmpty.hidden = false;
      return;
    }

    keysTableWrap.hidden = false;
    keysEmpty.hidden = true;

    keysList.innerHTML = keys.map(k => {
      const createdDate = new Date(k.created_at).toLocaleString('ru-RU');
      const lastUsed = k.last_used_at ? new Date(k.last_used_at).toLocaleString('ru-RU') : 'никогда';

      return `
        <tr>
          <td><strong>${escapeHtml(k.name)}</strong></td>
          <td><code class="num">${escapeHtml(k.key_prefix)}</code></td>
          <td class="num">${createdDate}</td>
          <td class="num">${lastUsed}</td>
          <td class="col-actions">
            <button class="btn btn-danger btn-xs btn-delete-key" data-id="${k.id}">Удалить</button>
          </td>
        </tr>
      `;
    }).join('');

    document.querySelectorAll('.btn-delete-key').forEach(btn => {
      btn.addEventListener('click', async () => {
        if (!confirm('Отозвать и удалить этот ключ?')) return;
        await apiFetch(`/api/keys/${btn.dataset.id}`, { method: 'DELETE' });
        loadKeys();
      });
    });
  } catch (err) {
    console.error('Failed to load keys:', err);
  }
}

document.getElementById('open-add-key-btn').addEventListener('click', () => {
  keyNameInput.value = '';
  keyModal.showModal();
});
document.getElementById('empty-add-key-btn').addEventListener('click', () => {
  keyNameInput.value = '';
  keyModal.showModal();
});
document.getElementById('close-key-modal-btn').addEventListener('click', () => keyModal.close());
document.getElementById('cancel-key-btn').addEventListener('click', () => keyModal.close());

keyForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const name = keyNameInput.value.trim();
  if (!name) return;

  try {
    const res = await apiFetch('/api/keys', {
      method: 'POST',
      body: JSON.stringify({ name })
    });
    const newKey = await res.json();
    keyModal.close();

    // Show banner with full raw key
    newKeyDisplay.textContent = newKey.key;
    newKeyBanner.hidden = false;
    loadKeys();
  } catch {
    alert('Не удалось создать ключ');
  }
});

copyNewKeyBtn.addEventListener('click', () => {
  navigator.clipboard.writeText(newKeyDisplay.textContent);
  copyNewKeyBtn.textContent = 'Скопировано';
  setTimeout(() => { copyNewKeyBtn.textContent = 'Скопировать'; }, 2000);
});

closeNewKeyBtn.addEventListener('click', () => {
  newKeyBanner.hidden = true;
});

// Logs Logic
async function loadLogs() {
  try {
    const res = await apiFetch('/api/logs');
    const logs = await res.json();
    logsCount.textContent = String(logs.length);

    if (logs.length === 0) {
      logsTableWrap.hidden = true;
      logsEmpty.hidden = false;
      return;
    }

    logsTableWrap.hidden = false;
    logsEmpty.hidden = true;

    logsList.innerHTML = logs.map(l => {
      const timeStr = new Date(l.timestamp).toLocaleTimeString('ru-RU');
      const isOk = l.status_code >= 200 && l.status_code < 300;
      const statusPill = `<span class="status-code-pill ${isOk ? 'ok' : 'bad'}">${l.status_code}</span>`;

      return `
        <tr>
          <td class="num">${timeStr}</td>
          <td><code class="num">${escapeHtml(l.key_name || '—')}</code></td>
          <td><code>${escapeHtml(l.model || '—')}</code></td>
          <td>${escapeHtml(l.provider_name || '—')}</td>
          <td>${statusPill}</td>
          <td class="num">${l.latency_ms}ms</td>
          <td>${l.stream ? 'SSE' : 'JSON'}</td>
        </tr>
      `;
    }).join('');
  } catch (err) {
    console.error('Failed to load logs:', err);
  }
}

refreshLogsBtn.addEventListener('click', loadLogs);

autoRefreshLogs.addEventListener('change', () => {
  if (autoRefreshLogs.checked) {
    startLogTimer();
  } else {
    stopLogTimer();
  }
});

function startLogTimer() {
  stopLogTimer();
  logRefreshTimer = setInterval(() => {
    if (currentTab === 'logs' && !authBanner.hidden) {
      loadLogs();
    }
  }, 3000);
}

function stopLogTimer() {
  if (logRefreshTimer) {
    clearInterval(logRefreshTimer);
    logRefreshTimer = null;
  }
}

// Status & Settings
const systemPromptForm = document.getElementById('system-prompt-form');
const systemPromptMode = document.getElementById('system-prompt-mode');
const globalSystemPrompt = document.getElementById('global-system-prompt');
const gistForm = document.getElementById('gist-form');
const gistTokenInput = document.getElementById('gist-token-input');
const gistPushBtn = document.getElementById('gist-push-btn');
const gistPullBtn = document.getElementById('gist-pull-btn');

async function loadStatus() {
  try {
    const res = await apiFetch('/api/status');
    const data = await res.json();

    keepaliveUrlInput.value = data.keepalive.url || '';
    if (data.keepalive.last_ping) {
      const pingTime = new Date(data.keepalive.last_ping).toLocaleTimeString('ru-RU');
      keepaliveLastTime.textContent = `${pingTime} (код ${data.keepalive.last_status || 200})`;
    } else {
      keepaliveLastTime.textContent = 'еще не выполнялся';
    }

    // Load Settings
    const setRes = await apiFetch('/api/settings');
    const set = await setRes.json();
    systemPromptMode.value = set.system_prompt_mode || 'passthrough';
    globalSystemPrompt.value = set.global_system_prompt || '';
    if (set.github_token_masked) {
      gistTokenInput.placeholder = `Активен: ${set.github_token_masked}`;
    }
  } catch (err) {
    console.error('Failed to load status:', err);
  }
}

systemPromptForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    await apiFetch('/api/settings', {
      method: 'POST',
      body: JSON.stringify({
        system_prompt_mode: systemPromptMode.value,
        global_system_prompt: globalSystemPrompt.value
      })
    });
    alert('Настройки системного промпта сохранены');
  } catch {
    alert('Ошибка сохранения');
  }
});

gistForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const token = gistTokenInput.value.trim();
  if (!token) return;
  try {
    await apiFetch('/api/settings', {
      method: 'POST',
      body: JSON.stringify({ github_token: token })
    });
    gistTokenInput.value = '';
    alert('GitHub Token сохранен, хранилище подключено');
    loadStatus();
    loadProviders();
  } catch {
    alert('Ошибка привязки GitHub Token');
  }
});

gistPushBtn.addEventListener('click', async () => {
  gistPushBtn.disabled = true;
  gistPushBtn.textContent = '...';
  try {
    const res = await apiFetch('/api/sync/gist', {
      method: 'POST',
      body: JSON.stringify({ action: 'push' })
    });
    const data = await res.json();
    alert(data.message);
  } catch {
    alert('Сбой выгрузки в Gist');
  } finally {
    gistPushBtn.disabled = false;
    gistPushBtn.textContent = 'Выгрузить';
  }
});

gistPullBtn.addEventListener('click', async () => {
  gistPullBtn.disabled = true;
  gistPullBtn.textContent = '...';
  try {
    const res = await apiFetch('/api/sync/gist', {
      method: 'POST',
      body: JSON.stringify({ action: 'pull' })
    });
    const data = await res.json();
    alert(data.message);
    loadProviders();
    loadKeys();
  } catch {
    alert('Сбой восстановления из Gist');
  } finally {
    gistPullBtn.disabled = false;
    gistPullBtn.textContent = 'Восстановить';
  }
});

keepaliveForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const url = keepaliveUrlInput.value.trim();
  try {
    await apiFetch('/api/keepalive', {
      method: 'POST',
      body: JSON.stringify({ url })
    });
    alert('URL для Keep-Alive сохранен');
  } catch {
    alert('Ошибка при сохранении');
  }
});

// Copy Endpoint URL
endpointUrlDisplay.textContent = `${API_BASE}/v1`;
copyEndpointBtn.addEventListener('click', () => {
  navigator.clipboard.writeText(`${API_BASE}/v1`);
  copyEndpointBtn.textContent = 'Скопировано';
  setTimeout(() => { copyEndpointBtn.textContent = 'Скопировать'; }, 2000);
});

// Backup & Restore
const exportBackupBtn = document.getElementById('export-backup-btn');
const openImportModalBtn = document.getElementById('open-import-modal-btn');
const importModal = document.getElementById('import-modal');
const importForm = document.getElementById('import-form');
const importJsonInput = document.getElementById('import-json-input');
const closeImportModalBtn = document.getElementById('close-import-modal-btn');
const cancelImportBtn = document.getElementById('cancel-import-btn');

exportBackupBtn.addEventListener('click', async () => {
  try {
    const res = await apiFetch('/api/backup');
    const data = await res.json();
    const jsonStr = JSON.stringify(data, null, 2);

    // Copy to clipboard or trigger download
    await navigator.clipboard.writeText(jsonStr);
    exportBackupBtn.textContent = 'Скопировано в буфер';
    setTimeout(() => { exportBackupBtn.textContent = 'Экспорт (JSON)'; }, 2000);
  } catch {
    alert('Не удалось экспортировать бэкап');
  }
});

openImportModalBtn.addEventListener('click', () => {
  importJsonInput.value = '';
  importModal.showModal();
});
closeImportModalBtn.addEventListener('click', () => importModal.close());
cancelImportBtn.addEventListener('click', () => importModal.close());

importForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  let parsed;
  try {
    parsed = JSON.parse(importJsonInput.value.trim());
  } catch {
    alert('Некорректный JSON');
    return;
  }

  try {
    await apiFetch('/api/backup', {
      method: 'POST',
      body: JSON.stringify(parsed)
    });
    importModal.close();
    alert('Конфигурация успешно восстановлена');
    refreshAll();
  } catch {
    alert('Ошибка при импорте бэкапа');
  }
});

// HTML Escape helper
function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

// Init & Refresh
async function refreshAll() {
  updateActiveKeyDisplay();
  await loadProviders();
  await loadStatus();
  startLogTimer();
}

// Startup check
if (!masterKey) {
  showAuthBarrier(true);
} else {
  // Test stored key
  apiFetch('/api/auth/check', { method: 'POST' })
    .then(res => res.json())
    .then(data => {
      if (data.valid) {
        showAuthBarrier(false);
        refreshAll();
      } else {
        showAuthBarrier(true);
      }
    })
    .catch(() => showAuthBarrier(true));
}
