const appBridge = window.fullSwingApp;
const CHANNELS = appBridge?.channels || {};

const state = {
  running: false,
  downloading: false,
  port: 8080,
  version: '1.0.0',
  visible: false,
  activeDownload: null,
  queueCount: 0
};

let statusTimer = null;
let progressStream = null;
let hideResultTimer = null;

const statusPill = document.getElementById('status-pill');
const statusText = document.getElementById('status-text');
const toggleButton = document.getElementById('toggle-backend');
const downloadCard = document.getElementById('download-card');
const downloadTitle = document.getElementById('download-title');
const progressFill = document.getElementById('progress-fill');
const pageCount = document.getElementById('page-count');
const queueCountLabel = document.getElementById('queue-count');
const progressPercent = document.getElementById('progress-percent');
const versionLabel = document.getElementById('app-version');

function clampPercent(value) {
  const numeric = Number(value || 0);
  if (!Number.isFinite(numeric)) {
    return 0;
  }
  return Math.max(0, Math.min(100, Math.round(numeric)));
}

function formatQueueCount(value) {
  const count = Math.max(0, Number(value || 0));
  return `${count} queued`;
}

function normalizeProgress(data) {
  if (!data) {
    return null;
  }

  return {
    gallery_id: data.gallery_id || data.id || '',
    title: data.title || 'Download in progress',
    current_page: Number(data.current_page || 0),
    total_pages: Number(data.total_pages || 0),
    percentage: clampPercent(data.percentage),
    queue_count: Math.max(0, Number(data.queue_count || state.queueCount || 0)),
    status: String(data.status || 'downloading').toLowerCase()
  };
}

function clearResultTimer() {
  if (hideResultTimer) {
    clearTimeout(hideResultTimer);
    hideResultTimer = null;
  }
}

function scheduleHideResult(delay = 2000) {
  clearResultTimer();
  hideResultTimer = setTimeout(() => {
    state.activeDownload = null;
    render();
  }, delay);
}

function renderRunningState() {
  const isDownloading = state.downloading || state.activeDownload?.status === 'downloading';

  statusText.textContent = state.running ? 'Running' : 'Stopped';
  statusPill.classList.toggle('running', state.running);

  toggleButton.textContent = !state.running ? 'Start' : isDownloading ? 'Cancel' : 'Stop';
  toggleButton.classList.remove('start', 'stop');
  toggleButton.classList.add(state.running ? 'stop' : 'start');
}

function renderDownloadState() {
  const download = state.activeDownload;
  const queueCount = Math.max(0, Number(download?.queue_count || state.queueCount || 0));

  if (!download) {
    downloadCard.dataset.state = 'idle';
    downloadTitle.textContent = 'No active download';
    progressFill.style.width = '0%';
    pageCount.textContent = state.running ? 'Waiting for the next job' : 'Start the app to begin';
    queueCountLabel.textContent = formatQueueCount(queueCount);
    progressPercent.textContent = state.running ? 'Ready' : 'Idle';
    return;
  }

  const status = String(download.status || 'downloading').toLowerCase();
  const title = download.title || 'Download in progress';
  const currentPage = Number(download.current_page || 0);
  const totalPages = Number(download.total_pages || 0);
  const percent = clampPercent(download.percentage);

  downloadTitle.textContent = title;
  downloadCard.dataset.state = status;
  queueCountLabel.textContent = formatQueueCount(queueCount);

  if (status === 'failed') {
    progressFill.style.width = '100%';
    pageCount.textContent = 'Failed';
    progressPercent.textContent = 'Open logs';
  } else if (status === 'cancelled') {
    progressFill.style.width = '100%';
    pageCount.textContent = 'Cancelled';
    progressPercent.textContent = 'Stopped';
  } else if (status === 'done') {
    progressFill.style.width = '100%';
    pageCount.textContent = `${currentPage || totalPages} / ${totalPages} pages`;
    progressPercent.textContent = 'Done';
  } else {
    progressFill.style.width = `${percent}%`;
    pageCount.textContent = `${currentPage} / ${totalPages} pages`;
    progressPercent.textContent = `${percent}%`;
  }
}

function render() {
  renderRunningState();
  renderDownloadState();
  versionLabel.textContent = `v${state.version || '1.0.0'}`;
}

async function fetchStatus() {
  try {
    const response = await fetch(`http://127.0.0.1:${state.port}/api/status`, { cache: 'no-store' });
    if (!response.ok) {
      throw new Error(`Status request failed: ${response.status}`);
    }

    const data = await response.json();
    state.running = Boolean(data.running);
    state.downloading = Boolean(data.downloading);
    state.queueCount = Math.max(0, Number(data.queue_count || 0));

    if (data.downloading && data.current_job) {
      clearResultTimer();
      state.activeDownload = normalizeProgress(data.current_job);
    } else if (!data.downloading && (!state.activeDownload || state.activeDownload.status === 'downloading')) {
      state.activeDownload = null;
    }

    render();
  } catch {
    if (!state.visible) {
      return;
    }

    state.running = false;
    state.downloading = false;
    state.queueCount = 0;
    if (!state.activeDownload || state.activeDownload.status === 'downloading') {
      state.activeDownload = null;
    }
    render();
  }
}

function disconnectProgressStream() {
  if (progressStream) {
    progressStream.close();
    progressStream = null;
  }
}

function connectProgressStream() {
  disconnectProgressStream();

  progressStream = new EventSource(`http://127.0.0.1:${state.port}/api/download/progress`);

  progressStream.onmessage = (event) => {
    if (!event.data) {
      return;
    }

    try {
      const parsed = JSON.parse(event.data);
      if (!parsed || Object.keys(parsed).length === 0) {
        return;
      }

      const progress = normalizeProgress(parsed);
      state.activeDownload = progress;

      if (progress.status === 'cancelled') {
        state.activeDownload = null;
        clearResultTimer();
      } else if (progress.status === 'done' || progress.status === 'failed') {
        scheduleHideResult();
      } else {
        clearResultTimer();
      }

      render();
    } catch {
      // Ignore malformed SSE payloads.
    }
  };

  progressStream.onerror = () => {
    disconnectProgressStream();
  };
}

function stopWatchingState() {
  if (statusTimer) {
    clearInterval(statusTimer);
    statusTimer = null;
  }
  disconnectProgressStream();
  clearResultTimer();
}

function startWatchingState() {
  stopWatchingState();
  fetchStatus();
  statusTimer = setInterval(fetchStatus, 3000);
  connectProgressStream();
}

appBridge?.on(CHANNELS.TRAY_STATE, (trayState) => {
  state.running = Boolean(trayState.running);
  state.port = Number(trayState.port || 8080);
  state.version = trayState.version || state.version;
  render();

  if (state.visible) {
    startWatchingState();
  }
});

appBridge?.on(CHANNELS.TRAY_VISIBILITY, (visible) => {
  state.visible = Boolean(visible);
  if (state.visible) {
    startWatchingState();
  } else {
    stopWatchingState();
  }
});

document.getElementById('toggle-backend').addEventListener('click', () => {
  const isDownloading = state.downloading || state.activeDownload?.status === 'downloading';

  if (isDownloading) {
    appBridge?.send(CHANNELS.TRAY_CANCEL_DOWNLOADS);
    state.downloading = false;
    state.activeDownload = null;
    clearResultTimer();
  } else if (state.running) {
    appBridge?.send(CHANNELS.TRAY_STOP_BACKEND);
    state.running = false;
    state.activeDownload = null;
  } else {
    appBridge?.send(CHANNELS.TRAY_START_BACKEND);
    state.running = true;
  }
  render();
});

document.getElementById('open-settings').addEventListener('click', () => {
  appBridge?.send(CHANNELS.TRAY_OPEN_SETTINGS);
});

document.getElementById('open-logs').addEventListener('click', () => {
  appBridge?.send(CHANNELS.TRAY_OPEN_LOGS);
});

document.getElementById('open-browse').addEventListener('click', () => {
  appBridge?.send(CHANNELS.TRAY_OPEN_BROWSE);
});

document.getElementById('quit-app').addEventListener('click', () => {
  appBridge?.send(CHANNELS.TRAY_QUIT);
});

window.addEventListener('beforeunload', () => {
  stopWatchingState();
});

render();
