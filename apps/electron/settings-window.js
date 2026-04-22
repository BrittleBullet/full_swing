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

function setSavingState(isSaving) {
  const saveButton = document.getElementById('save');
  const resetButton = document.getElementById('reset-defaults');
  if (saveButton) {
    saveButton.disabled = isSaving;
    saveButton.textContent = isSaving ? 'Saving...' : 'Save';
  }
  if (resetButton) {
    resetButton.disabled = isSaving;
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
  status.classList.toggle('error', isError);

  if (!isError && message && autoClearMs > 0) {
    statusTimer = setTimeout(() => {
      status.textContent = '';
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

function saveConfig() {
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