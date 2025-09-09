// App initialization
class JiraDesktopApp {
  constructor() {
    this.initializeApp()
  }

  async initializeApp() {
    // Initialize theme
    await this.setupTheme()
    
    // Setup event listeners
    this.setupEventListeners()
    
    // Initialize system info
    this.displaySystemInfo()
    
    // Load saved Jira URL
    this.loadSavedConfig()
  }

  async setupTheme() {
    try {
      // Get current theme from main process
      const currentTheme = await window.electronAPI?.getTheme?.() || 'light'
      this.updateThemeDisplay(currentTheme)
      
      // Listen for theme changes
      window.electronAPI?.onThemeChanged?.(theme => {
        this.updateThemeDisplay(theme)
      })
    } catch (error) {
      console.warn('Theme API not available:', error)
    }
  }

  updateThemeDisplay(theme) {
    document.documentElement.setAttribute('data-theme', theme)
    const themeSpan = document.getElementById('current-theme')
    if (themeSpan) {
      themeSpan.textContent = theme
    }
  }

  setupEventListeners() {
    // Jira URL form submission
    const configForm = document.getElementById('config-form')
    if (configForm) {
      configForm.addEventListener('submit', (e) => {
        e.preventDefault()
        this.handleJiraUrlSubmit()
      })
    }

    // Theme toggle button
    const themeToggle = document.getElementById('theme-toggle')
    if (themeToggle) {
      themeToggle.addEventListener('click', () => {
        this.toggleTheme()
      })
    }

    // Auto-save URL changes
    const jiraUrlInput = document.getElementById('jira-url')
    if (jiraUrlInput) {
      jiraUrlInput.addEventListener('input', (e) => {
        this.saveConfig({ jiraUrl: e.target.value })
      })
    }
  }

  async handleJiraUrlSubmit() {
    const jiraUrlInput = document.getElementById('jira-url')
    const url = jiraUrlInput?.value?.trim()

    if (!url) {
      this.showNotification('Please enter a valid Jira URL', 'error')
      return
    }

    try {
      // Normalize URL
      const normalizedUrl = this.normalizeJiraUrl(url)
      
      // Save configuration
      this.saveConfig({ jiraUrl: normalizedUrl })
      
      // Set URL in main process
      if (window.electronAPI?.setJiraUrl) {
        await window.electronAPI.setJiraUrl(normalizedUrl + '/jira/projects')
        this.showNotification('Jira URL updated successfully!', 'success')
      } else {
        // Fallback for development
        window.open(normalizedUrl + '/jira/projects', '_blank')
      }
    } catch (error) {
      console.error('Error setting Jira URL:', error)
      this.showNotification('Error updating Jira URL', 'error')
    }
  }

  normalizeJiraUrl(url) {
    // Ensure URL has protocol
    if (!url.startsWith('http://') && !url.startsWith('https://')) {
      url = 'https://' + url
    }

    // Remove trailing slash and /jira paths
    url = url.replace(/\/$/, '')
    url = url.replace(/\/jira.*$/, '')

    return url
  }

  async toggleTheme() {
    try {
      // This will be handled by the main process menu system
      // For now, just show a notification
      this.showNotification('Use Cmd/Ctrl+Shift+D to toggle theme', 'info')
    } catch (error) {
      console.error('Error toggling theme:', error)
    }
  }

  displaySystemInfo() {
    // Display version info
    const appVersion = document.getElementById('app-version')
    const electronVersion = document.getElementById('electron-version')
    const platform = document.getElementById('platform')

    if (window.electronAPI) {
      if (electronVersion && window.electronAPI.versions?.electron) {
        electronVersion.textContent = window.electronAPI.versions.electron
      }
      
      if (platform && window.electronAPI.platform) {
        platform.textContent = window.electronAPI.platform
      }
    }
  }

  saveConfig(config) {
    try {
      const existingConfig = JSON.parse(localStorage.getItem('jiraDesktopConfig') || '{}')
      const newConfig = { ...existingConfig, ...config }
      localStorage.setItem('jiraDesktopConfig', JSON.stringify(newConfig))
    } catch (error) {
      console.error('Error saving config:', error)
    }
  }

  loadSavedConfig() {
    try {
      const config = JSON.parse(localStorage.getItem('jiraDesktopConfig') || '{}')
      
      if (config.jiraUrl) {
        const jiraUrlInput = document.getElementById('jira-url')
        if (jiraUrlInput) {
          jiraUrlInput.value = config.jiraUrl
        }
      }
    } catch (error) {
      console.error('Error loading config:', error)
    }
  }

  showNotification(message, type = 'info') {
    // Create notification element
    const notification = document.createElement('div')
    notification.className = `notification notification-${type}`
    notification.textContent = message
    
    // Style the notification
    Object.assign(notification.style, {
      position: 'fixed',
      top: '20px',
      right: '20px',
      padding: '12px 20px',
      borderRadius: '8px',
      color: 'white',
      fontWeight: '500',
      zIndex: '1000',
      opacity: '0',
      transform: 'translateY(-20px)',
      transition: 'all 0.3s ease'
    })

    // Set background color based on type
    const colors = {
      success: '#00875a',
      error: '#de350b',
      info: '#0052cc',
      warning: '#ff8b00'
    }
    notification.style.backgroundColor = colors[type] || colors.info

    // Add to DOM and animate
    document.body.appendChild(notification)
    
    requestAnimationFrame(() => {
      notification.style.opacity = '1'
      notification.style.transform = 'translateY(0)'
    })

    // Remove after 3 seconds
    setTimeout(() => {
      notification.style.opacity = '0'
      notification.style.transform = 'translateY(-20px)'
      setTimeout(() => {
        if (notification.parentNode) {
          notification.parentNode.removeChild(notification)
        }
      }, 300)
    }, 3000)
  }
}

// Initialize the app when DOM is loaded
document.addEventListener('DOMContentLoaded', () => {
  new JiraDesktopApp()
})