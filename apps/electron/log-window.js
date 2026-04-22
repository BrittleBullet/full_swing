const appBridge = window.fullSwingApp;
const CHANNELS = appBridge?.channels || {};

document.addEventListener('DOMContentLoaded', () => {
  const logArea = document.getElementById('log-area');

  // Listen for initial logs
  appBridge?.on(CHANNELS.LOG_INITIAL, (logs) => {
    logArea.textContent = logs.join('\n');
    logArea.scrollTop = logArea.scrollHeight;
  });

  appBridge?.on(CHANNELS.LOG_UPDATE, (log) => {
    logArea.textContent += log + '\n';
    logArea.scrollTop = logArea.scrollHeight;
  });

  // Clear button
  document.getElementById('clear').addEventListener('click', () => {
    logArea.textContent = '';
    appBridge?.send(CHANNELS.LOG_CLEAR);
  });
});