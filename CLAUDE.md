# CLAUDE.md

Guidance for Claude Code and other coding agents working in this repository. `WARP.md` is a symlink to this file. Edit this file and leave the symlink alone.

## Project

Jira Desktop is an Electron wrapper around Atlassian Jira (and other Atlassian Cloud products). The main window loads the user's Jira site. The app adds a small set of local pages (setup/URL dialog, find bar, placeholder), browser-style navigation, persisted settings and electron-updater updates. Remote content is treated as untrusted. Most of the code exists to keep it sandboxed and away from IPC.

The requirements live in `agent-os/specs/2026-10-13-jira-desktop-hardening/` (`spec.md`, `tasks.md`, `audit-findings.md`). Trace substantive changes to a requirement there, or add one first.

## Stack

- Electron 44, with `electron-updater` as the only runtime dependency
- TypeScript 5.9 in strict mode, built by electron-vite 5 (Vite 7)
- electron-builder 26: dmg + zip on macOS, nsis on Windows, AppImage/deb/rpm on Linux, published to GitHub
- vitest 5 for unit tests, and Playwright 1.64's `_electron` for end-to-end tests
- Node.js 22.12 or newer (`engines`), with npm and `package-lock.json`. Do not use yarn.

## Commands

```bash
npm ci                # install
npm run dev           # electron-vite dev server + app
npm run build         # dist/main, dist/preload, dist/renderer
npm run preview       # run the built app
npm run typecheck     # tsconfig.node.json (main/preload/shared), tsconfig.web.json (renderer/shared), tsconfig.test.json
npm test              # vitest, tests/unit/**/*.test.ts
npm test -- tests/unit/urlPolicy.test.ts        # one unit file
npm run test:e2e      # npm run build, then Playwright (tests/e2e/**/*.spec.ts)
npm run test:e2e -- tests/e2e/security.spec.ts  # one e2e file (still builds first)
npm run dist          # package the current platform into release/ (run npm run build first)
npm run dist:all      # macOS + Windows + Linux
npm run pack          # unpacked directory only
npm run clean         # remove dist/, out/, release/
```

Gate before every commit: `npm run typecheck` exits 0, `npm test` passes and `npm run test:e2e` passes.

## Architecture

```text
src/
├── main/
│   ├── main.ts                     # JiraApp: wires everything; main window, menu, theme, single instance, quit flush
│   ├── security/
│   │   ├── urlPolicy.ts            # THE URL decision module (pure): in-app, auth, external-safe, normalizeJiraUrl
│   │   ├── navigationPolicy.ts     # pure decisions: navigation, window.open, permissions, confinement, local-page keys
│   │   ├── webContentsPolicy.ts    # Electron wiring: installWebContentsPolicy, registerLocalPage,
│   │   │                           #   registerPrivilegedContents, isLocalPageUrl, openExternalSafely
│   │   ├── localPageUrl.ts         # where a src/renderer page loads from (built file, or dev server when unpackaged)
│   │   ├── localPageSender.ts      # pure IPC sender check (exact contents + main frame + exact page path)
│   │   └── localPageIpc.ts         # handleFromLocalPage / handleFromAnyLocalPage (ipcMain.handle wrappers)
│   ├── dialogs/
│   │   ├── DialogController.ts     # the one dialog window: set-url, new-window, welcome, load-error
│   │   └── dialogRules.ts          # pure payload parsing + per-mode URL validation
│   ├── find/
│   │   ├── FindBarController.ts    # per-window find bar (WebContentsView overlay, local page)
│   │   └── findRules.ts            # pure query parsing, result clamping, bar bounds
│   ├── navigation/
│   │   ├── NavigationController.ts # Back/Forward (menu, swipe, app-command), Copy URL, Open in Browser, Find
│   │   ├── navigationRules.ts      # pure: history targets, shareable URL, accelerators
│   │   └── userAgent.ts            # pure: strips Electron/<v> and <app>/<v> tokens from the UA
│   ├── services/
│   │   ├── WindowManager.ts        # extra Atlassian windows (product detection, window-states.json)
│   │   ├── StorageService.ts       # JSON-in-userData store: sync load, atomic debounced writes, corrupt-file quarantine
│   │   ├── settings.ts             # Settings type + sanitizeSettings; settings.json
│   │   ├── mainWindowRules.ts      # pure: saved-URL re-validation, which load failures show the error view, Retry target
│   │   ├── windowBounds.ts         # pure: restore main window bounds only onto a display that still exists
│   │   ├── ContextMenuService.ts   # main window right-click menu
│   │   └── appIcon.ts              # pure: icon paths for packaged vs unpackaged resources/
│   └── updates/
│       └── UpdateController.ts     # packaged-only checks; Update Now / Remind Me Later / Skip This Version
├── preload/                        # per-window preloads for LOCAL pages only
│   ├── dialog.ts                   # window.dialogAPI: getInit / submit / cancel
│   └── find.ts                     # the find bar's bridge
├── renderer/                       # local pages (CSP-restricted, sandboxed)
│   ├── dialog.html / .ts / .css
│   ├── find.html / .ts / .css
│   └── placeholder.html            # static, script-free; main window shows it when no site is loaded
└── shared/                         # contracts between main, preload and renderer (no electron or DOM imports)
    ├── dialog.ts
    └── find.ts
```

How it fits together:

- **Startup** (`main.ts`): honours `JIRA_DESKTOP_USER_DATA_DIR` before anything reads userData, then takes the single-instance lock (a second launch focuses the first). It sets the sanitized `app.userAgentFallback` and calls `installWebContentsPolicy` before `ready`. Then it creates the main window. With a valid saved site it loads it. Otherwise it shows `placeholder.html` and opens the welcome dialog.
- **Main window**: remote content, with no preload. A real main-frame load failure (not `ERR_ABORTED`, not a local page) shows the placeholder and the load-error dialog. To load a site while the placeholder is up, main goes through `about:blank` first, because the placeholder is a local page and so counts as confined.
- **Settings** (`settings.json`): `jiraUrl`, `themeSource`, `mainWindow` (bounds + maximized) and `skippedVersion`. The saved `jiraUrl` is re-validated on every read (`resolveSavedSiteUrl`), because main's own `loadURL` bypasses `will-navigate`. To add a setting, add an optional field to `Settings` and a check to `sanitizeSettings`.
- **WindowManager** windows use the default session (they share the main window's login). They are remote content with the same prefs as the main window, and their saved bounds live in `window-states.json`. `NavigationController.attach` is called on each one, so they get Back/Forward and Find.
- **StorageService** loads synchronously in its constructor and writes atomically (tmp file, fsync, rename). Writes are debounced, and `flush()` runs on `before-quit` and `will-quit`. A corrupt file is renamed to `<file>.corrupt-<n>`. `get` and `set` return JSON copies.
- **Updates**: `UpdateController` never constructs the updater unless `app.isPackaged`. The feed is the `app-update.yml` that electron-builder generates from `build.publish`. `autoDownload` is false: nothing downloads until the user picks Update Now.
- **Packaging** (`package.json` → `build`): fuses (RunAsNode off, NODE_OPTIONS off, CLI inspect off, cookie encryption on, asar integrity on, only-load-from-asar on), the hardened runtime and `build/entitlements.mac.plist` (allow-jit and network.client only). Icons come from `resources/`, copied via `extraResources`.
- **CI** (`.github/workflows/release.yml`): on ubuntu/windows/macos it runs typecheck, unit tests, e2e (under xvfb on Linux), build and package. The `release` job publishes to GitHub Releases on `v*` tags. Actions are pinned to SHAs, with `permissions: contents: read` except on the release job.

## Security invariants (must always hold)

1. Every `BrowserWindow` and `WebContentsView` has `sandbox: true` and `contextIsolation: true`. Never write `nodeIntegration: true` anywhere.
2. Remote content gets **no preload and no IPC**. That covers the main window, WindowManager windows and auth popups (forced to `AUTH_POPUP_WEB_PREFERENCES`). Never register a session-wide preload.
3. `src/main/security/urlPolicy.ts` is the single URL decision module. Host matching is exact or dot-anchored suffix (`hostMatches`), never a substring or unanchored regex. Plain http is in-app only for the exact configured site origin, never for Atlassian hosts. In-app suffix hosts are tenant-registrable, so they grant navigation only, never privilege.
4. `navigationPolicy.ts` holds the pure decisions. `webContentsPolicy.ts` applies them to every webContents (`web-contents-created`) and every session (`session-created`). Navigation, redirects and `window.open` all go through it, and `<webview>` is always refused. Permissions are denied except `notifications`, `clipboard-sanitized-write` and `fullscreen` for in-app origins, and device permissions are always denied.
5. `openExternalSafely` is the **only** path to `shell.openExternal`. It takes http/https/mailto only and passes the parsed `href`, never the raw string.
6. "Confined" contents (a preload, Node, `webviewTag`, no sandbox or no isolation, registered privileged, or showing a local page) may only show registered local pages. Anything else goes external or is blocked. Remote content may never reach a local page. Confinement fails closed: getters that throw count as confined.
7. Local pages validate **every** IPC call's sender through `localPageIpc.ts`/`localPageSender.ts`: the exact webContents, its main frame and the exact page path. Handler arguments are untrusted and are parsed field by field (`dialogRules.ts`, `findRules.ts`).
8. Local pages carry a CSP meta tag and never build HTML from strings. Use `textContent`/`value` only, never `innerHTML` or interpolated markup.

### Adding a local page

Follow `DialogController.ts` (a window) or `FindBarController.ts` (a view):

1. Add `src/renderer/<page>.html` with a CSP meta tag, and add it to `renderer.build.rollupOptions.input` in `electron.vite.config.ts`. If it has a preload, add `src/preload/<page>.ts` to `preload.build.rollupOptions.input` and put its contract in `src/shared/<page>.ts`.
2. Load it from `localPageUrl('<page>.html')` and call `registerLocalPage(url)` once, at startup.
3. Create the window or view with `preload`, `sandbox: true`, `contextIsolation: true`, `nodeIntegration: false`, `nodeIntegrationInSubFrames: false`, `nodeIntegrationInWorker: false`, `webviewTag: false` and `webSecurity: true`. Then call `registerPrivilegedContents(contents)` immediately, before it loads anything.
4. Register IPC once with `handleFromLocalPage` (one instance) or `handleFromAnyLocalPage` (several). Expose only named functions through `contextBridge`, never `ipcRenderer`.
5. Add e2e coverage: the prefs, confinement, and IPC refused from any other sender.

## Testing

- **Unit** (`tests/unit/`): logic lives in pure modules with no electron imports (`*Rules.ts`, `urlPolicy.ts`, `navigationPolicy.ts`, `localPageSender.ts`, `userAgent.ts`, `windowBounds.ts`, `appIcon.ts`), so vitest runs them in Node. Electron-facing classes are tested with fakes where practical (`StorageService`, `WindowManager`, `UpdateController`, `ContextMenuService`).
- **E2E** (`tests/e2e/`): read the header comments of `tests/e2e/helpers/intercept-main.ts` and `tests/e2e/helpers/app.ts` before writing a test.
  - The harness preloads `intercept-main.ts` into the main process (`-r`, only with `JIRA_DESKTOP_E2E=1`). It serves every http/https request via `protocol.handle` on every session. Tests configure responses with `routes`, and the default site is `E2E_SITE_URL` (`https://e2e.atlassian.net/jira`). It points every session's proxy at a loopback escape sink, and any request that reaches the sink fails the test. It also refuses Chromium's OS protocol hand-off.
  - Runs are **offline**. No request may leave the machine during `npm test` or `npm run test:e2e`.
  - `shell.openExternal`, `shell.openPath` and `dialog.showErrorBox` are always recorders (`app.stubCalls(...)`). Anything the app may call during startup (for example `dialog.showMessageBox`) must be stubbed with `LaunchOptions.stubs` (launch-time stubs). `stubMain` after launch is too late for startup.
  - Each launch gets a fresh temp profile via `JIRA_DESKTOP_USER_DATA_DIR`. Pass `userDataDir` to relaunch on the same one, and `settings: null` for a first run.
  - Windows run **off-screen, transparent, click-through and unfocusable**, with an accessory activation policy on macOS. The fixture fails a test if any window gains focus. `JIRA_DESKTOP_E2E_HEADED=1` shows real windows and is **for local debugging only**. Never use it for gate runs.
  - Tests must be robust to a heavily loaded machine. Poll for state (`expect.poll`, `toPass`) rather than sleeping, and never assert tight timings.
- **Codex test directives**: next to each non-trivial logic change, add `// codex:run <command>` pointing at the tightest covering test. Use only `npm test -- <file>` or `npm run test:e2e -- <file>`.

## Conventions

- TypeScript with no semicolons, single quotes and 2-space indent. Match the surrounding code.
- Comments explain why, not what. Keep the existing comment style (spec references like `(spec R2)`).
- Never write absolute local paths, usernames or hostnames into committed files.

## Git workflow

- Branch model: `feature/<name>` → `dev` → `main`.
  - `main` is protected and only receives merges from `dev` (or a hotfix). It is never committed to directly.
  - `dev` is the integration branch. Every feature PR targets it, and it is never committed to directly.
  - Use `feature/<name>`, branched from `dev`, for one logical change per branch.
  - Use `hotfix/<name>`, branched from `main`, for urgent fixes. It merges to both `main` and `dev` via PRs.
- Commits use Conventional Commits (`feat:`, `fix:`, `docs:`, `test:`, `refactor:`, `chore:`, `style:`), with no signatures, co-author trailers or unrelated notes.
- PR titles use Conventional Commits too. CI must pass, and the PR should say how the change was tested.
- Releases: bump `version` in `package.json`, merge `dev` to `main`, and tag `v<version>`. The workflow publishes the GitHub Release.
- `.gitrules` has the full rules for LLM assistants (worktrees, safety checks).
