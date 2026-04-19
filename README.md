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
- Windows for the Electron desktop build flow shown below
- A Chromium-based browser such as Chrome or Arc for the extension

## Repository layout

- apps/backend — Go server, downloader, database, and library builder
- apps/electron — desktop shell, tray popup, settings, and logs UI
- apps/browser-extension — browser companion extension
- assets/icons — shared application icons

---

## Run the app locally

Open PowerShell in the repository root and follow these steps.

### 1. Build the backend executable

The Electron app launches the backend from apps/backend/doujinshi-manager.exe, so build that first:

```powershell
cd apps/backend
go mod tidy
go build -o doujinshi-manager.exe ./cmd/server
```

### 2. Start the Electron desktop app

```powershell
cd ../electron
npm install
npm start
```

This opens the desktop tray app and starts the local backend.

### 3. Optional: build and load the browser extension

```powershell
cd ../browser-extension
npm install
npm run build
```

Then load the unpacked extension from:

- apps/browser-extension/.output/chrome-mv3

In Chrome or Arc:

1. Open the extensions page.
2. Turn on Developer mode.
3. Choose Load unpacked.
4. Select apps/browser-extension/.output/chrome-mv3.

---

## Build a Windows executable

Use the Electron build command from the desktop app folder:

```powershell
cd apps/electron
npm install
npm run build
```

That command will:

1. build the Windows backend executable from apps/backend
2. package the Electron app with electron-builder
3. produce both an installer and a portable executable

Output goes to the dist folder at the repository root, including files like:

- dist/Full Swing Setup 1.0.0.exe
- dist/Full-Swing-1.0.0-portable.exe

If Windows SmartScreen warns on first launch, that is expected for an unsigned personal build.

Both the installer and portable build keep their config and SQLite data under the same Windows app-data location for consistency.

### Create a shareable release zip

To build the app, build the production extension, and assemble a release zip ready to share:

```powershell
cd apps/electron
npm install
npm run package
```

This produces a Windows release archive in the repository dist folder named like Full-Swing-v1.0.0.zip.

---

## First run

1. Start the Electron app.
2. Open Settings if prompted.
3. Choose your library folder.
4. Review the worker and port settings if needed.
5. Save the configuration.
6. Reload the browser extension after the local app is running.

## Settings page

The desktop settings window controls the main app behavior:

- Library Path — where completed files are saved. This should point to an existing folder you want to use as your library.
- Page Workers — how many pages from a single gallery download at the same time. Range: 1 to 20. Default: 10.
- Gallery Workers — how many galleries can be processed in parallel. Range: 1 to 5. Default: 2.
- API Request Delay — pause between metadata requests in seconds. Range: 0 to 60. Default: 0.25.
- Server Port — the local port used by the desktop app and browser extension. Range: 1024 to 65535. Default: 8080.

### Default values

On a fresh setup, the app uses these defaults:

- Library Path — your home folder plus Doujinshi Library
- Page Workers — 10
- Gallery Workers — 2
- API Request Delay — 0.25 seconds
- Server Port — 8080

### Reset to Defaults

The Settings window also includes a Reset to Defaults button. Using it restores the built-in values and saves them after confirmation.

## Notes

- Rebuild apps/backend/doujinshi-manager.exe any time you change backend Go code before relaunching Electron or packaging the app.
- The desktop packaging flow now checks that the backend binary exists before packaging continues.
- For each release, update the backend AppVersion and the extension EXTENSION_VERSION together before building and packaging.
- Runtime data and generated files are intentionally excluded from source control.
- The app uses a temporary staging folder during active downloads and writes the final library files only after successful completion.
