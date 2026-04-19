const appBridge = window.fullSwingApp;
const CHANNELS = appBridge?.channels || {};

const state = {
  running: false,
  downloading: false,
  paused: false,
  port: 8080,
  version: '1.0.0',
  visible: false,
  activeDownload: null,
  queueCount: 0
};

let statusTimer = null;
let progressStream = null;
let hideResultTimer = null;
let progressReconnectTimer = null;

const statusPill = document.getElementById('status-pill');
const statusText = document.getElementById('status-text');
const toggleButton = document.getElementById('toggle-backend');
const pauseButton = document.getElementById('toggle-downloads');
const downloadCard = document.getElementById('download-card');
const downloadTitle = document.getElementById('download-title');
const progressFill = document.getElementById('progress-fill');
const pageCount = document.getElementById('page-count');
const queueCountLabel = document.getElementById('queue-count');
const progressPercent = document.getElementById('progress-percent');
const batchTimer = document.getElementById('batch-timer');
const galleryTimer = document.getElementById('gallery-timer');
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
    status: String(data.status || 'downloading').toLowerCase(),
    gallery_elapsed_ms: Math.max(0, Number(data.gallery_elapsed_ms || 0)),
    batch_elapsed_ms: Math.max(0, Number(data.batch_elapsed_ms || 0))
  };
}

function formatDuration(ms) {
  const totalSeconds = Math.max(0, Math.floor(Number(ms || 0) / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

function clearResultTimer() {
  if (hideResultTimer) {
    clearTimeout(hideResultTimer);
    hideResultTimer = null;
  }
}

function clearProgressReconnectTimer() {
  if (progressReconnectTimer) {
    clearTimeout(progressReconnectTimer);
    progressReconnectTimer = null;
  }
}

function scheduleHideResult(delay = 2000) {
  clearResultTimer();
  hideResultTimer = setTimeout(() => {
    state.activeDownload = null;
    render();
  }, delay);
}

function isWorkingStatus(status) {
  return ['downloading', 'preparing', 'waiting', 'finalizing'].includes(String(status || '').toLowerCase());
}

function renderRunningState() {
  const isDownloading = state.downloading || isWorkingStatus(state.activeDownload?.status);
  const hasQueuedWork = state.queueCount > 0 || isDownloading;
  const canPause = state.running && !state.paused && hasQueuedWork;
  const canResume = state.running && state.paused && state.queueCount > 0;

  statusText.textContent = !state.running ? 'Stopped' : state.paused ? 'Paused' : isDownloading ? 'Working' : 'Running';
  statusPill.classList.toggle('running', state.running);

  toggleButton.textContent = state.running ? 'Stop' : 'Start';
  toggleButton.classList.remove('start', 'stop');
  toggleButton.classList.add(state.running ? 'stop' : 'start');

  pauseButton.textContent = canResume ? 'Resume' : 'Pause';
  pauseButton.disabled = !(canPause || canResume);
  pauseButton.classList.remove('start', 'stop');
  if (canResume) {
    pauseButton.classList.add('start');
  } else if (canPause) {
    pauseButton.classList.add('stop');
  }
}

function renderDownloadState() {
  const download = state.activeDownload;
  const queueCount = Math.max(0, Number(download?.queue_count || state.queueCount || 0));

  if (!download) {
    const isPaused = state.running && state.paused && queueCount > 0;
    const isPreparing = !isPaused && state.running && (queueCount > 0 || state.downloading);
    downloadCard.dataset.state = isPreparing ? 'preparing' : 'idle';
    downloadTitle.textContent = isPaused ? 'Downloads paused' : isPreparing ? 'Starting download…' : 'No active download';
    progressFill.style.width = isPreparing ? '18%' : '0%';
    pageCount.textContent = isPaused
      ? 'Press Resume to continue the queue'
      : isPreparing
        ? 'The backend is working — waiting for live progress'
        : state.running
          ? 'Waiting for the next job'
          : 'Start the app to begin';
    queueCountLabel.textContent = formatQueueCount(queueCount);
    progressPercent.textContent = isPaused ? 'Paused' : isPreparing ? 'Loading' : state.running ? 'Ready' : 'Idle';
    batchTimer.textContent = isPreparing ? 'Batch 00:00' : 'Batch --:--';
    galleryTimer.textContent = isPreparing ? 'Gallery 00:00' : 'Gallery --:--';
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
  batchTimer.textContent = `Batch ${formatDuration(download.batch_elapsed_ms)}`;
  galleryTimer.textContent = `Gallery ${formatDuration(download.gallery_elapsed_ms)}`;

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
  } else if (status === 'preparing' || status === 'waiting') {
    progressFill.style.width = '18%';
    pageCount.textContent = 'Loading the next gallery…';
    progressPercent.textContent = 'Loading';
  } else if (status === 'finalizing') {
    progressFill.style.width = '100%';
    pageCount.textContent = 'All pages downloaded — building CBZ…';
    progressPercent.textContent = 'Finalizing';
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
    state.paused = Boolean(data.paused);
    state.queueCount = Math.max(0, Number(data.queue_count || 0));

    if (data.current_job) {
      clearResultTimer();
      state.activeDownload = normalizeProgress(data.current_job);
    } else if (data.downloading) {
      state.activeDownload = normalizeProgress({
        title: 'Download in progress',
        status: 'preparing',
        queue_count: data.queue_count || state.queueCount,
        batch_elapsed_ms: state.activeDownload?.batch_elapsed_ms || 0,
        gallery_elapsed_ms: 0
      });
    } else {
      state.activeDownload = null;
    }

    if (state.visible && !progressStream) {
      connectProgressStream();
    }

    render();
  } catch {
    if (!state.visible) {
      return;
    }

    scheduleProgressReconnect(500);
    if (!state.running) {
      state.downloading = false;
      state.paused = false;
      state.queueCount = 0;
      if (!state.activeDownload || isWorkingStatus(state.activeDownload.status)) {
        state.activeDownload = null;
      }
    }
    render();
  }
}

function disconnectProgressStream() {
  clearProgressReconnectTimer();
  if (progressStream) {
    progressStream.close();
    progressStream = null;
  }
}

function scheduleProgressReconnect(delay = 1000) {
  if (progressReconnectTimer || !state.visible) {
    return;
  }

  progressReconnectTimer = setTimeout(() => {
    progressReconnectTimer = null;
    if (state.visible && !progressStream) {
      connectProgressStream();
    }
  }, delay);
}

function connectProgressStream() {
  if (!state.visible || progressStream) {
    return;
  }

  progressStream = new EventSource(`http://127.0.0.1:${state.port}/api/download/progress`);
  progressStream.onopen = () => {
    clearProgressReconnectTimer();
  };

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
        clearResultTimer();
      } else {
        clearResultTimer();
      }

      render();
    } catch {
      // Ignore malformed SSE payloads.
    }
  };

  progressStream.onerror = () => {
    if (progressStream) {
      progressStream.close();
      progressStream = null;
    }
    scheduleProgressReconnect();
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
  if (state.running) {
    appBridge?.send(CHANNELS.TRAY_STOP_BACKEND);
    state.running = false;
    state.downloading = false;
    state.paused = false;
    state.activeDownload = null;
  } else {
    appBridge?.send(CHANNELS.TRAY_START_BACKEND);
    state.running = true;
  }
  clearResultTimer();
  render();
});

pauseButton.addEventListener('click', () => {
  if (!state.running || pauseButton.disabled) {
    return;
  }

  if (state.paused) {
    appBridge?.send(CHANNELS.TRAY_RESUME_DOWNLOADS);
    state.paused = false;
    if (state.queueCount > 0) {
      state.activeDownload = normalizeProgress({
        title: 'Download in progress',
        status: 'preparing',
        queue_count: state.queueCount
      });
    }
  } else {
    appBridge?.send(CHANNELS.TRAY_PAUSE_DOWNLOADS);
    state.paused = true;
    state.downloading = false;
    state.activeDownload = null;
  }

  clearResultTimer();
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
