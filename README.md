# Full Swing

Full Swing is a local-first desktop and browser workflow for queue management, local downloading, and library organization.

## Components

- Go backend API for queueing, downloading, metadata, and SQLite state
- Electron tray application for desktop control and settings
- Browser extension for sending queued items to the local app

## Prerequisites

- Go 1.21 or newer
- Node.js 20 or newer
- npm 10 or newer
- A Chromium-based browser such as Chrome or Arc for the extension

## Repository layout

- apps/backend — Go server, downloader, database, and library builder
- apps/electron — desktop shell, tray popup, settings, and logs UI
- apps/browser-extension — browser companion extension
- assets/icons — shared application icons

## Build and run

### Build the Go backend

On Windows PowerShell:

powershell
cd apps/backend
go mod tidy
go build -o doujinshi-manager.exe ./cmd/server

### Run the Electron app

powershell
cd apps/electron
npm install
npm start

### Build the browser extension

powershell
cd apps/browser-extension
npm install
npm run build

## Load the extension in Chrome or Arc

1. Open the browser extension management page.
2. Enable developer mode.
3. Choose Load unpacked.
4. Select the folder at apps/browser-extension/.output/chrome-mv3.

## Configuration options

The desktop settings window exposes the main runtime options:

- Library Path — final destination for completed library files
- Page Workers — concurrent page downloads, supported range 1 to 20
- Gallery Workers — concurrent gallery jobs, supported range 1 to 5
- API Request Delay — metadata pacing in seconds, supported range 0 to 60
- Download Delay — delay between galleries in seconds, supported range 0 to 60
- Server Port — local API port, supported range 1024 to 65535

## First run

1. Start the Electron app.
2. Open Settings if prompted.
3. Choose an existing library folder.
4. Save the configuration.
5. Reload the browser extension after the local app is running.

## Notes

- Runtime data and generated files are intentionally excluded from source control.
- The app uses a temporary staging folder during active downloads and writes the final library files only after successful completion.
