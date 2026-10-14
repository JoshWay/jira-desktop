# Spec: Jira Desktop hardening (2026-10-13)

## Goal

Make the app safe to point at remote Atlassian content, make it work as advertised, and gate every change with typecheck plus automated tests. The source is the verified audit in `audit-findings.md`.

## Requirements

### R1. Supported runtime and a gated toolchain
- Upgrade Electron from 32 (EOL) to the current stable major (44.x). Upgrade electron-vite to 5.x, electron-builder to 26.x, and vite to the newest major electron-vite 5 supports (7.x).
- Add `npm run typecheck`. It must exit 0 and check main/preload under Node types and the renderer under DOM types (separate tsconfigs).
- Add `npm test` (vitest unit tests) and `npm run test:e2e` (Playwright `_electron` against the built app).
- Tests never make live network requests.

### R2. Security boundary (Electron security checklist)
- Every BrowserWindow uses `contextIsolation: true` and `sandbox: true`. No window ever uses `nodeIntegration: true`.
- Remote (Atlassian) content gets **no preload** and no IPC surface.
- Local app pages (dialogs) get a dedicated minimal preload. Every IPC handler checks that the sender is the expected local window.
- One URL policy module is the only place that decides which URLs are in-app, which are allowed for auth, and which may be opened externally. Host matching is exact or dot-anchored suffix, never substring.
- `shell.openExternal` only receives `http:`, `https:` or `mailto:` URLs.
- Top-level navigation, redirects and `window.open` are all governed by the policy. `<webview>` attachment is denied.
- Permission requests and permission checks are denied unless explicitly allowed (notifications, clipboard-sanitized-write, fullscreen) for in-app origins.
- No HTML is built by string interpolation of user- or page-controlled values.

### R3. Settings that persist and recover
- The Jira URL, theme choice and main-window bounds/maximized state persist across restarts.
- Storage loads before any reader uses it, and writes are atomic.
- First run (no saved URL) opens setup instead of loading a login or marketing page.
- A failed main-frame load shows a local error page with Retry and Change URL.
- The theme menu offers System, Light and Dark, persisted.
- A second launch focuses the existing instance.
- URL normalization keeps deep links, handles mixed-case schemes, defaults to https, and adds `/jira` only for a bare `*.atlassian.net` site root.

### R4. Browser-parity UX
- Back/Forward: menu items, Cmd+[ / Cmd+] (Alt+Left/Right elsewhere), macOS swipe, and mouse back/forward via `app-command`.
- Find in page (Cmd/Ctrl+F) with next, previous and a match count.
- Copy Current URL, and Open in Browser (through the external-open policy).
- The user agent drops the `Electron/x` and app-name tokens so that Google SSO works.

### R5. Release pipeline
- electron-builder publishes to GitHub with updater metadata (`latest*.yml` and blockmaps).
- macOS ships dmg + zip. Windows ships nsis (electron-updater does not support msi).
- Hardened runtime is on, and macOS entitlements are limited to what Electron needs.
- Electron fuses are set at package time: RunAsNode off, NODE_OPTIONS off, CLI inspect off, cookie encryption on, asar integrity validation on, only-load-from-asar on.
- Icons resolve correctly in packaged builds.
- CI runs typecheck, unit tests and e2e, pins third-party actions to commit SHAs, and uses least-privilege `permissions`.

### R6. Docs and dead code
- README, CLAUDE.md and WARP.md describe this project accurately.
- The dead renderer settings page is removed or replaced by the dialogs from R2/R3.
- The LICENSE file matches package.json.

## Out of scope
- Real code signing/notarization credentials. The config must work when `CSC_LINK`/Apple credentials are supplied, and degrade cleanly when they are absent.
- Deleting the stale `master` branch. The owner decides.
