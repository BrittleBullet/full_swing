# Full Swing

This builds on [doujinshi-queue-extension](https://github.com/BrittleBullet/doujinshi-queue-extension). It works in a similar way, but adds a companion desktop app so you can download and manage everything locally. I made it for personal use, but hopefully it is useful to someone else too.

## Use the GitHub release

1. Download the latest zip from the GitHub Releases page.
2. Extract the zip to a normal folder.
3. Open the extracted folder.
4. Run the setup file to install the app, or use the portable exe if you do not want to install it.
5. On first launch, open Settings, choose your library folder, and save.
6. Reload the browser extension after the desktop app is running.

## Important defaults

- Page Workers: 10
- Gallery Workers: 2
- API Request Delay: 0.25 seconds
- Server Port: 8080

## Build commands

For local development:

```powershell
cd apps/electron
npm start
```

To create a release zip:

```powershell
cd apps/electron
npm run package
```
