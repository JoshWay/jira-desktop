# Jira Desktop

A desktop app for Atlassian Jira on macOS, Windows and Linux. It opens your Jira site in its own window, adds browser-style navigation and find, and keeps remote content locked down: Atlassian pages run sandboxed, with no Node.js access, no preload script and no IPC.

Built with Electron 44, TypeScript, electron-vite and electron-builder.

## Install

Download the latest build from [GitHub Releases](https://github.com/JoshWay/jira-desktop/releases/latest). Files are named `Jira-Desktop-<version>-<os>-<arch>.<ext>`.

| Platform | Packages | Architectures |
|----------|----------|---------------|
| macOS | `.dmg` (install) and `.zip` (used by the updater) | Apple Silicon (`arm64`) and Intel (`x64`) |
| Windows | NSIS installer (`.exe`) | `x64` |
| Linux | `.AppImage`, `.deb`, `.rpm` | `x64` |

- **macOS:** open the `.dmg` and drag Jira Desktop to Applications.
- **Windows:** run the installer.
- **Linux:** run the AppImage after `chmod +x`, or install the package (`sudo apt install ./<file>.deb`, `sudo dnf install ./<file>.rpm`).

macOS releases are signed with a Developer ID certificate and notarized by Apple, so they open with no warning. To check a copy, run this and look for `source=Notarized Developer ID` and the publisher's name on the `origin=` line:

```bash
spctl --assess --type execute --verbose=2 "/Applications/Jira Desktop.app"
```

If macOS warns that a copy downloaded from [Releases](https://github.com/JoshWay/jira-desktop/releases) "cannot be opened" or "cannot be verified", do not bypass the warning. Delete the copy and [open an issue](https://github.com/JoshWay/jira-desktop/issues). Windows SmartScreen asks you to confirm an unsigned installer under More info › Run anyway.

## First run

On first launch there is no saved site, so the main window shows a short placeholder and a **Welcome** dialog asks for your Jira address.

- Enter `your-team.atlassian.net`, a deep link (`your-team.atlassian.net/jira/software/projects/ABC/boards/1`) or a self-hosted site (`https://jira.example.com`, `http://localhost:8080`).
- `https://` is added when no scheme is given, and Atlassian Cloud hosts always use https. A bare `*.atlassian.net` address opens `/jira`; any other path is kept as entered.
- Atlassian's own login and marketing pages (`id.atlassian.com`, `atlassian.net`, `www.atlassian.net`) are rejected, as are addresses with a username or password and schemes other than http and https.
- **Not Now** closes the dialog. Use **Jira Desktop › Set Jira URL…** later.

The address is saved and opened at every launch. If a page fails to load in the main window, a dialog shows the address that failed, with **Retry** and **Change URL**.

Only one copy of the app runs per profile. Launching it again brings the running window forward.

## Menus and shortcuts

`Cmd` on macOS, `Ctrl` on Windows and Linux.

| Menu | Item | Shortcut |
|------|------|----------|
| Jira Desktop | About | |
| Jira Desktop | Set Jira URL… | `Cmd/Ctrl+U` |
| Jira Desktop | Check for Updates… | |
| Jira Desktop | New Atlassian Window… | `Cmd/Ctrl+Shift+N` |
| Jira Desktop | Close All Windows (the extra Atlassian windows) | `Cmd/Ctrl+Shift+W` |
| Jira Desktop | Hide, Hide Others, Show All (macOS) | `Cmd+H`, `Cmd+Option+H`, none |
| Jira Desktop | Quit (Exit on Windows) | `Cmd/Ctrl+Q` (none on Windows) |
| Edit | Undo, Redo, Cut, Copy, Paste, Select All | standard |
| Edit | Find… | `Cmd/Ctrl+F` |
| View | Reload / Force Reload | `Cmd/Ctrl+R` / `Cmd/Ctrl+Shift+R` |
| View | Toggle Developer Tools, Actual Size, Zoom In, Zoom Out | standard |
| View | Appearance › System / Light / Dark | |
| View | Toggle Full Screen | standard |
| Go | Back / Forward | `Cmd+[` / `Cmd+]` on macOS, `Alt+Left` / `Alt+Right` elsewhere |
| Go | Copy Current URL | `Cmd/Ctrl+Shift+C` |
| Go | Open in Browser | `Cmd/Ctrl+Shift+O` |
| Window | Minimize, Close | standard |

- **Back / Forward** also work with a three-finger swipe on macOS and with the mouse back/forward buttons on Windows and Linux. They skip the app's own pages and any page the current site settings no longer allow, and are greyed out when there is nowhere to go.
- **Find** opens a small bar at the top right of the window with a match count. `Enter` goes to the next match, `Shift+Enter` to the previous one, and `Esc` closes the bar. The bar closes when the window loads a new page.
- **Copy Current URL** and **Open in Browser** act on the page's http(s) address. They do nothing on the app's own pages.
- **Appearance** sets the color scheme the app reports to pages and its own dialogs. Atlassian sites that follow the system theme follow it too. The choice is saved.
- **New Atlassian Window** opens an Atlassian address (or a page on your own site) in a separate window, with a product choice (auto-detect, Jira, Confluence, Bitbucket, Trello) and an option to open it in the background. Asking for the same product and page again focuses the window that is already open. These windows share the main window's login and remember their size and position.
- Right-clicking in the main window offers Copy / Cut / Paste where they apply, **Open … in New Window / in Background** for Atlassian links, and Back, Forward and Reload.

On macOS, closing windows leaves the app running. Clicking the Dock icon opens a new main window only when no app window is open. If an extra Atlassian window is still open, close it first (**Close All Windows**, `Cmd+Shift+W`) and then click the Dock icon, or quit and reopen the app. On Windows and Linux, the app quits when its last window closes.

## How links behave

| Where a link goes | What happens |
|-------------------|--------------|
| `https://` Atlassian hosts (`*.atlassian.net`, `*.atlassian.com`, `bitbucket.org`, `trello.com`) or your configured site | Opens in the app. If it asked for a new window, it opens in the window it came from. |
| A supported sign-in provider (Google, Microsoft, Apple, Okta, OneLogin, Auth0, Duo, Ping Identity) | Allowed in the app. Sign-in popups open as locked-down child windows. |
| Any other `http`, `https` or `mailto` address | Opens in your default browser or mail app. |
| Anything else (`file:`, `javascript:`, custom schemes) | Blocked. |

Known limitation: single sign-on through an identity provider that is not on that list, such as a self-hosted ADFS server, opens in your browser instead, so the sign-in does not finish in the app.

## Settings and data

Everything lives in the app's user-data folder. Electron names it after the `name` in `package.json`, `jira-desktop-app`, not after the "Jira Desktop" display name:

| Platform | User-data folder |
|----------|------------------|
| macOS | `~/Library/Application Support/jira-desktop-app` |
| Windows | `%APPDATA%\jira-desktop-app` |
| Linux | `$XDG_CONFIG_HOME/jira-desktop-app`, which is `~/.config/jira-desktop-app` by default |


- `settings.json` stores the Jira address, the Appearance choice, the main window's size, position and maximized state, and any update version you chose to skip.
- `window-states.json` stores the size and position of extra Atlassian windows.
- Cookies and the Atlassian login are Electron's normal session storage in the same folder.

Files are written atomically. A file that cannot be parsed is renamed to `<name>.corrupt-<n>` and the app starts with defaults. Saved values are re-validated when they are read, so an edited `settings.json` can never load a `file:` or other non-web address. A saved window position that is no longer on any display falls back to the default size, centered.

Set `JIRA_DESKTOP_USER_DATA_DIR=/some/folder` to run the app against a different profile folder.

The app adds no telemetry of its own. Apart from the sites you open, packaged builds contact GitHub Releases to check for updates.

## Updates

Only packaged builds check for updates. They check once, a few seconds after launch, and again whenever you choose **Check for Updates…**. When a newer version exists, the app asks before downloading anything:

- **Update Now** downloads it in the background, then offers to restart and install.
- **Remind Me Later** does nothing until the next check.
- **Skip This Version** silences automatic checks for that version. A manual check still offers it, and any newer version is offered as usual.

Development builds never check. Choosing **Check for Updates…** in one says so.

Update integrity rests on the SHA-512 hashes in the release's `latest*.yml`. On Windows, electron-updater also verifies the installer's Authenticode publisher, but only for builds that were signed.

On macOS, an update installs only when it is signed to match the running app. A release built without the macOS signing credentials therefore publishes no macOS update feed (`latest-mac.yml`). Installed Mac copies get no update offer from it: the automatic check stays silent, and **Check for Updates…** says that this build cannot update itself, with an **Open Releases Page** button. Download that release's `.dmg` from GitHub Releases instead. On Windows and Linux a missing feed is a broken release, and **Check for Updates…** reports that the check failed.

## Security model

- Every window is sandboxed with context isolation, and `nodeIntegration` is never enabled anywhere.
- Remote content gets no preload script and no IPC. That covers the main window, extra Atlassian windows and sign-in popups.
- The app's own pages (the dialog, the find bar and the placeholder) ship with the app and have a strict Content-Security-Policy. The dialog and the find bar each have a minimal preload, and the main process checks every IPC call: it must come from that exact page, in the main frame of the expected window. All text is set with `textContent`, so nothing is ever built as HTML from page or user input.
- Every navigation, redirect and `window.open` goes through one URL policy, which matches hosts exactly or by dot-anchored suffix, never by substring. Remote content can never navigate to an app page, and a window with a preload can only show app pages.
- External links go to the OS only as parsed `http`, `https` or `mailto` URLs, through a single code path. `<webview>` is always refused.
- Permissions are denied except notifications, sanitized clipboard writes and fullscreen, and those only for in-app origins. Device permissions are always denied.
- The user agent is Chrome's own, without the `Electron/…` and app-name tokens, so Google sign-in accepts it.
- Packaged builds use the hardened runtime on macOS with only the `allow-jit` and `network.client` entitlements. Electron fuses turn off `ELECTRON_RUN_AS_NODE`, `NODE_OPTIONS` and the `--inspect` flags, turn on cookie encryption and asar integrity validation, and load the app only from its asar archive.

## Development

Requires Node.js 22.12 or newer, and npm. The repo uses `package-lock.json`.

```bash
git clone https://github.com/JoshWay/jira-desktop.git
cd jira-desktop
npm ci

npm run dev         # run with the electron-vite dev server
npm run build       # build main, preloads and pages into dist/
npm run preview     # run the built app
npm run typecheck   # main/preload (Node types), pages (DOM types), tests
```

`npm run dev` starts at first-run setup unless you have already saved a site. Pair it with `JIRA_DESKTOP_USER_DATA_DIR` to keep a throwaway profile.

### Tests

```bash
npm test            # unit tests (vitest)
npm run test:e2e    # builds, then end-to-end tests (Playwright driving Electron)
```

- **Unit tests** (`tests/unit/`) cover the pure policy and rules modules: URL policy, navigation policy, rate limits, dialog rules, storage, window bounds, updates, user agent, find and navigation rules, and the release tag check.
- **End-to-end tests** (`tests/e2e/`) launch the real built app. The harness in `tests/e2e/helpers/` keeps every run offline. It answers every http/https request inside the app, sends anything that slips past to a loopback sink that fails the test, and replaces `shell.openExternal`, `shell.openPath` and `dialog.showErrorBox` with recorders. Each launch gets a fresh temporary profile.
- E2E windows stay off-screen, transparent and unable to take focus, so a run does not take over your screen. A test fails if any window takes focus. For debugging only, `JIRA_DESKTOP_E2E_HEADED=1 npm run test:e2e` shows normal windows and skips the focus check. Never use it for a real gate run.
- On Linux the e2e tests need a display. CI runs them under `xvfb-run`.

## Building packages

```bash
npm run build && npm run dist   # packages for the current platform into release/
npm run dist:all                # macOS, Windows and Linux (needs a host that can build each)
npm run pack                    # unpacked app directory only, no installer
npm run clean                   # remove dist/, out/ and release/
```

Signing and notarization are skipped when no credentials are set. electron-builder reads them from the environment: `CSC_LINK` and `CSC_KEY_PASSWORD` (macOS certificate), `APPLE_API_KEY` (path to an App Store Connect `.p8` key), `APPLE_API_KEY_ID` and `APPLE_API_ISSUER` (notarization), and `WIN_CSC_LINK` and `WIN_CSC_KEY_PASSWORD` (Windows certificate).

On a Mac with a Developer ID certificate in the login keychain, `scripts/mac-local-install.sh` builds the app for that Mac, signs it, installs it to `~/Applications/Jira Desktop.app` (the same path every time, so macOS keeps the app's permissions) and opens it. Add `--notarize` to notarize as well, with `APPLE_API_KEY`, `APPLE_API_KEY_ID` and `APPLE_API_ISSUER` exported. Releases still come only from CI.

## Releases

`.github/workflows/release.yml` runs on pushes to `main` and `dev`, on every pull request whatever its base branch, and on `v*` tags.

1. On a `v*` tag, each build first checks that the tag is exactly `v` followed by the `version` in `package.json` (`scripts/release-version.mjs`). If it is not, the build fails before dependencies are installed.
2. On Ubuntu, Windows and macOS, it runs `npm ci`, the typecheck, the unit tests and the e2e tests, then builds and packages. On macOS it then launches the packaged app on a throwaway profile and fails unless the app finishes startup and stays running. It uploads the packages, the `latest*.yml` updater metadata and the blockmaps as workflow artifacts.
3. For a `v*` tag only, a release job publishes those files as a GitHub Release. The release is marked as a pre-release when the version has a semver pre-release part (`2.2.0-rc.1`). Build metadata (`2.2.0+build.5`) does not make it a pre-release.

To release, bump `version` in `package.json` on `dev`, merge to `main`, then tag that commit `v<version>`.

- Signing and notarization run only on `v*` tag builds, and only for the platforms whose secrets are set: `MAC_CSC_LINK`, `MAC_CSC_KEY_PASSWORD`, `APPLE_API_KEY_P8`, `APPLE_API_KEY_ID` and `APPLE_API_ISSUER` for macOS (in the `release` environment), `WIN_CSC_LINK` and `WIN_CSC_KEY_PASSWORD` for Windows. Branch pushes and pull requests are never signed. Do not create the Windows secrets until Windows signing moves into its own protected job (see `CLAUDE.md`).
- The released macOS build comes from its own jobs, which run only for `v*` tags after every test has passed. The app's JavaScript is built on a runner with no secrets; the signing job installs dependencies without running their install scripts and only packages, smoke-launches and verifies. Its secrets live in the protected `release` environment. Setup is in `CLAUDE.md` under "macOS signing setup".
- With `MAC_CSC_LINK` set, a missing or wrong certificate fails the build. A verify step then fails the release unless the app inside every `.dmg` and `.zip` passes `codesign --verify --deep --strict`, `spctl` reports `Notarized Developer ID`, and the notarization ticket is stapled, and unless `latest-mac.yml` lists exactly those zips for this version. So a Mac release is either fully signed and notarized, with its update feed, or unsigned without one.
- Without `MAC_CSC_LINK`, the macOS build is not signed with a Developer ID and cannot install as an in-app update. Set the repository variable `MAC_SIGNING_REQUIRED` to `true` to make such a tag build fail instead. The tag build then drops `latest-mac.yml` and the zip blockmaps and logs a warning. The `.dmg` and `.zip` are still published for manual download (see [Updates](#updates)). The Windows and Linux feeds are published either way.
- Third-party actions are pinned to commit SHAs, and only the release job has write permission.

## Contributing

- Branch from `dev` as `feature/<name>`, or as `hotfix/<name>` from `main` for urgent fixes. Open pull requests into `dev`. `main` only receives merges from `dev` (and hotfixes), and nothing is committed to `main` or `dev` directly.
- Use [Conventional Commits](https://www.conventionalcommits.org/): `feat:`, `fix:`, `docs:`, `test:`, `refactor:`, `chore:`.
- Before opening a PR, make sure `npm run typecheck`, `npm test` and `npm run test:e2e` all pass.
- Keep the security model above intact. [CLAUDE.md](CLAUDE.md) lists the invariants and the pattern for adding an app page.

## License

[ISC](LICENSE) © 2025 JoshWay

## Support

Report bugs and feature requests on [GitHub Issues](https://github.com/JoshWay/jira-desktop/issues). Report security vulnerabilities privately through GitHub security advisories.
