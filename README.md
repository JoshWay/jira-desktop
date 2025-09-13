# Modern Jira Desktop App

A modern, secure desktop wrapper for Atlassian Jira built with Electron, TypeScript, and Electron Builder.

## 🚀 Features

- **Modern Stack**: Electron 32+ with TypeScript
- **Native Dark Mode**: System-aware theme switching with manual toggle
- **Cross-Platform**: Windows, macOS, and Linux support
- **Security Focused**: Sandboxed renderer with context isolation
- **Direct Jira Access**: Loads your Jira instance directly in the app
- **Configurable**: Easy Jira URL configuration via native dialog

## 📦 Installation

### Quick Install (Recommended)

**Don't want to clone the repo?** Download a pre-built installer from the [latest release](../../releases/latest):

- **Windows**: Download `jira-desktop-app-2.0.0.msi` and run it
- **macOS**: Download `Jira Desktop-2.0.0.dmg`, mount it, and drag to Applications
- **Linux**: Download `Jira Desktop-2.0.0.AppImage`, make executable, and run

### Build from Source

**Want to customize or contribute?** Clone and build:

```bash
# Clone the repository
git clone https://github.com/JoshWay/jira-desktop.git
cd jira-desktop

# Install dependencies  
npm install

# Build and launch
npm run build && npm run preview
```

**First Launch Setup:**
1. App opens showing "Page Unavailable" - this is expected
2. Press `Cmd+U` (Mac) or `Ctrl+U` (Windows/Linux) 
3. Enter your company Jira URL: `yourcompany.atlassian.net`
4. Click "Set URL" - app redirects to your Jira login

✅ **Done!** The app now launches directly to your Jira instance.

### Build Your Own Installer

```bash
# Build for your current platform
npm run dist

# Build for all platforms (macOS, Windows, Linux)
npm run dist:all
```

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

### Development Mode
```bash
npm run dev    # Shows configuration interface instead of Jira
```

### Manual Installation Commands

If you prefer individual steps instead of the Quick Install above:

```bash
# Linux
chmod +x dist/Jira\ Desktop-2.0.0.AppImage && ./dist/Jira\ Desktop-2.0.0.AppImage
# Or: sudo dpkg -i dist/jira-desktop-app_2.0.0_amd64.deb
# Or: sudo rpm -i dist/jira-desktop-app-2.0.0.x86_64.rpm

# macOS 
open dist/Jira\ Desktop-2.0.0.dmg
# Then drag "Jira Desktop" to Applications folder

# Windows
msiexec /i dist/jira-desktop-app-2.0.0.msi
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

## 📦 Installer Files You Get

### Linux
- `Jira Desktop-2.0.0.AppImage` - Portable app (no installation needed)
- `jira-desktop-app_2.0.0_amd64.deb` - For Ubuntu/Debian
- `jira-desktop-app-2.0.0.x86_64.rpm` - For RedHat/Fedora/SUSE
- NPM package (coming soon for global installation)

### macOS  
- `Jira Desktop-2.0.0.dmg` - Drag-to-install disk image
- Supports both Intel (x64) and Apple Silicon (arm64)

### Windows
- `jira-desktop-app-2.0.0.msi` - MSI installer package
- Creates Start Menu shortcut with Jira icon

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