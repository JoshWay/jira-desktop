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

### Setup

```bash
# Install dependencies
npm install

# Build and preview the app
npm run build
npm run preview

# Or run development mode (shows config interface)
npm run dev

# Package for distribution
npm run dist
```

## 🎯 How to Use

### First Time Setup

1. **Run the app**: `npm run build && npm run preview`
2. **Configure Jira URL**: 
   - The app opens to `https://atlassian.net` by default
   - Press `Cmd+U` (Mac) or `Ctrl+U` (Windows/Linux) to open URL configuration
   - Enter your company's Jira URL (e.g., `yourcompany.atlassian.net`)
   - The app will automatically navigate to your Jira instance

### Daily Usage

- App launches directly to your configured Jira instance
- Use `Cmd+Shift+D` / `Ctrl+Shift+D` to toggle dark mode
- Use `Cmd+U` / `Ctrl+U` to change Jira URL anytime

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

### Common Issues

**"Page Unavailable" Error:**
1. Press `Cmd+U` / `Ctrl+U` to configure your Jira URL
2. Enter your company's URL (e.g., `yourcompany.atlassian.net`)
3. Ensure your Jira instance is accessible in a regular browser

**App Won't Load:**
1. Check that your Jira URL is accessible
2. Try clearing app data (varies by platform)
3. Verify network connectivity

## 📄 License

ISC License - See LICENSE file for details.

---

**Previous Version**: Used deprecated Nativefier (Electron 10.1.6)  
**Current Version**: Modern Electron 32+ with TypeScript and Electron Builder