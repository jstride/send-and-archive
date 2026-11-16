
/**
 * Send and Archive Extension - Options Page Script
 * Handles saving and loading of user preferences
 */

// Load saved settings
async function loadSettings() {
  try {
    const result = await messenger.storage.local.get(['showNotifications', 'archiveWholeThread']);
    const showNotifications = result.showNotifications !== undefined ? result.showNotifications : true;
    const archiveWholeThread = result.archiveWholeThread !== undefined ? result.archiveWholeThread : false;
    
    document.getElementById('showNotifications').checked = showNotifications;
    document.getElementById('archiveWholeThread').checked = archiveWholeThread;
    console.log('Settings loaded:', { showNotifications, archiveWholeThread });
  } catch (error) {
    console.error('Error loading settings:', error);
  }
}

// Save settings
async function saveSettings() {
  try {
    const showNotifications = document.getElementById('showNotifications').checked;
    const archiveWholeThread = document.getElementById('archiveWholeThread').checked;
    
    await messenger.storage.local.set({ showNotifications, archiveWholeThread });
    
    console.log('Settings saved:', { showNotifications, archiveWholeThread });
    
    // Show save confirmation
    const saveStatus = document.getElementById('saveStatus');
    saveStatus.style.display = 'block';
    
    // Hide after 3 seconds
    setTimeout(() => {
      saveStatus.style.display = 'none';
    }, 3000);
    
  } catch (error) {
    console.error('Error saving settings:', error);
  }
}

// Initialize
document.addEventListener('DOMContentLoaded', () => {
  loadSettings();
  
  // Save settings when checkbox changes
  document.getElementById('showNotifications').addEventListener('change', saveSettings);
  document.getElementById('archiveWholeThread').addEventListener('change', saveSettings);
});
