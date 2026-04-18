const { contextBridge, ipcRenderer } = require('electron');
const CHANNELS = require('./ipc-channels');

const sendChannels = new Set([
  CHANNELS.TRAY_START_BACKEND,
  CHANNELS.TRAY_STOP_BACKEND,
  CHANNELS.TRAY_CANCEL_DOWNLOADS,
  CHANNELS.TRAY_OPEN_SETTINGS,
  CHANNELS.TRAY_OPEN_LOGS,
  CHANNELS.TRAY_OPEN_BROWSE,
  CHANNELS.TRAY_QUIT,
  CHANNELS.SETTINGS_MINIMIZE,
  CHANNELS.SETTINGS_CLOSE,
  CHANNELS.SETTINGS_SAVE_CONFIG
]);

const onChannels = new Set([
  CHANNELS.TRAY_STATE,
  CHANNELS.TRAY_VISIBILITY,
  CHANNELS.SETTINGS_LOAD_CONFIG,
  CHANNELS.LOG_INITIAL,
  CHANNELS.LOG_UPDATE
]);

const invokeChannels = new Set([
  CHANNELS.SETTINGS_SELECT_LIBRARY_PATH
]);

contextBridge.exposeInMainWorld('fullSwingApp', {
  channels: CHANNELS,
  send(channel, payload) {
    if (!sendChannels.has(channel)) {
      return false;
    }
    ipcRenderer.send(channel, payload);
    return true;
  },
  on(channel, listener) {
    if (!onChannels.has(channel) || typeof listener !== 'function') {
      return () => {};
    }

    const wrapped = (_event, ...args) => listener(...args);
    ipcRenderer.on(channel, wrapped);
    return () => ipcRenderer.removeListener(channel, wrapped);
  },
  invoke(channel, ...args) {
    if (!invokeChannels.has(channel)) {
      return Promise.reject(new Error('Unsupported IPC channel'));
    }
    return ipcRenderer.invoke(channel, ...args);
  }
});