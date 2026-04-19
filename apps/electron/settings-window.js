const appBridge = window.fullSwingApp;
const CHANNELS = appBridge?.channels || {};

let config = {};

document.addEventListener('DOMContentLoaded', () => {
  appBridge?.on(CHANNELS.SETTINGS_LOAD_CONFIG, (loadedConfig) => {
    config = loadedConfig || {};
    populateForm();
  });

  document.getElementById('save').addEventListener('click', saveConfig);
  document.getElementById('library-path').addEventListener('click', selectLibraryPath);
  document.getElementById('minimize-window').addEventListener('click', () => appBridge?.send(CHANNELS.SETTINGS_MINIMIZE));
  document.getElementById('close-window').addEventListener('click', () => appBridge?.send(CHANNELS.SETTINGS_CLOSE));
});

function setStatus(message, isError = false) {
  const status = document.getElementById('status-message');
  status.textContent = message || '';
  status.classList.toggle('error', isError);
}

function populateForm() {
  document.getElementById('library-path-input').value = config.library_path || '';
  document.getElementById('page-workers').value = config.page_workers || 10;
  document.getElementById('gallery-workers').value = config.gallery_workers || 2;
  document.getElementById('api-delay').value = config.api_request_delay || 0.25;
  document.getElementById('server-port').value = config.server_port || 8080;
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

function saveConfig() {
  config.library_path = document.getElementById('library-path-input').value.trim();
  delete config.download_path;
  delete config.image_request_delay;
  delete config.download_delay;

  if (!config.library_path) {
    setStatus('Library path is required.', true);
    document.getElementById('library-path-input').focus();
    return;
  }

  config.page_workers = parseInt(document.getElementById('page-workers').value, 10);
  config.gallery_workers = parseInt(document.getElementById('gallery-workers').value, 10);
  config.api_request_delay = parseFloat(document.getElementById('api-delay').value);
  config.server_port = parseInt(document.getElementById('server-port').value, 10);

  setStatus('Saving...');
  appBridge?.send(CHANNELS.SETTINGS_SAVE_CONFIG, config);
}