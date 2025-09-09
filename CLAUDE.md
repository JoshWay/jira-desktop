# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

This is a cross-platform Electron wrapper that creates desktop applications for Atlassian Jira using Nativefier. The project creates two app variants: a standard version and a dark mode version using the DarkReader library.

## Essential Commands

### Building Applications
- `yarn build` - Build both standard and dark mode versions
- `yarn build:all` - Same as `yarn build` 
- `yarn build:jira` - Build standard Jira desktop app only
- `yarn build:jira-dark` - Build dark mode Jira desktop app only

### Setup
- `yarn install` - Install dependencies (nativefier)

## Architecture

### Project Structure
```
src/
├── common/          # Shared resources
│   ├── darkreader.js    # Dark Reader library for dark mode
│   └── jquery.min.js    # jQuery library
└── jira/            # Jira-specific build configurations
    ├── build.js         # Standard app builder
    ├── build-dark.js    # Dark mode app builder  
    ├── script.js        # Injected script for dark mode
    └── icon.png         # App icon
```

### Key Technologies
- **Nativefier**: Electron wrapper generator (v11.0.2)
- **DarkReader**: Dark mode implementation
- **Target Electron Version**: 10.1.6

### Build Configuration
Both build scripts use Nativefier with these shared settings:
- Target URL: `https://{YOUR_COMPANY_NAME}.atlassian.net/jira/projects`
- Default window size: 1200x900
- Output directory: `./dist`
- User agent: Firefox 83.0 on Windows
- Internal URLs pattern: `.*?\.atlassian\.*?`

### Customization Required
Before building, replace `{YOUR_COMPANY_NAME}` in both:
- `src/jira/build.js` (line 7)
- `src/jira/build-dark.js` (line 7)

### Dark Mode Implementation
The dark mode version (`build-dark.js`) differs by:
1. Injecting `script.js` which loads DarkReader
2. Copying `darkreader.js` to the built app's resources after compilation
3. Using DarkReader settings: brightness 100%, contrast 90%, sepia 10%

### Platform Support
Builds native apps for the current platform (Windows, macOS, Linux). Cross-platform builds require building on the target platform.

### Output Location
Built applications are placed in `./dist/` directory with platform-specific naming conventions.