# Modern Jira Desktop App

A modern, secure desktop wrapper for Atlassian Jira built with Electron, TypeScript, and Electron Builder.

## 🚀 Features

- **Modern Stack**: Electron 32+ with TypeScript
- **Native Dark Mode**: System-aware theme switching
- **Cross-Platform**: Windows, macOS, and Linux support
- **Security Focused**: Sandboxed renderer with context isolation
- **Auto-Updates**: Built-in update mechanism
- **Configurable**: Easy Jira URL configuration

## 🏗️ Architecture

```
src/
├── main/          # Electron main process (Node.js)
│   └── main.ts    # App initialization, window management
├── preload/       # Secure bridge between main/renderer
│   └── preload.ts # Context-isolated API exposure
└── renderer/      # Frontend UI (web technologies)
    ├── index.html # Configuration interface
    ├── style.css  # Modern CSS with theme support
    └── app.js     # Frontend logic
```

## 🛠️ Development

### Prerequisites

- Node.js 18+
- npm or yarn

### Setup

```bash
# Install dependencies
npm install

# Start development server
npm run dev

# Build for production
npm run build

# Package for distribution
npm run dist
```

### Configuration

Before building, update your Jira URL in the configuration interface or modify the default in `src/main/main.ts`:

```typescript
private jiraUrl: string = 'https://YOUR_COMPANY_NAME.atlassian.net/jira/projects'
```

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

The app includes native dark mode support that follows your system preferences:

- **Automatic**: Follows system theme
- **Manual Toggle**: `Cmd/Ctrl + Shift + D`
- **Persistent**: Remembers user preference

## 🔒 Security Features

- **Context Isolation**: Renderer process is sandboxed
- **CSP**: Content Security Policy enforcement
- **External Links**: Safe handling of external URLs
- **URL Validation**: Atlassian domain restrictions

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

### Runtime Issues

1. Check that your Jira URL is accessible
2. Verify CORS settings in Jira admin
3. Try clearing app data (varies by platform)

## 📄 License

ISC License - See LICENSE file for details.

---

**Previous Version**: Used deprecated Nativefier (Electron 10.1.6)  
**Current Version**: Modern Electron 32+ with TypeScript and Electron Builder