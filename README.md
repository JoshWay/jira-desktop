# Modern Jira Desktop App

A modern, secure desktop wrapper for Atlassian Jira built with Electron, TypeScript, and Electron Builder.

## 🚀 Features

- **Modern Stack**: Electron 32+ with TypeScript
- **Native Dark Mode**: System-aware theme switching with manual toggle
- **Cross-Platform**: Windows, macOS, and Linux support
- **Security Focused**: Sandboxed renderer with context isolation
- **Direct Jira Access**: Loads your Jira instance directly in the app
- **Configurable**: Easy Jira URL configuration via native dialog

## 🏗️ Architecture

```
src/
├── main/          # Electron main process (Node.js)
│   └── main.ts    # App initialization, window management
├── preload/       # Secure bridge between main/renderer
│   └── preload.ts # Context-isolated API exposure
└── renderer/      # Frontend UI (web technologies) - only used in dev mode
    ├── index.html # Development configuration interface  
    ├── style.css  # Modern CSS with theme support
    └── app.js     # Frontend logic
```

## 🛠️ Development

### Prerequisites

- Node.js 18+
- npm (yarn not supported - package-lock.json is used)

### Quick Start (3 Steps)

**Step 1: Install**
```bash
npm install
```

**Step 2: Build & Launch**
```bash
npm run build && npm run preview
```

**Step 3: Configure Your Jira**
- App opens showing "Page Unavailable" - this is expected
- Press `Cmd+U` (Mac) or `Ctrl+U` (Windows/Linux) 
- Enter your company Jira URL: `yourcompany.atlassian.net`
- Click "Set URL" - app redirects to your Jira login

✅ **Done!** The app now launches directly to your Jira instance.

### Development Mode
```bash
npm run dev    # Shows configuration interface instead of Jira
```

### Package for Distribution
```bash
npm run dist   # Creates installer packages in dist/ folder
```

## ⌨️ Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| `Cmd+U` / `Ctrl+U` | Configure Jira URL |
| `Cmd+Shift+D` / `Ctrl+Shift+D` | Toggle Dark Mode |
| `Cmd+R` / `Ctrl+R` | Reload Page |
| `Cmd+Shift+I` / `Ctrl+Shift+I` | Toggle Developer Tools |
| `Cmd+Q` / `Ctrl+Q` | Quit Application |

## 📦 Building

### Development Build
```bash
npm run build
npm run preview
```

### Production Distribution
```bash
# Build for current platform
npm run dist

# Build for all platforms
npm run dist:all
```

## 🎨 Theme Support

The app includes native dark mode support:

- **System Detection**: Automatically detects your system's dark/light mode preference
- **Manual Toggle**: `Cmd/Ctrl + Shift + D` or via menu "Jira Desktop" → "Toggle Dark Mode"
- **Real-time Updates**: Changes immediately when you toggle system theme

## 🔒 Security Features

- **Context Isolation**: Renderer process is sandboxed with secure preload scripts
- **External Links**: Safely opens external links in default browser
- **URL Validation**: Only allows Atlassian domains and configured URLs
- **No Node Access**: Renderer has no direct access to Node.js APIs

## 📱 Platform Support

| Platform | Architecture | Package Type |
|----------|-------------|--------------|
| macOS    | x64, arm64  | DMG, PKG     |
| Windows  | x64         | NSIS, MSI    |
| Linux    | x64         | AppImage, deb, rpm |

## 🔄 Migration from Old Version

This modernizes the previous Nativefier-based implementation with:

- ✅ **Security**: Updated from Electron 10 → 32+
- ✅ **Maintainability**: TypeScript + modern tooling
- ✅ **Features**: Native menus, themes, auto-updates
- ✅ **Cross-platform**: Proper multi-platform builds
- ✅ **Performance**: Optimized bundle size

## 🐛 Troubleshooting

### Development Issues

```bash
# Clear build cache
npm run clean

# Reinstall dependencies
rm -rf node_modules package-lock.json
npm install
```

### If Something Goes Wrong

**Seeing "Page Unavailable"?** ✅ This is normal on first run
1. Press `Cmd+U` (Mac) or `Ctrl+U` (Windows/Linux)
2. Type: `yourcompany.atlassian.net` (replace with your company name)
3. Click "Set URL"

**App won't start?**
```bash
npm run clean
npm install
npm run build
npm run preview
```

**Still having issues?**
- Ensure your Jira URL works in a regular web browser first
- Check that Node.js 18+ is installed: `node --version`

## 📄 License

ISC License - See LICENSE file for details.

---

**Previous Version**: Used deprecated Nativefier (Electron 10.1.6)  
**Current Version**: Modern Electron 32+ with TypeScript and Electron Builder