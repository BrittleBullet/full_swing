const appBridge = window.fullSwingApp;
const CHANNELS = appBridge?.channels || {};

let config = {};
let defaults = {
  library_path: '',
  download_path: '',
  page_workers: 10,
  gallery_workers: 2,
  api_request_delay: 0.25,
  server_port: 8080
};
let statusTimer = null;
let scanInProgress = false;
let clearInProgress = false;
let clearConfirmPending = false;

function setSavingState(isSaving) {
  const saveButton = document.getElementById('save');
  const resetButton = document.getElementById('reset-defaults');
  const scanButton = document.getElementById('scan-library');
  const clearButton = document.getElementById('clear-library');
  if (saveButton) {
    saveButton.disabled = isSaving;
    saveButton.textContent = isSaving ? 'Saving...' : 'Save';
  }
  if (resetButton) {
    resetButton.disabled = isSaving;
  }
  if (scanButton) {
    scanButton.disabled = isSaving || scanInProgress || clearInProgress;
  }
  if (clearButton) {
    clearButton.disabled = isSaving || scanInProgress || clearInProgress;
  }
}

function setScanState(isScanning) {
  scanInProgress = isScanning;
  const scanButton = document.getElementById('scan-library');
  const scanProgress = document.getElementById('scan-progress');
  if (scanButton) {
    scanButton.disabled = isScanning;
    scanButton.textContent = isScanning ? 'Scanning...' : 'Scan Library';
  }
  if (scanProgress) {
    scanProgress.classList.toggle('active', isScanning);
  }

  const saveButton = document.getElementById('save');
  const resetButton = document.getElementById('reset-defaults');
  const clearButton = document.getElementById('clear-library');
  if (saveButton) {
    saveButton.disabled = isScanning || clearInProgress;
  }
  if (resetButton) {
    resetButton.disabled = isScanning || clearInProgress;
  }
  if (clearButton) {
    clearButton.disabled = isScanning || clearInProgress;
  }
}

function resetClearConfirm() {
  clearConfirmPending = false;
  const clearButton = document.getElementById('clear-library');
  if (clearButton && !clearInProgress) {
    clearButton.textContent = 'Clear Library';
  }
}

function setClearState(isClearing) {
  clearInProgress = isClearing;
  const clearButton = document.getElementById('clear-library');
  if (clearButton) {
    clearButton.disabled = isClearing;
    clearButton.textContent = isClearing ? 'Clearing...' : (clearConfirmPending ? 'Are you sure?' : 'Clear Library');
  }

  const scanButton = document.getElementById('scan-library');
  const saveButton = document.getElementById('save');
  const resetButton = document.getElementById('reset-defaults');
  if (scanButton) {
    scanButton.disabled = isClearing || scanInProgress;
  }
  if (saveButton) {
    saveButton.disabled = isClearing;
  }
  if (resetButton) {
    resetButton.disabled = isClearing;
  }
}

document.addEventListener('DOMContentLoaded', () => {
  populateForm(defaults);

  appBridge?.on(CHANNELS.SETTINGS_LOAD_CONFIG, (payload) => {
    if (payload?.defaults && typeof payload.defaults === 'object') {
      defaults = { ...defaults, ...payload.defaults };
    }

    config = payload?.config && typeof payload.config === 'object'
      ? payload.config
      : (payload || {});

    populateForm();
    setSavingState(false);
    setStatus('');
  });

  appBridge?.on(CHANNELS.SETTINGS_SAVE_RESULT, (result) => {
    if (result?.defaults && typeof result.defaults === 'object') {
      defaults = { ...defaults, ...result.defaults };
    }

    if (result?.config && typeof result.config === 'object') {
      config = result.config;
      populateForm();
    }

    setSavingState(false);
    setStatus(result?.message || 'Settings saved.', !result?.ok, result?.ok ? 4000 : 0);
  });

  document.getElementById('save').addEventListener('click', saveConfig);
  document.getElementById('reset-defaults').addEventListener('click', resetDefaults);
  document.getElementById('library-path').addEventListener('click', selectLibraryPath);
  document.getElementById('scan-library').addEventListener('click', scanLibrary);
  document.getElementById('clear-library').addEventListener('click', clearLibrary);
  document.getElementById('download-path').addEventListener('click', selectDownloadPath);
  document.getElementById('minimize-window').addEventListener('click', () => appBridge?.send(CHANNELS.SETTINGS_MINIMIZE));
  document.getElementById('close-window').addEventListener('click', () => appBridge?.send(CHANNELS.SETTINGS_CLOSE));
});

function setStatus(message, isError = false, autoClearMs = 0) {
  const status = document.getElementById('status-message');
  if (statusTimer) {
    clearTimeout(statusTimer);
    statusTimer = null;
  }

  status.textContent = message || '';
  status.classList.toggle('busy', !isError && Boolean(message) && scanInProgress);
  status.classList.toggle('error', isError);

  if (!isError && message && autoClearMs > 0) {
    statusTimer = setTimeout(() => {
      status.textContent = '';
      status.classList.remove('busy');
      status.classList.remove('error');
      statusTimer = null;
    }, autoClearMs);
  }
}

function populateForm(values = config) {
  document.getElementById('library-path-input').value = values.library_path || defaults.library_path || '';
  document.getElementById('download-path-input').value = values.download_path || defaults.download_path || '';
  document.getElementById('page-workers').value = values.page_workers || defaults.page_workers;
  document.getElementById('gallery-workers').value = values.gallery_workers || defaults.gallery_workers;
  document.getElementById('api-delay').value = values.api_request_delay ?? defaults.api_request_delay;
  document.getElementById('server-port').value = values.server_port || defaults.server_port;
}

function resetDefaults() {
  const confirmed = window.confirm('Reset all settings to their default values?');
  if (!confirmed) {
    return;
  }

  populateForm(defaults);
  setStatus('Resetting settings to defaults...');
  saveConfig();
}

async function selectLibraryPath() {
  try {
    const currentPath = document.getElementById('library-path-input').value.trim();
    const selectedPath = await appBridge.invoke(CHANNELS.SETTINGS_SELECT_LIBRARY_PATH, currentPath);

    if (selectedPath) {
      document.getElementById('library-path-input').value = selectedPath;
      setStatus('');
    }
  } catch (error) {
    setStatus(`Could not open folder picker: ${error.message}`, true);
  }
}

async function selectDownloadPath() {
  try {
    const currentPath = document.getElementById('download-path-input').value.trim();
    const selectedPath = await appBridge.invoke(CHANNELS.SETTINGS_SELECT_DOWNLOAD_PATH, currentPath);

    if (selectedPath) {
      document.getElementById('download-path-input').value = selectedPath;
      setStatus('');
    }
  } catch (error) {
    setStatus(`Could not open folder picker: ${error.message}`, true);
  }
}

async function scanLibrary() {
  if (scanInProgress) {
    return;
  }

  resetClearConfirm();

  const port = parseInt(document.getElementById('server-port').value, 10)
    || parseInt(config?.server_port, 10)
    || defaults.server_port
    || 8080;

  setScanState(true);
  setStatus('Scanning library... this can take a while for large folders.');

  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/migrate`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      }
    });

    let payload = null;
    try {
      payload = await response.json();
    } catch {
      payload = null;
    }

    if (response.ok) {
      setStatus(`Imported ${Number(payload?.inserted || 0)} galleries`, false, 5000);
      return;
    }

    if (response.status === 409) {
      setStatus('Already imported — clear owned table first to reimport', true);
      return;
    }

    setStatus('Scan failed — check logs', true);
  } catch {
    setStatus('Scan failed — check logs', true);
  } finally {
    setScanState(false);
    setSavingState(false);
  }
}

async function clearLibrary() {
  if (clearInProgress) {
    return;
  }

  if (!clearConfirmPending) {
    clearConfirmPending = true;
    const clearButton = document.getElementById('clear-library');
    if (clearButton) {
      clearButton.textContent = 'Are you sure?';
    }
    setStatus('Click Clear Library again to delete all imported library records.', true);
    return;
  }

  const port = parseInt(document.getElementById('server-port').value, 10)
    || parseInt(config?.server_port, 10)
    || defaults.server_port
    || 8080;

  setClearState(true);
  setStatus('');

  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/owned`, {
      method: 'DELETE'
    });

    let payload = null;
    try {
      payload = await response.json();
    } catch {
      payload = null;
    }

    if (response.ok) {
      setStatus(`Cleared ${Number(payload?.cleared || 0)} galleries. Scan Library is available again.`, false, 5000);
      return;
    }

    setStatus('Clear failed — check logs', true);
  } catch {
    setStatus('Clear failed — check logs', true);
  } finally {
    resetClearConfirm();
    setClearState(false);
    setSavingState(false);
  }
}

function saveConfig() {
  resetClearConfirm();
  config = {
    ...config,
    library_path: document.getElementById('library-path-input').value.trim(),
    download_path: document.getElementById('download-path-input').value.trim(),
    page_workers: parseInt(document.getElementById('page-workers').value, 10),
    gallery_workers: parseInt(document.getElementById('gallery-workers').value, 10),
    api_request_delay: parseFloat(document.getElementById('api-delay').value),
    server_port: parseInt(document.getElementById('server-port').value, 10)
  };

  delete config.image_request_delay;
  delete config.download_delay;

  if (!config.library_path) {
    setStatus('Library path is required.', true);
    document.getElementById('library-path-input').focus();
    return;
  }

  setSavingState(true);
  setStatus('Saving settings...');

  const sent = appBridge?.send(CHANNELS.SETTINGS_SAVE_CONFIG, config);
  if (!sent) {
    setSavingState(false);
    setStatus('Unable to save settings in this window.', true);
  }
}