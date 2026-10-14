# Plan: Jira Desktop hardening

Spec: `agent-os/specs/2026-10-13-jira-desktop-hardening/spec.md` (binding). The evidence for each finding is in `audit-findings.md` in the same folder.

## Global Constraints

- Code style: TypeScript with no semicolons, single quotes, 2-space indent. Match the surrounding code.
- Electron: every BrowserWindow has `contextIsolation: true` and `sandbox: true`. `nodeIntegration: true` must never appear. Remote content never gets a preload.
- Tests are offline. No live network request may leave the machine during `npm test` or `npm run test:e2e`. Serve or intercept any remote-looking URL locally (e.g. `protocol.handle('https', …)` on the session from `electronApp.evaluate`, or a local http server plus a test-only host override that can only be enabled when `JIRA_DESKTOP_E2E=1`).
- Test isolation: honour `JIRA_DESKTOP_USER_DATA_DIR` (if set, `app.setPath('userData', …)` before `ready`) so e2e runs never touch the real profile.
- Gates before every commit: `npm run typecheck` exits 0, `npm test` passes, and `npm run test:e2e` passes from Task 2 onwards.
- Commits: Conventional Commits (`feat:`, `fix:`, `test:`, `chore:`, `docs:`, `refactor:`), with no signatures, co-author trailers or unrelated notes.
- Add a `// codex:run <command>` comment next to each non-trivial logic change, pointing at the tightest covering test. Use `npm test -- <file>` or `npm run test:e2e -- <file>` only.
- Do not push, open PRs, tag, or touch git remotes. The controller does that.
- Never write absolute local paths, usernames or hostnames into committed files.

---

### Task 1: Toolchain upgrade + typecheck gate

Branch: `feature/toolchain-and-tests`.
- Upgrade devDependencies: `electron` ^44, `electron-vite` ^5, `electron-builder` ^26, `vite` ^7, `typescript` ^5.9 (latest 5.x unless 6 is required), `@types/node` ^22. Keep `electron-updater` at the latest 6.x. Add `"engines": { "node": ">=22.12.0" }`.
- Update `electron.vite.config.ts` for electron-vite 5. Replace or remove `externalizeDepsPlugin` if it is deprecated, following the electron-vite 5 docs in node_modules. Keep output dirs `dist/main`, `dist/preload`, `dist/renderer`.
- **Do not** change the preload path in `src/main/main.ts` or `WindowManager.ts`. That fix ships with Task 4 (security coupling: fixing it alone exposes `setJiraUrl` to remote pages).
- Split TypeScript config: a `tsconfig.json` with references to `tsconfig.node.json` (main + preload + `electron.vite.config.ts`, Node types, no DOM) and `tsconfig.web.json` (renderer, DOM, `allowJs`, `checkJs: false`).
- Add `"typecheck": "tsc -p tsconfig.node.json --noEmit && tsc -p tsconfig.web.json --noEmit"`. Fix every resulting type error with minimal, behaviour-preserving edits (e.g. the unused `dialog` import, `any`s that break strict mode).
- `npm run build` must succeed. `npm audit --omit=dev` should report 0 vulnerabilities. Record full `npm audit` totals in the report.
- Acceptance: `npm ci && npm run typecheck && npm run build` succeeds on Node 22.12. The app launches (`npx electron .` for ~10s), with output captured in the report.

### Task 2: Test harness (unit + e2e)

- Add `vitest` (unit, `tests/unit/**/*.test.ts`, node environment) and `@playwright/test` (e2e, `tests/e2e/**/*.spec.ts`, using `_electron.launch` on the built app). Scripts: `"test": "vitest run"`, `"test:watch": "vitest"`, `"test:e2e": "npm run build && playwright test"`.
- Implement `JIRA_DESKTOP_USER_DATA_DIR` handling in `src/main/main.ts` (see Global Constraints). Each e2e test gets a fresh temp dir.
- Implement offline interception for e2e as described in Global Constraints. Add a test helper (`tests/e2e/helpers/app.ts`) that launches the app with a temp userData dir and env `JIRA_DESKTOP_E2E=1`, and installs an https interceptor that serves a tiny fake page for any host and records every requested URL. The helper must also fail the test if any request escapes interception.
- Smoke e2e (`tests/e2e/smoke.spec.ts`): app launches, a main window appears, and no request escaped. Assert the main window's `webContents.getLastWebPreferences()` values so later tasks have a ready-made place to tighten them. The values must describe **current** behaviour; Task 4 changes them.
- Add `.gitignore` entries: `release/`, `test-results/`, `playwright-report/`, `.superpowers/`.
- Acceptance: `npm test` (may contain one trivial sanity unit test) and `npm run test:e2e` both pass, and no network leaves the machine (prove it in the report, e.g. the interceptor log shows all requests and the escape counter is 0).

### Task 3: URL policy module (pure, TDD)

- Create `src/main/security/urlPolicy.ts`. It must not import from `electron`, so it stays unit-testable. Exports:
  - `APP_HOST_SUFFIXES = ['atlassian.net', 'atlassian.com', 'bitbucket.org', 'trello.com']`
  - `AUTH_HOSTS`: exact hosts or dot-suffixes for identity providers used by Atlassian SSO: `accounts.google.com`, `login.microsoftonline.com`, `login.live.com`, `appleid.apple.com`, suffixes `okta.com`, `oktapreview.com`, `onelogin.com`, `auth0.com`, `duosecurity.com`, `pingidentity.com`.
  - `hostMatches(host, entry)`: lower-cases the host, strips a trailing dot, and returns `host === entry || host.endsWith('.' + entry)`.
  - `isInAppUrl(url, configuredSiteUrl?)`: true only for `https:` URLs whose host matches an APP_HOST_SUFFIXES entry, or whose origin equals `configuredSiteUrl`'s origin. The configured site may be self-hosted, and http is allowed only if the configured site itself is http.
  - `isAuthUrl(url)`: `https:` and host matches AUTH_HOSTS.
  - `isSafeExternalUrl(url)`: protocol is `http:`, `https:` or `mailto:`.
  - `normalizeJiraUrl(input)`: returns `{ ok: true, url } | { ok: false, error }`. Trim; add `https://` when no scheme is present; accept mixed-case schemes; reject non-http(s) schemes, empty input, credentials in the URL (`user:pass@`) and hosts without a dot (except `localhost`). For a bare `*.atlassian.net` root (path `/` or empty), append `/jira`. Preserve any deep link path, query and hash unchanged.
- TDD: write `tests/unit/urlPolicy.test.ts` first and show RED, then GREEN. Required cases include: `https://atlassian.net.evil.io` false, `https://evilatlassian.net` false, `https://x.atlassian.net.` true, `https://evil.com/?atlassian.net` false, `http://x.atlassian.net` false (no configured http site), `javascript:alert(1)` not safe external, `file:///etc/passwd` not safe external, `smb://host/share` not safe external, `HTTPS://Acme.atlassian.net` → `https://acme.atlassian.net/jira`, `acme.atlassian.net/browse/ABC-1?x=1#c` preserved, `https://jira.corp.example/` (self-hosted) normalizes unchanged and is in-app when configured, `https://u:p@acme.atlassian.net` rejected.
- This task does not wire anything into the app. Wiring is Task 4.

### Task 4: Enforce the security boundary (wiring)

- Create `src/main/security/webContentsPolicy.ts` with `installWebContentsPolicy(getConfiguredSiteUrl)`, called once at startup. On `app.on('web-contents-created')` it does the following for every contents:
  - `setWindowOpenHandler`:
    - in-app URL: deny, and load it in the opener's window (current UX).
    - auth URL: allow, as a child window with sandbox, contextIsolation and no preload, because SSO popups must work.
    - safe external: `shell.openExternal`, then deny.
    - anything else: deny silently.
  - `will-navigate` and `will-redirect` (main frame):
    - in-app or auth: allow.
    - safe external: prevent, then openExternal.
    - otherwise: prevent.
  - `will-attach-webview`: always prevent.
  - Local app pages (Task 5) are exempt by exact origin match. The policy module exposes a way to register local page origins (file:// for packaged builds, the dev-server origin in dev).
- Permissions: on `session.defaultSession`, `setPermissionRequestHandler` and `setPermissionCheckHandler` allow only `notifications`, `clipboard-sanitized-write` and `fullscreen`, and only when the requesting origin is in-app. Everything else is denied.
- Unify the session. Remove the `persist:atlassian-shared` partition from WindowManager so extra windows share the main window's login (default session).
- Every window: `sandbox: true`, `contextIsolation: true`, `nodeIntegration: false`, `webSecurity: true`, **no `preload`**. Delete the old `src/preload/preload.ts` remote API (`setJiraUrl`, `showContextMenu`, `getTheme`/`onThemeChanged`, `platform`/`versions`). Delete the `ipcMain.handle('set-jira-url')` and `ipcMain.handle('show-context-menu')` handlers. Context menus keep working through the main-process `webContents.on('context-menu')` path already in ContextMenuService. Remove the IPC path there.
- Delete the duplicated `isAtlassianUrl` implementations in `main.ts` and `WindowManager.ts`. Use `urlPolicy`. `WindowManager.identifyProduct`'s fallback uses `hostMatches`.
- ContextMenuService: any "open link in browser" style action must go through `isSafeExternalUrl`.
- The two prompt windows still exist after this task. Task 5 replaces them, and this task must not touch them except to keep compiling.
- Tests:
  - e2e asserts for the main window and a WindowManager window: `sandbox === true`, `contextIsolation === true`, `nodeIntegration === false`, no preload, and `typeof window.electronAPI === 'undefined'` in page.
  - e2e drives navigation to `https://atlassian.net.evil.test/` and asserts it is blocked: URL unchanged, and openExternal is not called for non-safe schemes. Stub `shell.openExternal` via `electronApp.evaluate` and record its calls.
  - e2e checks that a `window.open('https://accounts.google.com/x')` creates a sandboxed child, and that `window.open('smb://x/y')` creates nothing and calls nothing.
  - e2e checks that a permission request for `media` from in-app content is denied and `notifications` is granted.
  - Unit tests cover any new pure helpers.

### Task 5: Replace the prompt windows with a sandboxed local dialog

- Replace `promptForJiraUrl` and `promptForNewWindow` (both use `nodeIntegration: true` and data: URLs built by interpolation) with one local page `src/renderer/dialog.html` + `src/renderer/dialog.ts`, built by electron-vite as a second renderer input. It loads from file:// in production and from the dev server in dev, and is registered as a local origin with the Task 4 policy. Remove the dead settings page (`index.html`, `app.js`, `style.css`) or repurpose it as this dialog.
- Dedicated preload `src/preload/dialog.ts` exposes only `dialogAPI.getInit(): Promise<{ mode: 'set-url' | 'new-window', currentUrl?: string }>`, `dialogAPI.submit(payload)` and `dialogAPI.cancel()`.
- Main side: `src/main/dialogs/DialogController.ts`.
  - Allow at most one dialog at a time. If one is open, focus it.
  - Window prefs: `sandbox: true`, `contextIsolation: true`, `nodeIntegration: false`, `parent: mainWindow`, `modal: true` on macOS-safe settings.
  - Register `ipcMain.handle` channels **once**, at startup.
  - Every handler rejects unless `event.sender === currentDialog.webContents` and `event.senderFrame.url` is the dialog page.
  - `submit` validates with `normalizeJiraUrl`. On `{ ok: false }` it returns the error to the page for inline display and does **not** close.
  - `new-window` mode validates that the URL is in-app before calling `windowManager.createWindow`.
- The page sets values via `input.value = …` / `textContent`, never via `innerHTML`. Add a CSP meta tag: `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'`.
- Tests (e2e):
  - Dialog has `typeof require === 'undefined'` and sandboxed prefs.
  - A current URL containing `"><img src=x onerror=…>` renders inertly in the input value. Assert the attribute value equals the raw string and no `img` element exists.
  - Run cancel → reopen → submit three times. There are no error dialogs (stub `dialog.showErrorBox` and assert no calls), and `ipcMain.listenerCount` is stable.
  - An invalid URL shows an inline error and the dialog stays open.
  - IPC from a non-dialog webContents (e.g. the main window, by injecting `ipcRenderer` via a test-only preload is NOT allowed). Instead call the registered handler with a fake event whose sender is the main window's webContents (via `electronApp.evaluate`) and assert it is rejected.

### Task 6: Persistent settings store

- Rewrite `StorageService`: synchronous load in the constructor (`readFileSync`; missing or corrupt file → `{}` with a console warning; a corrupt file is renamed to `*.corrupt-<n>`). Atomic writes (write `*.tmp`, then `rename`), debounced at 250ms with an explicit `flush()` called on `before-quit`. Add typed accessors for a `Settings` interface: `{ jiraUrl?: string, themeSource?: 'system'|'light'|'dark', mainWindow?: { bounds, isMaximized } }`, stored in `settings.json`. WindowManager keeps its own `window-states.json` through the same service. The load race is fixed by the synchronous load.
- Unit tests (`tests/unit/StorageService.test.ts`, mocking `electron`'s `app.getPath` to a temp dir) cover: missing file, corrupt file quarantined, round-trip, atomic write leaves no `.tmp`, debounce coalesces, and `flush` writes immediately.

### Task 7: First-run, load-failure recovery, theme, single instance, persistence wiring

- Startup:
  - If there is no saved `jiraUrl`, the main window loads a local `welcome` view, built as dialog mode `'welcome'` or a small local page with the same preload/CSP rules, and opens the set-url dialog.
  - Otherwise it loads the saved URL.
  - Saving a URL in the dialog persists it, then loads it.
  - The startup URL is never `id.atlassian.com/login` or bare `atlassian.net`.
- Main window bounds and maximized state persist and are restored. Bounds are clamped to a visible display using `screen.getAllDisplays()`. Off-screen bounds fall back to the default centered size.
- `did-fail-load` on the main frame, ignoring `errorCode === -3` (aborted), loads a local error view showing the failed URL as text, with Retry (reload the failed URL) and Change URL (open the dialog). It uses the same sandboxed local-page pattern, and its IPC is validated per sender.
- Theme: replace "Toggle Dark Mode" with a View → Appearance submenu of radio items System / Light / Dark. Set `nativeTheme.themeSource`, persist it, and restore it at startup.
- `app.requestSingleInstanceLock()`. If it is not acquired, quit. On `second-instance`, restore and focus the main window.
- Tests:
  - e2e: first run shows the welcome view and opens the dialog.
  - e2e: saved URL persisted across a relaunch with the same userData dir. Served by the interceptor; assert the main window URL.
  - e2e: interceptor-forced failure (respond with a network error) shows the error view, and Retry reloads.
  - e2e: theme radio persists across relaunch.
  - e2e: bounds persist across relaunch.
  - unit: bounds clamping helper.

### Task 8: Browser-parity UX

- Use the menu (on the Electron 44 navigation API, `webContents.navigationHistory`).
  - Back/Forward: accelerators `CmdOrCtrl+[` / `CmdOrCtrl+]` on macOS, `Alt+Left` / `Alt+Right` elsewhere. Disable the items when history can't move. Add macOS `swipe` on BrowserWindow and Windows/Linux `app-command` (`browser-backward`/`browser-forward`). These apply to the focused content window (main or WindowManager).
  - Copy Current URL (`CmdOrCtrl+Shift+C`) and Open in Browser (`CmdOrCtrl+Shift+O`). Open in Browser goes through `isSafeExternalUrl`.
- Find in page (`CmdOrCtrl+F`): a small find bar in a sandboxed local page attached as a child `WebContentsView` overlay (or a small frameless child window if that's simpler; record the choice). It has an input, Enter = next, Shift+Enter = previous, Esc closes and calls `stopFindInPage('clearSelection')`, and a match count from `found-in-page`. It uses its own minimal preload, and its IPC is validated per sender.
- User agent: set `app.userAgentFallback` to the default UA with the `Electron/<v>` token and the `jira-desktop-app/<v>` (or productName) token removed. Unit-test the pure UA-sanitising function.
- Tests:
  - e2e: back/forward after two intercepted navigations.
  - e2e: Copy URL puts the URL on the clipboard.
  - e2e: Open in Browser calls the stubbed openExternal with an https URL, and not for a non-safe scheme.
  - e2e: find returns a match count on an intercepted page with known text.
  - unit: the UA sanitiser.

### Task 9: Release pipeline hardening

- `package.json` `build`:
  - `publish: [{ provider: 'github', owner: 'JoshWay', repo: 'jira-desktop' }]`.
  - mac targets `dmg` + `zip` (x64 + arm64), `hardenedRuntime: true`, `entitlements` and `entitlementsInherit` → `build/entitlements.mac.plist` containing only `com.apple.security.cs.allow-jit` and `com.apple.security.network.client`, plus `notarize` left to env-driven defaults.
  - win target `nsis` (replacing `msi`).
  - linux unchanged.
  - Drop the explicit `node_modules/**/*` from `files`.
  - Set `electronFuses` as listed in spec R5.
  - Remove the `clean-blockmap` script and its use (blockmaps are needed for differential updates). `clean` also removes `release`.
- Remove the `setFeedURL` call in main.ts (rely on the generated `app-update.yml`). Skip update checks when `!app.isPackaged`. Make "Skip This Version" persist via StorageService and actually suppress that version.
- Icons: resolve the app icon via `app.isPackaged ? join(process.resourcesPath, 'resources', 'icon.png') : join(app.getAppPath(), 'resources', 'icon.png')`. Product icons that don't exist (`jira-icon.png` etc.) fall back to the app icon. Unit-test the resolver.
- `.github/workflows/release.yml`:
  - Triggers: push to `main`, `dev` and tags `v*`; PRs to `main` and `dev`.
  - Top-level `permissions: contents: read`. The release job alone gets `contents: write`.
  - Pin every action to a full commit SHA with a `# vX.Y.Z` comment. Resolve SHAs via `gh api repos/<owner>/<repo>/git/ref/tags/<tag>` (dereference annotated tags).
  - Node 22. Steps: `npm ci`, `npm run typecheck`, `npm test`, and e2e on all three OSes (`xvfb-run -a` on Linux).
  - Build with `--publish never` on non-tag builds.
  - Upload `release/*.{dmg,zip,exe,AppImage,deb,rpm}` plus `release/latest*.yml` and `release/*.blockmap`.
  - The release job passes all of these to the pinned release action.
- Acceptance: `npx electron-builder --dir --mac --arm64 -c.mac.identity=null` succeeds locally, and `npx @electron/fuses read --app <the .app>` shows the fuses set. Paste both outputs in the report. Validate the workflow YAML parses (e.g. `npx yaml-lint` or a node one-liner with the `yaml` package if present; otherwise python `yaml`).

### Task 10: Docs and repository hygiene

- Rewrite `README.md` to describe actual behaviour: install, first-run, menus and shortcuts, security model summary, building (`npm ci`, `npm run dist`), testing, Node ≥22.12, releases. Remove claims that are not implemented.
- Rewrite `CLAUDE.md` for this project: stack, commands (typecheck/test/test:e2e/build/dist), architecture (main/security policy/dialogs/WindowManager/StorageService), invariants (Global Constraints security rules), and the branch model (`feature/*` → `dev` → `main`). Keep `WARP.md` as a symlink to it.
- Add an ISC `LICENSE` file matching `package.json`'s declared license, with copyright holder `JoshWay` and year 2025.
- Check that no source still references deleted files, and that `npm run typecheck && npm test && npm run test:e2e` all pass.
