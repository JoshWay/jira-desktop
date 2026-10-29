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
│   │   ├── localPageIpc.ts         # handleFromLocalPage / handleFromAnyLocalPage (ipcMain.handle wrappers)
│   │   └── rateLimit.ts            # pure: token bucket for external opens, throttled drop logging
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

scripts/
├── release-version.mjs             # CI tag guard: tag must be v + package.json version; derives prerelease
├── release-feed.mjs                # CI: latest-mac.yml must list exactly the verified zips, each with its own SHA-512
├── assemble-release.mjs            # CI: take each platform's release files from its own artifact only
├── mac-local-install.sh            # macOS only: build, sign with the keychain identity, install to ~/Applications
└── mac-smoke-launch.sh             # CI: launch a packaged .app on a throwaway profile, require startup to finish
```

How it fits together:

- **Startup** (`main.ts`): in development builds only (`!app.isPackaged`), honours `JIRA_DESKTOP_USER_DATA_DIR` before anything reads userData, then takes the single-instance lock (a second launch focuses the first). It sets the sanitized `app.userAgentFallback` and calls `installWebContentsPolicy` before `ready`. Then it creates the main window. With a valid saved site it loads it. Otherwise it shows `placeholder.html` and opens the welcome dialog.
- **Main window**: remote content, with no preload. A real main-frame load failure (not `ERR_ABORTED`, not a local page) shows the placeholder and the load-error dialog. To load a site while the placeholder is up, main goes through `about:blank` first, because the placeholder is a local page and so counts as confined.
- **Settings** (`settings.json`): `jiraUrl`, `themeSource`, `mainWindow` (bounds + maximized) and `skippedVersion`. The saved `jiraUrl` is re-validated on every read (`resolveSavedSiteUrl`), because main's own `loadURL` bypasses `will-navigate`. To add a setting, add an optional field to `Settings` and a check to `sanitizeSettings`.
- **WindowManager** windows use the default session (they share the main window's login). They are remote content with the same prefs as the main window, and their saved bounds live in `window-states.json`. `NavigationController.attach` is called on each one, so they get Back/Forward and Find.
- **StorageService** loads synchronously in its constructor and writes atomically (tmp file, fsync, rename). Writes are debounced, and `flush()` runs on `before-quit` and `will-quit`. A corrupt file is renamed to `<file>.corrupt-<n>`. `get` and `set` return JSON copies.
- **Updates**: `UpdateController` never constructs the updater unless `app.isPackaged`. The feed is the `app-update.yml` that electron-builder generates from `build.publish`. `autoDownload` is false: nothing downloads until the user picks Update Now.
  - On macOS, a manual check that fails with `ERR_UPDATER_CHANNEL_FILE_NOT_FOUND` (the release has no `latest-mac.yml`) shows **Update by Download** with the current version and **Open Releases Page**, which opens the constant `RELEASES_URL` through `openExternalSafely` with `userInitiated: true`. Only the error `code` is trusted (`isMissingUpdateFeed`); the message carries network data and is never shown or parsed. On other platforms the same error keeps the generic warning.
  - On macOS, a failed download or install after Update Now shows the same dialog: that is also where Squirrel.Mac refuses an update whose signature does not match the running app (any copy that is not Developer ID signed). A manual check while another check runs says so.
- **Packaging** (`package.json` → `build`): fuses (RunAsNode off, NODE_OPTIONS off, CLI inspect off, cookie encryption on, asar integrity on, only-load-from-asar on), the hardened runtime and `build/entitlements.mac.plist` (allow-jit and network.client only). Icons come from `resources/`, copied via `extraResources`.
  - The user-data folder is named after the top-level `package.json` `name` (`jira-desktop-app`); `build.productName` only names the bundle and artifacts. Do not add a top-level `productName` without a profile migration: it would move every user's settings, cookies and login to a new, empty folder.
- **CI** (`.github/workflows/release.yml`): runs on pushes to `main`/`dev`, on every pull request (any base branch, so stacked PRs get the full matrix) and on `v*` tags. On ubuntu/windows/macos it runs typecheck, unit tests, e2e (under xvfb on Linux), build and package. On `v*` tags, `package-mac-release` builds the released Mac app and the `release` job publishes to GitHub Releases. Actions are pinned to SHAs, with `permissions: contents: read` except on the release job.
  - Tag builds first run `scripts/release-version.mjs`: the tag must be exactly `v` + `package.json` `version`, and the prerelease flag comes from the semver pre-release part, not a substring of the ref.
  - Signing secrets are passed to electron-builder on `v*` tag builds only. Branch pushes and PRs are never signed.
  - The matrix `build` job holds no signing secret at all. It runs dependency install scripts, the tests and pull request code, so everything it packages is unsigned (`CSC_IDENTITY_AUTO_DISCOVERY=false`): its Mac build is for the smoke launch and a PR artifact only, and Windows releases are unsigned until Windows signing gets its own protected job.
  - The released Mac build comes from two jobs, on `v*` tag pushes after the whole matrix passed, or on a rehearsal (`workflow_dispatch` from `main`, which publishes nothing: the `release` job runs on tag pushes only). `build-mac-release` (no secrets) runs `npm ci --ignore-scripts` and `npm run build` and uploads `dist/`, so the bundlers never run where the secrets are. `package-mac-release` (in the `release` environment) checks the commit is on `origin/main`, installs with `npm ci --ignore-scripts` (electron-builder downloads Electron itself), downloads `dist/` and packages with `-c.mac.forceCodeSigning=true -c.dmg.sign=true`, so a missing or wrong certificate fails the build. electron-builder notarizes the apps; the step then notarizes each `.dmg` with `notarytool` and requires `Accepted`. The `.dmg` files are not stapled, because stapling changes the bytes `latest-mac.yml` and the blockmaps describe. The notarization key is written to a `0600` temp file for that step only and deleted on exit.
  - Fail closed: without `MAC_CSC_LINK` the tag build (or rehearsal) fails, unless the repository variable `MAC_SIGNING_REQUIRED` is exactly `false`. Signing without the three notarization secrets fails too.
  - electron-builder 26 only *warns* when notarization credentials are missing, so "Verify the shipped macOS apps" is the notarization gate. It first turns Gatekeeper assessments on if the runner has them off (otherwise `spctl` reports `override=security disabled`) and fails if it cannot. Each `.dmg` must pass `codesign --verify --strict` and assess as `source=Notarized Developer ID` (`--type open --context context:primary-signature`). It mounts each `.dmg` and unpacks each `.zip` (what ships, not the build folder), and the app inside each must pass `codesign --verify --deep --strict`, report exactly `source=Notarized Developer ID` from `spctl`, and pass `xcrun stapler validate`. Then `scripts/release-feed.mjs` parses `latest-mac.yml` as YAML and requires the `package.json` version and exactly the verified zips, each with its own SHA-512. It runs after the release smoke launch, so nothing the launched app could change goes unchecked. Do not weaken that step.
  - An unsigned-on-purpose Mac build (`MAC_SIGNING_REQUIRED=false`) is not Developer ID signed, which Squirrel.Mac will not install as an update, so `package-mac-release` deletes `latest-mac.yml` and the zip blockmaps and the `release` job writes a notice at the top of the release notes. Mac users then download that release manually, and a manual update check in the app offers the releases page (see Updates).
  - Every macOS packaged build (the matrix leg, and the release build after signing) is smoke-launched by `scripts/mac-smoke-launch.sh`: native arch, stripped environment, on the app's real profile path, which is empty on a fresh runner (packaged builds ignore `JIRA_DESKTOP_USER_DATA_DIR`; anywhere but a GitHub-hosted runner the script refuses to run against an existing profile). It logs whether the runner has Gatekeeper assessments on. With `JIRA_DESKTOP_SMOKE_TEST=1` the app writes `smoke-startup-complete` into its profile as the last step of startup (`main.ts`, exclusive create, so it never writes through a symlink); the script fails unless that file appears and the process is still alive afterwards. It is the only check of the fused, hardened packaged app (Playwright cannot drive it: the `--inspect` fuse is off).
  - The `release` job downloads each platform's artifact separately and `scripts/assemble-release.mjs` copies only that platform's file patterns (Linux: AppImage/deb/rpm/`latest-linux.yml`; Windows: exe/`latest.yml`; macOS from `package-mac-release` only: dmg/zip/`latest-mac.yml`). A missing required file or a name two platforms supply fails it. No leg can publish another platform's update feed.
  - Never add `set -x`, `DEBUG=electron-builder` or a job-level `env` with secrets: electron-builder's debug log prints the `.p12` password in `security set-key-partition-list`.

### macOS signing setup (owner, once)

The protection comes from these GitHub settings, not from the workflow file: anyone who can push could edit the workflow on their own commit.

1. **Certificate.** In the Apple Developer Program, create a **Developer ID Application** certificate (a "Mac Developer" or "Apple Development" one is not accepted by Gatekeeper for downloads). Export it with its private key from Keychain Access as a `.p12` with a strong password.
2. **Notarization key.** In App Store Connect › Users and Access › Integrations, create a Team API key with the Developer role and download the `.p8` (shown once). Use this, not an Apple ID app-specific password: those also unlock the account's iCloud mail, contacts and calendars.
3. **Environment, before any secret and before any `v*` tag.** GitHub creates a missing environment automatically, with no rules, the first time a job names it, so set it up first. Repository Settings › Environments › New environment `release`. Under Deployment branches and tags choose "Selected" and add the tag rule `v*` and the branch rule `main` (for rehearsals) only. Add yourself as a required reviewer, and leave "Prevent self-review" off if you are the only reviewer. Save, and confirm the rules show before going on.
   - The `main` rule admits any job whose ref is `main`, whatever its event. So only `package-mac-release` in `release.yml` may name `environment: release`, and never in a workflow triggered by `pull_request_target`, `workflow_run`, `issue_comment` or anything else that can run pull request code.
   - Before approving a deployment, check the run's event and ref: a `v*` tag push is a release, `workflow_dispatch` on `main` is a rehearsal, and anything else should be rejected.
4. **Secrets, in that environment.** Do not use repository secrets: every same-repo pull request can read those, and a job in the environment would still see a repository secret with the same name. Delete any repository-level `MAC_*` or `APPLE_*` secrets. Pipe the values in so the private key never touches the clipboard, then delete the local files:

   ```bash
   base64 -i cert.p12 | gh secret set MAC_CSC_LINK --env release
   gh secret set MAC_CSC_KEY_PASSWORD --env release
   gh secret set APPLE_API_KEY_P8 --env release < AuthKey_XXXXXXXXXX.p8
   gh secret set APPLE_API_KEY_ID --env release
   gh secret set APPLE_API_ISSUER --env release
   ```

   Until these exist, every tag build fails at the Mac packaging step. To publish one release with an unsigned Mac build on purpose, set the repository variable `MAC_SIGNING_REQUIRED` to `false` for it, and delete the variable afterwards.

5. **Tag ruleset.** Settings › Rules › Rulesets › New tag ruleset targeting `v*`, restricting creation, update and deletion to you (bypass list), so no one else can start a release.
6. **Branch protection on `main`** (pull requests and passing checks required), so the "tag is on main" check means "reviewed".
7. **Rehearse before the first real tag.** Actions › Build and Release › Run workflow, on `main`. Approve the `release` deployment when asked. The run signs, notarizes, smoke-launches and verifies the Mac release and keeps the `.dmg` and `.zip` files (no update feed) as the `rehearsal-macOS` artifact for 1 day; it publishes nothing. Then bump `version` and tag.
8. **Windows.** Windows builds are unsigned: the workflow passes no Windows signing secret anywhere. Do not create `WIN_CSC_LINK` or `WIN_CSC_KEY_PASSWORD` until Windows signing has its own environment-protected job, the way `package-mac-release` works (and set `build.win.publisherName` then, not before: on an unsigned build it would make every Windows update fail its signature check).

For a signed build on your own Mac, use `scripts/mac-local-install.sh` (signs with the login-keychain identity; `--notarize` notarizes too with an API key). It never produces release artifacts. To open an unsigned build you made yourself (a PR artifact from your own CI run), use System Settings › Privacy & Security › Open Anyway. Never tell users to strip the quarantine attribute.

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

- **Unit** (`tests/unit/`): logic lives in pure modules with no electron imports (`*Rules.ts`, `urlPolicy.ts`, `navigationPolicy.ts`, `localPageSender.ts`, `rateLimit.ts`, `userAgent.ts`, `windowBounds.ts`, `appIcon.ts`, `scripts/release-version.mjs`, `scripts/release-feed.mjs`, `scripts/assemble-release.mjs`), so vitest runs them in Node. Electron-facing classes are tested with fakes where practical (`StorageService`, `WindowManager`, `UpdateController`, `ContextMenuService`).
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
- Releases: bump `version` in `package.json`, merge `dev` to `main`, and tag exactly `v<version>` (CI refuses any other tag). The workflow publishes the GitHub Release.
- `.gitrules` has the full rules for LLM assistants (worktrees, safety checks).
