// tray.js - Tray management
const path = require('path');
const { Tray, Menu, app } = require('electron');

class AppTray {
  constructor(mainWindow) {
    this.tray = null;
    this.mainWindow = mainWindow;
  }

  create() {
    const iconPath = path.join(__dirname, '..', '..', 'assets', 'icons', 'icon.ico');
    this.tray = new Tray(iconPath);
    this.updateMenu();
  }

  updateMenu() {
    const contextMenu = Menu.buildFromTemplate([
      { label: 'Show App', click: () => this.mainWindow?.show() },
      { label: 'Quit', click: () => app.quit() }
    ]);
    this.tray.setContextMenu(contextMenu);
  }
}

module.exports = AppTray;