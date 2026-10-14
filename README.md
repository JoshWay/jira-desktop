# Jira Desktop App

A modern, cross-platform desktop application for Atlassian Jira built with Electron 32+, TypeScript, and Electron Builder.

## Features

- **Modern Technology Stack**: Built with Electron 32+ and TypeScript for reliability and maintainability
- **Cross-Platform Support**: Native applications for Windows, macOS, and Linux
- **Security Focused**: Sandboxed renderer process with context isolation and secure preload scripts
- **Native Dark Mode**: System-aware theme detection with manual toggle support
- **Auto-Update System**: Built-in update checking and installation capabilities
- **Native Integration**: System tray, native menus, and keyboard shortcuts
- **URL Configuration**: Easy Jira instance configuration through native dialogs

## Installation

### Pre-built Releases

Download the latest release from [GitHub Releases](https://github.com/JoshWay/jira-desktop/releases/latest):

#### Linux

- **AppImage**: `Jira Desktop-2.1.0.AppImage` - Universal portable application
- **Debian/Ubuntu**: `jira-desktop-app_2.1.0_amd64.deb` - Native package
- **RPM**: `jira-desktop-app-2.1.0.x86_64.rpm` - For RedHat/Fedora/SUSE

#### Windows

- **MSI Installer**: `Jira Desktop-2.1.0.msi` - Windows installer package

#### macOS

- **Intel Macs**: `Jira Desktop-2.1.0.dmg` - x64 architecture
- **Apple Silicon**: `Jira Desktop-2.1.0-arm64.dmg` - ARM64 architecture

### Installation Instructions

#### Linux Installation

```bash
# AppImage (Recommended)
chmod +x "Jira Desktop-2.1.0.AppImage"
./Jira\ Desktop-2.1.0.AppImage

# Debian/Ubuntu
sudo dpkg -i jira-desktop-app_2.1.0_amd64.deb

# RPM-based distributions
sudo rpm -i jira-desktop-app-2.1.0.x86_64.rpm
```

#### Windows Installation

1. Download `Jira Desktop-2.1.0.msi`
2. Run the installer as administrator
3. Launch from Start Menu

#### macOS Installation

1. Download the appropriate DMG for your Mac architecture
2. Open DMG and drag app to Applications folder
3. Launch from Applications (may need to right-click → Open on first launch)

## Development Setup

### Prerequisites

- Node.js 18 or higher
- npm (package-lock.json is used, not yarn)

### Building from Source

```bash
# Clone the repository
git clone https://github.com/JoshWay/jira-desktop.git
cd jira-desktop

# Install dependencies
npm install

# Development mode
npm run dev

# Build for production
npm run build

# Preview production build
npm run preview
```

### Creating Distribution Packages

```bash
# Build for current platform only
npm run dist

# Build for all platforms (requires platform-specific build environments)
npm run dist:all

# Build directory-only (no installer)
npm run pack

# Clean build artifacts
npm run clean
```

## Configuration

### First Launch Setup

1. Launch the application
2. Press `Ctrl+U` (Linux/Windows) or `Cmd+U` (macOS) to open URL configuration
3. Enter your Jira instance URL (e.g., `yourcompany.atlassian.net`)
4. Click "Set URL" to save and redirect to your Jira login

### Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| `Ctrl+U` / `Cmd+U` | Configure Jira URL |
| `Ctrl+Shift+D` / `Cmd+Shift+D` | Toggle Dark Mode |
| `Ctrl+R` / `Cmd+R` | Reload Page |
| `Ctrl+Shift+I` / `Cmd+Shift+I` | Toggle Developer Tools |
| `Ctrl+Q` / `Cmd+Q` | Quit Application |

## Architecture

```text
src/
├── main/                      # Electron main process
│   ├── main.ts               # Application entry point
│   └── services/             # Core services
│       ├── ContextMenuService.ts    # Right-click context menus
│       ├── StorageService.ts        # Configuration persistence
│       └── WindowManager.ts         # Window lifecycle management
├── preload/                   # Secure bridge between main and renderer
│   └── preload.ts            # Context-isolated API exposure
└── renderer/                  # Frontend UI (development interface)
    ├── index.html            # Development configuration interface
    ├── style.css             # Styling with dark mode support
    └── app.js               # Frontend application logic
```

## Technical Details

- **Electron Version**: 32.3.3
- **Build System**: Electron Vite + Electron Builder
- **Supported Architectures**: x64 (Intel/AMD), ARM64 (Apple Silicon)
- **Minimum OS Requirements**:
  - Windows 10 or higher
  - macOS 10.12 (Sierra) or higher
  - Linux (most modern distributions)

## Security Features

- **Context Isolation**: Renderer process runs in a sandboxed environment
- **Preload Security**: Controlled API exposure through secure preload scripts
- **URL Validation**: Restricts navigation to Atlassian domains and configured URLs
- **External Link Handling**: Safely opens external links in the default browser
- **No Direct Node Access**: Renderer process cannot directly access Node.js APIs

## Theme Support

The application includes comprehensive dark mode support:

- **System Detection**: Automatically follows system dark/light mode preferences
- **Manual Override**: Toggle dark mode independently using keyboard shortcuts or menu
- **Real-time Updates**: Theme changes apply immediately without restart
- **Persistent Settings**: Theme preferences are saved and restored between sessions

## Auto-Update System

- **Automatic Checking**: Checks for updates on startup
- **Manual Checking**: Available through application menu
- **Background Downloads**: Updates download in the background
- **User Control**: Users can choose when to install updates

## Troubleshooting

### Common Issues

**Application won't start:**

```bash
npm run clean
npm install
npm run build
npm run preview
```

**"Page Unavailable" on first launch:**

This is expected behavior. Press `Ctrl+U` (or `Cmd+U` on macOS) to configure your Jira URL.

**macOS "App can't be opened" error:**

Right-click the application and select "Open" to bypass Gatekeeper on first launch.

**Linux AppImage won't run:**

Ensure the file has execute permissions: `chmod +x "Jira Desktop-2.1.0.AppImage"`

### Development Issues

**Build failures:**

- Ensure Node.js 18+ is installed: `node --version`
- Clear build cache: `npm run clean`
- Reinstall dependencies: `rm -rf node_modules package-lock.json && npm install`

**Permission errors on Windows:**

Run command prompt as administrator when building or installing.

## Migration from Previous Versions

This version represents a complete modernization from the previous Nativefier-based implementation:

- **Security**: Updated from Electron 10.1.6 to 32.3.3
- **Build System**: Migrated from Nativefier to Electron Builder with TypeScript
- **Features**: Added native menus, auto-updates, improved window management
- **Cross-platform**: Proper multi-platform builds with platform-specific optimizations
- **Maintainability**: Modern development stack with TypeScript and modular architecture

## Contributing

1. Fork the repository
2. Create a feature branch: `git checkout -b feature-name`
3. Make your changes and test thoroughly
4. Commit with clear, descriptive messages
5. Push to your fork and submit a pull request

### Development Guidelines

- Follow TypeScript best practices
- Maintain security isolation between main and renderer processes
- Test on multiple platforms when possible
- Update documentation for any new features or changes

## License

ISC License - See LICENSE file for details.

## Support

- **Issues**: Report bugs and feature requests on [GitHub Issues](https://github.com/JoshWay/jira-desktop/issues)
- **Documentation**: Additional documentation available in the project wiki
- **Security**: Report security vulnerabilities privately through GitHub security advisories
