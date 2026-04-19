const { app, BrowserWindow, Tray, dialog, ipcMain, screen, nativeImage, Notification, shell } = require('electron');
const path = require('path');
const { spawn, execFile } = require('child_process');
const fs = require('fs');
const http = require('http');
const CHANNELS = require('./ipc-channels');

const APP_DISPLAY_NAME = 'Full Swing';
const APP_USER_MODEL_ID = 'com.fullswing.manager';
const LEGACY_APP_DIR_NAME = 'doujinshi-manager';
const APP_STATE_FILES = ['config.json', 'doujinshi.db'];
const DEFAULT_SETTINGS = Object.freeze({
  page_workers: 10,
  gallery_workers: 2,
  api_request_delay: 0.25,
  server_port: 8080
});

app.setName(APP_DISPLAY_NAME);

function resolveCanonicalUserDataPath() {
  return path.join(app.getPath('appData'), APP_DISPLAY_NAME);
}

function migrateLegacyUserData() {
  const canonicalDir = resolveCanonicalUserDataPath();
  const legacyDir = path.join(app.getPath('appData'), LEGACY_APP_DIR_NAME);

  fs.mkdirSync(canonicalDir, { recursive: true });

  if (canonicalDir.toLowerCase() === legacyDir.toLowerCase() || !fs.existsSync(legacyDir)) {
    return canonicalDir;
  }

  for (const fileName of APP_STATE_FILES) {
    const legacyPath = path.join(legacyDir, fileName);
    const canonicalPath = path.join(canonicalDir, fileName);
    if (!fs.existsSync(canonicalPath) && fs.existsSync(legacyPath)) {
      fs.copyFileSync(legacyPath, canonicalPath);
    }
  }

  return canonicalDir;
}

try {
  app.setPath('userData', migrateLegacyUserData());
} catch {
  // Fall back to Electron's default path if migration cannot complete during startup.
}

const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  app.quit();
}

let tray = null;
let mainWindow = null;
let trayPopupWindow = null;
let settingsWindow = null;
let logWindow = null;
let backendProcess = null;
let usingExistingBackend = false;
let configPath = null;
let config = null;
let logs = []; // Store logs for display
let backendStatusTimer = null;
let lastDownloadingState = false;
let manualStopRequested = false;
let backendRestartPending = false;
let completionNotificationSent = false;

function addLog(message) {
  const timestamp = new Date().toISOString();
  const logEntry = `[${timestamp}] ${message}`;
  logs.push(logEntry);
  try {
    process.stdout.write(`${logEntry}\n`);
  } catch {
    // Ignore stdout write failures in production.
  }

  if (logWindow && !logWindow.isDestroyed()) {
    logWindow.webContents.send(CHANNELS.LOG_UPDATE, logEntry);
  }
}

function secureWebPreferences() {
  return {
    preload: path.join(__dirname, 'preload.js'),
    nodeIntegration: false,
    contextIsolation: true,
    sandbox: true,
    webSecurity: true
  };
}

process.on('unhandledRejection', (error) => {
  addLog(`Unhandled promise rejection: ${error?.message || error}`);
});

function getDefaultSettings() {
  return {
    library_path: path.join(app.getPath('home'), 'Doujinshi Library'),
    page_workers: DEFAULT_SETTINGS.page_workers,
    gallery_workers: DEFAULT_SETTINGS.gallery_workers,
    api_request_delay: DEFAULT_SETTINGS.api_request_delay,
    server_port: DEFAULT_SETTINGS.server_port
  };
}

function resolveValidatedDirectory(rawValue, fieldLabel, { allowEmpty = false, createIfMissing = false } = {}) {
  const trimmed = String(rawValue || '').trim();
  if (!trimmed) {
    if (allowEmpty) {
      return '';
    }
    throw new Error(`${fieldLabel} must point to a valid directory.`);
  }

  const candidatePath = path.resolve(trimmed);

  try {
    if (createIfMissing && !fs.existsSync(candidatePath)) {
      fs.mkdirSync(candidatePath, { recursive: true });
    }

    const resolvedPath = fs.realpathSync.native(candidatePath);
    const stats = fs.statSync(resolvedPath);
    if (!stats.isDirectory()) {
      throw new Error(`${fieldLabel} must point to a directory.`);
    }
    return resolvedPath;
  } catch {
    throw new Error(`${fieldLabel} must point to a valid directory.`);
  }
}

function normalizePort(value) {
  const port = Number(value);
  return Number.isInteger(port) && port >= 1024 && port <= 65535 ? port : 8080;
}

function validateConfigShape(candidate) {
  if (!candidate || typeof candidate !== 'object') {
    throw new Error('Configuration payload is invalid.');
  }

  const pageWorkers = Number(candidate.page_workers || 0);
  const galleryWorkers = Number(candidate.gallery_workers || 0);
  const apiRequestDelay = Number(candidate.api_request_delay || 0);
  const rawServerPort = Number(candidate.server_port || 0);
  const serverPort = normalizePort(candidate.server_port);

  if (!Number.isInteger(pageWorkers) || pageWorkers < 1 || pageWorkers > 20) {
    throw new Error('Page workers must be between 1 and 20.');
  }
  if (!Number.isInteger(galleryWorkers) || galleryWorkers < 1 || galleryWorkers > 5) {
    throw new Error('Gallery workers must be between 1 and 5.');
  }
  if (!Number.isFinite(apiRequestDelay) || apiRequestDelay < 0 || apiRequestDelay > 60) {
    throw new Error('API request delay must be between 0 and 60 seconds.');
  }
  if (!Number.isInteger(rawServerPort) || rawServerPort < 1024 || rawServerPort > 65535) {
    throw new Error('Server port must be between 1024 and 65535.');
  }

  const validated = {
    library_path: resolveValidatedDirectory(candidate.library_path, 'Library path', { createIfMissing: true }),
    page_workers: pageWorkers,
    gallery_workers: galleryWorkers,
    api_request_delay: apiRequestDelay,
    server_port: serverPort
  };

  const resolvedDownloadPath = resolveValidatedDirectory(candidate.download_path, 'Download path', { allowEmpty: true, createIfMissing: true });
  if (resolvedDownloadPath) {
    validated.download_path = resolvedDownloadPath;
  }

  return validated;
}

function writeConfigAtomically(destinationPath, nextConfig) {
  const parentDir = path.dirname(destinationPath);
  fs.mkdirSync(parentDir, { recursive: true });
  const tempPath = path.join(parentDir, `config-${process.pid}-${Date.now()}.json.tmp`);
  fs.writeFileSync(tempPath, JSON.stringify(nextConfig, null, 2), { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(tempPath, destinationPath);
}

function findFirstExistingPath(candidates) {
  return candidates.find((candidate) => fs.existsSync(candidate)) || candidates[0] || null;
}

function getAssetsIconRoot() {
  if (app.isPackaged) {
    return findFirstExistingPath([
      path.join(process.resourcesPath, 'assets', 'icons'),
      path.join(process.resourcesPath, 'icons')
    ]);
  }

  return path.join(__dirname, '..', '..', 'assets', 'icons');
}

const binaryName = 'doujinshi-manager.exe';

function getBackendExecutablePath() {
  if (app.isPackaged) {
    return findFirstExistingPath([
      path.join(process.resourcesPath, binaryName),
      path.join(process.resourcesPath, 'backend', binaryName)
    ]);
  }

  return path.join(__dirname, '..', 'backend', binaryName);
}

function getAppIconPath() {
  const iconRoot = getAssetsIconRoot();
  const candidates = process.platform === 'win32'
    ? [
        path.join(iconRoot, 'win', 'icon.ico'),
        path.join(iconRoot, 'png', '256x256.png'),
        path.join(iconRoot, 'png', '128x128.png')
      ]
    : process.platform === 'darwin'
      ? [
          path.join(iconRoot, 'mac', 'icon.icns'),
          path.join(iconRoot, 'png', '512x512.png'),
          path.join(iconRoot, 'png', '256x256.png')
        ]
      : [
          path.join(iconRoot, 'png', '256x256.png'),
          path.join(iconRoot, 'png', '128x128.png'),
          path.join(iconRoot, 'png', '64x64.png')
        ];

  return candidates.find((candidate) => fs.existsSync(candidate)) || null;
}

function createTray() {
  const iconPath = getAppIconPath();
  const icon = iconPath ? nativeImage.createFromPath(iconPath) : null;

  tray = new Tray(icon && !icon.isEmpty() ? icon : nativeImage.createEmpty());
  tray.setToolTip(APP_DISPLAY_NAME);

  if (iconPath) {
    addLog(`Using app icon: ${path.basename(iconPath)}`);
  }

  tray.on('click', toggleTrayPopup);
  tray.on('right-click', toggleTrayPopup);

  updateTrayMenu();
}

function isManagedBackendRunning() {
  return Boolean(backendProcess && !backendProcess.killed);
}

function isAnyBackendRunning() {
  return usingExistingBackend || isManagedBackendRunning();
}

async function buildTrayState() {
  const port = Number(config?.server_port) || 8080;
  const reachable = config ? await isBackendReachable(port) : false;

  return {
    running: reachable || isAnyBackendRunning(),
    managed: isManagedBackendRunning(),
    external: usingExistingBackend && !isManagedBackendRunning(),
    port,
    version: app.getVersion(),
    hasConfig: Boolean(config)
  };
}

function refreshTrayPopupState() {
  if (trayPopupWindow && !trayPopupWindow.isDestroyed()) {
    buildTrayState()
      .then((state) => {
        trayPopupWindow.webContents.send(CHANNELS.TRAY_STATE, state);
      })
      .catch((error) => {
        addLog(`Tray state refresh failed: ${error.message}`);
      });
  }
}

function updateTrayMenu() {
  const isRunning = isAnyBackendRunning();
  if (tray) {
    tray.setToolTip(`Doujinshi Manager — ${isRunning ? 'Running' : 'Stopped'}`);
  }
  refreshTrayPopupState();
}

function createTrayPopupWindow() {
  if (trayPopupWindow && !trayPopupWindow.isDestroyed()) {
    return trayPopupWindow;
  }

  trayPopupWindow = new BrowserWindow({
    width: 320,
    height: 400,
    useContentSize: true,
    resizable: false,
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    frame: false,
    show: false,
    transparent: true,
    hasShadow: true,
    alwaysOnTop: true,
    backgroundColor: '#00000000',
    webPreferences: secureWebPreferences()
  });

  trayPopupWindow.loadFile('tray-popup.html');
  trayPopupWindow.on('blur', () => {
    hideTrayPopup();
  });
  trayPopupWindow.on('closed', () => {
    trayPopupWindow = null;
  });
  trayPopupWindow.webContents.on('did-finish-load', () => {
    refreshTrayPopupState();
  });

  return trayPopupWindow;
}

function hideTrayPopup() {
  if (trayPopupWindow && !trayPopupWindow.isDestroyed()) {
    trayPopupWindow.webContents.send(CHANNELS.TRAY_VISIBILITY, false);
    trayPopupWindow.hide();
  }
}

function positionTrayPopup() {
  if (!tray || !trayPopupWindow || trayPopupWindow.isDestroyed()) {
    return;
  }

  const trayBounds = tray.getBounds();
  const popupBounds = trayPopupWindow.getBounds();
  const display = screen.getDisplayMatching(trayBounds);
  const workArea = display.workArea;
  const popupGap = process.platform === 'win32' ? -6 : 8;
  const bottomNudge = process.platform === 'win32' ? 22 : 0;

  let x = Math.round(trayBounds.x + (trayBounds.width / 2) - (popupBounds.width / 2));
  x = Math.max(workArea.x + 8, Math.min(x, workArea.x + workArea.width - popupBounds.width - 8));

  let y = Math.round(trayBounds.y + trayBounds.height + popupGap);
  if (y + popupBounds.height > workArea.y + workArea.height) {
    y = Math.round(trayBounds.y - popupBounds.height + bottomNudge);
  }

  trayPopupWindow.setPosition(x, y, false);
}

async function toggleTrayPopup() {
  createTrayPopupWindow();

  if (!trayPopupWindow || trayPopupWindow.isDestroyed()) {
    return;
  }

  if (trayPopupWindow.isVisible()) {
    hideTrayPopup();
    return;
  }

  positionTrayPopup();
  trayPopupWindow.show();
  trayPopupWindow.focus();
  trayPopupWindow.webContents.send(CHANNELS.TRAY_VISIBILITY, true);
  refreshTrayPopupState();
}

function loadConfig() {
  configPath = path.join(app.getPath('userData'), 'config.json');
  addLog(`Using user data path: ${app.getPath('userData')}`);
  addLog(`Using config path: ${configPath}`);

  try {
    if (fs.existsSync(configPath)) {
      const parsed = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      config = validateConfigShape(parsed);
      addLog('Configuration loaded successfully');
    } else {
      addLog('No configuration file found in the canonical app-data folder');
      setTimeout(openSettings, 1000);
    }
  } catch (error) {
    config = null;
    addLog(`Failed to load config: ${error?.message || String(error)}`);
    setTimeout(openSettings, 1000);
  }
}

function saveConfig(newConfig) {
  const validatedConfig = validateConfigShape({ ...config, ...newConfig });
  writeConfigAtomically(configPath, validatedConfig);
  config = validatedConfig;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isBackendReachable(port) {
  return new Promise((resolve) => {
    const request = http.get(
      {
        hostname: '127.0.0.1',
        port,
        path: '/api/status',
        timeout: 1500
      },
      (response) => {
        response.resume();
        resolve(response.statusCode >= 200 && response.statusCode < 500);
      }
    );

    request.on('error', () => resolve(false));
    request.on('timeout', () => {
      request.destroy();
      resolve(false);
    });
  });
}

function fetchBackendStatus(port) {
  return new Promise((resolve) => {
    const request = http.get(
      {
        hostname: '127.0.0.1',
        port,
        path: '/api/status',
        timeout: 2000
      },
      (response) => {
        let body = '';
        response.setEncoding('utf8');
        response.on('data', (chunk) => {
          body += chunk;
        });
        response.on('end', () => {
          try {
            resolve(JSON.parse(body || '{}'));
          } catch {
            resolve(null);
          }
        });
      }
    );

    request.on('error', () => resolve(null));
    request.on('timeout', () => {
      request.destroy();
      resolve(null);
    });
  });
}

function postBackendAction(port, routePath) {
  return new Promise((resolve) => {
    const request = http.request(
      {
        hostname: '127.0.0.1',
        port,
        path: routePath,
        method: 'POST',
        timeout: 2000
      },
      (response) => {
        let body = '';
        response.setEncoding('utf8');
        response.on('data', (chunk) => {
          body += chunk;
        });
        response.on('end', () => {
          let data = null;
          try {
            data = JSON.parse(body || '{}');
          } catch {
            data = null;
          }

          resolve({
            ok: response.statusCode >= 200 && response.statusCode < 300,
            data
          });
        });
      }
    );

    request.on('error', () => resolve({ ok: false, data: null }));
    request.on('timeout', () => {
      request.destroy();
      resolve({ ok: false, data: null });
    });
    request.end();
  });
}

function showQueueStartedNotification(queueCount) {
  if (!Notification.isSupported()) {
    return;
  }

  const body = queueCount > 0
    ? `Queue started — ${queueCount} item${queueCount === 1 ? '' : 's'} waiting or downloading`
    : 'Queue started — downloads are now in progress';

  new Notification({
    title: APP_DISPLAY_NAME,
    body,
    icon: getAppIconPath() || undefined
  }).show();
}

function showQueueCompleteNotification(successCount, failedCount) {
  if (!Notification.isSupported()) {
    return;
  }

  const bodyLines = [`Queue complete — ${successCount} downloaded, ${failedCount} failed`];
  if (failedCount > 0) {
    bodyLines.push('Open logs for details');
  }

  new Notification({
    title: APP_DISPLAY_NAME,
    body: bodyLines.join('\n'),
    icon: getAppIconPath() || undefined
  }).show();
}

function stopBackendStatusMonitoring() {
  if (backendStatusTimer) {
    clearInterval(backendStatusTimer);
    backendStatusTimer = null;
  }
}

function startBackendStatusMonitoring() {
  stopBackendStatusMonitoring();

  const pollStatus = async () => {
    if (!config) {
      return;
    }

    const port = Number(config.server_port) || 8080;
    const status = await fetchBackendStatus(port);
    if (!status) {
      return;
    }

    const downloading = Boolean(status.downloading);

    if (downloading && !lastDownloadingState) {
      completionNotificationSent = false;
      manualStopRequested = false;
      showQueueStartedNotification(Number(status.queue_count || 0));
    }

    if (lastDownloadingState && !downloading && Number(status.queue_count || 0) === 0) {
      if (!manualStopRequested && !completionNotificationSent) {
        showQueueCompleteNotification(Number(status.last_batch_success || 0), Number(status.last_batch_failed || 0));
        completionNotificationSent = true;
      }
    }

    lastDownloadingState = downloading;
  };

  pollStatus();
  backendStatusTimer = setInterval(pollStatus, 3000);
}

function findListeningBackendProcess(port) {
  return new Promise((resolve) => {
    if (process.platform !== 'win32') {
      resolve(null);
      return;
    }

    const script = `$conn = Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1; if ($conn) { $proc = Get-CimInstance Win32_Process -Filter \"ProcessId = $($conn.OwningProcess)\"; if ($proc) { [PSCustomObject]@{ pid = $proc.ProcessId; name = $proc.Name; path = $proc.ExecutablePath; commandLine = $proc.CommandLine } | ConvertTo-Json -Compress } }`;

    execFile('powershell.exe', ['-NoProfile', '-Command', script], { windowsHide: true }, (error, stdout) => {
      if (error || !stdout?.trim()) {
        resolve(null);
        return;
      }

      try {
        resolve(JSON.parse(stdout.trim()));
      } catch {
        resolve(null);
      }
    });
  });
}

function stopProcessById(pid) {
  return new Promise((resolve) => {
    if (!pid) {
      resolve(false);
      return;
    }

    const killer = spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true });
    killer.on('error', () => resolve(false));
    killer.on('exit', () => resolve(true));
  });
}

async function startBackend() {
  if (!config) {
    dialog.showErrorBox('Configuration Required', 'Please configure the application first.');
    openSettings();
    return;
  }

  if (isManagedBackendRunning()) {
    addLog('Backend is already running under this app instance.');
    updateTrayMenu();
    return;
  }

  manualStopRequested = false;
  backendRestartPending = false;
  completionNotificationSent = false;

  const port = Number(config.server_port) || 8080;
  const backendPath = getBackendExecutablePath();
  const alreadyRunning = await isBackendReachable(port);
  if (alreadyRunning) {
    const existingProcess = await findListeningBackendProcess(port);
    const existingPath = existingProcess?.path ? path.resolve(existingProcess.path).toLowerCase() : '';
    const targetPath = path.resolve(backendPath).toLowerCase();

    if (existingPath && existingPath === targetPath) {
      addLog(`Existing backend found on port ${port}; restarting it under Electron control.`);
      await stopProcessById(existingProcess.pid);
      await delay(1200);
    } else {
      usingExistingBackend = true;
      addLog(`Backend already running on port ${port}; using existing external instance.`);
      startBackendStatusMonitoring();
      updateTrayMenu();
      return;
    }
  }

  usingExistingBackend = false;
  addLog(`Using backend executable: ${backendPath}`);
  addLog(`Launching backend with config: ${configPath}`);

  if (!fs.existsSync(backendPath)) {
    addLog(`Backend executable not found: ${backendPath}`);
    dialog.showErrorBox('Backend Missing', 'The backend executable could not be found. Build the backend before starting the app.');
    updateTrayMenu();
    return;
  }

  addLog('Starting backend process...');
  const child = spawn(backendPath, ['--config', configPath], {
    stdio: ['pipe', 'pipe', 'pipe'],
    cwd: path.dirname(backendPath)
  });
  child.exitExpected = false;
  backendProcess = child;

  // Capture stdout
  child.stdout.on('data', (data) => {
    addLog(`[STDOUT] ${data.toString().trim()}`);
  });

  // Capture stderr
  child.stderr.on('data', (data) => {
    addLog(`[STDERR] ${data.toString().trim()}`);
  });

  child.on('exit', (code, signal) => {
    const wasCurrentProcess = backendProcess === child;
    const expectedExit = Boolean(child.exitExpected) || manualStopRequested;
    const exitDetail = signal ? `${code} (signal ${signal})` : `${code}`;
    addLog(`Backend exited with code ${exitDetail}`);

    if (!wasCurrentProcess) {
      return;
    }

    backendProcess = null;
    usingExistingBackend = false;
    lastDownloadingState = false;
    stopBackendStatusMonitoring();
    updateTrayMenu();

    if (!expectedExit && code !== 0 && config) {
      dialog.showMessageBox({
        type: 'warning',
        title: 'Backend Stopped',
        message: 'The backend stopped unexpectedly.',
        detail: `Exit code: ${signal ? `${code} (${signal})` : code}`,
        buttons: ['Restart', 'Dismiss'],
        defaultId: 0,
        cancelId: 1
      }).then(({ response }) => {
        if (response === 0) {
          startBackend();
        }
      }).catch((error) => {
        addLog(`Failed to show restart prompt: ${error.message}`);
      });
    }
  });

  child.on('error', (error) => {
    addLog(`Backend error: ${error.message}`);
    dialog.showErrorBox('Backend Error', `Failed to start backend: ${error.message}`);
  });

  addLog('Backend process spawned successfully');
  startBackendStatusMonitoring();
  updateTrayMenu();
}

async function cancelDownloads() {
  manualStopRequested = true;
  completionNotificationSent = true;

  if (!config) {
    return;
  }

  const port = Number(config.server_port) || 8080;
  const result = await postBackendAction(port, '/api/download/stop');

  if (result.ok) {
    addLog(`Download cancellation requested${result.data?.cancelled ? `; ${result.data.cancelled} queued item(s) paused` : ''}.`);
  } else {
    addLog('Download cancellation request failed.');
  }

  refreshTrayPopupState();
}

function stopBackend(options = {}) {
  const { restart = false } = options;

  manualStopRequested = true;
  backendRestartPending = restart;
  completionNotificationSent = true;
  lastDownloadingState = false;
  stopBackendStatusMonitoring();

  if (usingExistingBackend && !backendProcess) {
    addLog('Backend is already running outside this Electron instance. Stop skipped.');
    usingExistingBackend = false;
    backendRestartPending = false;
    stopBackendStatusMonitoring();
    updateTrayMenu();
    return;
  }

  if (backendProcess) {
    const processToStop = backendProcess;
    processToStop.exitExpected = true;
    addLog(restart ? 'Stopping backend process for restart...' : 'Stopping backend process...');
    processToStop.kill('SIGTERM');
    setTimeout(() => {
      if (backendProcess === processToStop && processToStop.exitCode === null && processToStop.signalCode === null) {
        addLog('Backend did not stop in time; forcing termination.');
        processToStop.kill('SIGKILL');
      }
    }, 5000);
  }

  updateTrayMenu();
}

function sendSettingsWindowState() {
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    settingsWindow.webContents.send(CHANNELS.SETTINGS_LOAD_CONFIG, {
      config: config || {},
      defaults: getDefaultSettings()
    });
  }
}

function openSettings() {
  hideTrayPopup();

  if (settingsWindow) {
    sendSettingsWindowState();
    settingsWindow.focus();
    return;
  }

  settingsWindow = new BrowserWindow({
    width: 560,
    height: 640,
    minWidth: 560,
    minHeight: 640,
    frame: false,
    titleBarStyle: 'hidden',
    backgroundColor: '#111111',
    autoHideMenuBar: true,
    resizable: false,
    minimizable: true,
    maximizable: false,
    icon: getAppIconPath() || undefined,
    webPreferences: secureWebPreferences(),
    show: false
  });

  settingsWindow.loadFile('settings-window.html');
  settingsWindow.webContents.once('did-finish-load', () => {
    sendSettingsWindowState();
  });

  settingsWindow.once('ready-to-show', () => {
    settingsWindow.show();
    sendSettingsWindowState();
  });

  settingsWindow.on('closed', () => {
    settingsWindow = null;
  });
}

function openLogs() {
  hideTrayPopup();

  if (logWindow) {
    logWindow.focus();
    return;
  }

  logWindow = new BrowserWindow({
    width: 800,
    height: 600,
    backgroundColor: '#111111',
    autoHideMenuBar: true,
    icon: getAppIconPath() || undefined,
    webPreferences: secureWebPreferences(),
    show: false
  });

  logWindow.loadFile('log-window.html');
  logWindow.once('ready-to-show', () => {
    logWindow.show();
    logWindow.webContents.send(CHANNELS.LOG_INITIAL, logs);
  });

  logWindow.on('closed', () => {
    logWindow = null;
  });
}

function quitApp() {
  hideTrayPopup();
  stopBackend();
  app.quit();
}

app.whenReady().then(() => {
  app.setAppUserModelId(APP_USER_MODEL_ID);

  const iconPath = getAppIconPath();
  if (iconPath) {
    addLog(`Using app icon: ${path.basename(iconPath)}`);
  }

  addLog(`${APP_DISPLAY_NAME} starting...`);
  loadConfig();
  createTray();
  addLog('Tray icon created');

  // IPC handlers
  ipcMain.on(CHANNELS.SETTINGS_MINIMIZE, () => {
    if (settingsWindow && !settingsWindow.isDestroyed()) {
      settingsWindow.minimize();
    }
  });

  ipcMain.handle(CHANNELS.SETTINGS_SELECT_LIBRARY_PATH, async (_event, currentPath) => {
    const result = await dialog.showOpenDialog(settingsWindow || undefined, {
      defaultPath: currentPath || (config && config.library_path) || app.getPath('documents'),
      properties: ['openDirectory', 'createDirectory']
    });

    if (result.canceled || !result.filePaths || result.filePaths.length === 0) {
      return null;
    }

    return result.filePaths[0];
  });

  ipcMain.on(CHANNELS.TRAY_START_BACKEND, () => {
    startBackend();
  });

  ipcMain.on(CHANNELS.TRAY_STOP_BACKEND, () => {
    stopBackend();
  });

  ipcMain.on(CHANNELS.TRAY_CANCEL_DOWNLOADS, () => {
    cancelDownloads();
  });

  ipcMain.on(CHANNELS.TRAY_OPEN_SETTINGS, () => {
    openSettings();
  });

  ipcMain.on(CHANNELS.TRAY_OPEN_LOGS, () => {
    openLogs();
  });

  ipcMain.on(CHANNELS.TRAY_OPEN_BROWSE, () => {
    shell.openExternal('https://nhentai.net');
  });

  ipcMain.on(CHANNELS.TRAY_QUIT, () => {
    quitApp();
  });

  ipcMain.on(CHANNELS.SETTINGS_CLOSE, () => {
    if (settingsWindow && !settingsWindow.isDestroyed()) {
      settingsWindow.close();
    }
  });

  ipcMain.on(CHANNELS.SETTINGS_SAVE_CONFIG, (_event, newConfig) => {
    try {
      saveConfig(newConfig);
      addLog('Configuration saved');
    } catch (error) {
      addLog(`Configuration save failed: ${error.message}`);
      if (settingsWindow && !settingsWindow.isDestroyed()) {
        settingsWindow.webContents.send(CHANNELS.SETTINGS_SAVE_RESULT, {
          ok: false,
          message: error.message,
          defaults: getDefaultSettings()
        });
      }
      dialog.showErrorBox('Invalid Configuration', error.message);
      return;
    }

    const managedWasRunning = isManagedBackendRunning();
    const hadBackend = isAnyBackendRunning();
    let statusMessage = 'Settings saved.';

    if (managedWasRunning) {
      statusMessage = 'Settings saved. Restarting backend...';
    } else if (hadBackend) {
      statusMessage = 'Settings saved. Using the existing backend instance.';
    }

    if (settingsWindow && !settingsWindow.isDestroyed()) {
      settingsWindow.webContents.send(CHANNELS.SETTINGS_SAVE_RESULT, {
        ok: true,
        message: statusMessage,
        config,
        defaults: getDefaultSettings()
      });
    }

    if (managedWasRunning) {
      addLog('Restarting backend to apply new settings...');
      stopBackend({ restart: true });
      setTimeout(() => {
        if (config) {
          startBackend();
        }
      }, 800);
    } else if (config) {
      startBackend();
    }
  });

  // Start backend if config exists
  if (config) {
    addLog('Config loaded, starting backend...');
    startBackend();
  } else {
    addLog('No config found, opening settings...');
  }

});

app.on('window-all-closed', (e) => {
  // Don't quit the app when all windows are closed - keep the tray running
  // e.preventDefault();
});

app.on('before-quit', () => {
  stopBackendStatusMonitoring();
  stopBackend();
});