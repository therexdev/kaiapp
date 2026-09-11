# Koinos AI frontend — v0.54.4

Source: https://github.com/therexdev/kaiapp/commit/072f16edb449731795a773646cb1b7c0ce940823

This export contains the complete `ui/` directory (77 files), including HTML, JavaScript, CSS, images, connection icons, voice preview audio and the embedded Koinos Node interface.

## Manual upload

1. Back up the frontend folder on your server.
2. Replace the deployed kaiapp `ui/` directory with this archive's `ui/` directory. Keep all subfolders.
3. Keep your existing app route, sign-in protection and Core API proxy configuration. If your hosting maps the interface to `/app`, use that existing deployment mapping.
4. Use the matching kaiapp backend version. This interface calls Core APIs and is not a standalone static website. Desktop-only features require the Electron app.
5. Hard-refresh the browser after uploading.

Main HTML: `ui/index.html`.
Companion HTML: `ui/mascot.html`.
Embedded node HTML: `ui/knode/index.html`.

Upload the entire `ui/` directory, not just the HTML files; the HTML depends on its sibling scripts, styles and assets. This export does not contain the backend, credentials, settings, wallet or model data.

`frontend-manifest.json` records the exact source commit and Git blob hashes for every exported frontend file.
