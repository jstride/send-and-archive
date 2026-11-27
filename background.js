
/**
 * Send and Archive Extension for Thunderbird
 * Background Script - Handles compose window toolbar button and keyboard shortcuts
 */

const threadUtils = typeof ThreadUtils !== 'undefined'
  ? ThreadUtils
  : require('./thread-utils.js');

// Store settings in memory for quick access
let settings = {
  showNotifications: true,
  archiveWholeThread: false
};

// Manifest V3 background pages can be started by the same toolbar/command
// event that invokes sendAndArchive(). Keep the initial storage read as a
// promise so the action cannot observe the defaults before persisted settings
// have finished loading.
let settingsReady = Promise.resolve();

// Load settings on startup
async function loadSettings() {
  try {
    const result = await messenger.storage.local.get(['showNotifications', 'archiveWholeThread']);
    settings.showNotifications = result.showNotifications !== undefined ? result.showNotifications : true;
    settings.archiveWholeThread = result.archiveWholeThread !== undefined ? result.archiveWholeThread : false;
  } catch (error) {
    console.error('Error loading settings:', error);
  }
}

/**
 * Let a host-specific integration defer pointer activation until mouse-up.
 * Standard Thunderbird installations do not expose this optional API and
 * retain the normal composeAction behavior.
 * @param {number} tabId - The compose window tab ID
 * @returns {Promise<boolean>} - True when the action should proceed
 */
async function waitForComposeActionRelease(tabId) {
  const releaseApi = messenger.sendAndArchiveRelease;
  if (!releaseApi || typeof releaseApi.waitForRelease !== 'function') {
    return true;
  }
  try {
    return await releaseApi.waitForRelease(tabId);
  } catch (error) {
    console.error('Could not verify Send and Archive button release:', error);
    return false;
  }
}

/**
 * Check if a compose window is a reply or forward (not a new message)
 * @param {number} tabId - The compose window tab ID
 * @returns {Promise<boolean>} - True if reply/forward, false if new message
 */
async function isReplyOrForward(tabId) {
  try {
    const composeDetails = await messenger.compose.getComposeDetails(tabId);

    // Check the type property (added in Thunderbird 91/102)
    // Possible values: "new", "reply", "forward", "draft"
    if (composeDetails.type) {
      const isReply = composeDetails.type === 'reply' || composeDetails.type === 'forward';
      console.log('Compose type:', composeDetails.type, '- Is reply/forward:', isReply);
      return isReply;
    }

    // Fallback: Check for relatedMessageId (added in Thunderbird 95)
    // If there's a related message, it's a reply or forward
    if (composeDetails.relatedMessageId) {
      console.log('Found relatedMessageId:', composeDetails.relatedMessageId);
      return true;
    }

    console.log('This is a new message (no type or relatedMessageId found)');
    return false;
  } catch (error) {
    console.error('Error checking compose type:', error);
    // If we can't determine, assume it's not a reply (safer default)
    return false;
  }
}

/**
 * Check if an archive folder is configured: Account > Copies & Folders > Message Archives
 * @returns {Promise<boolean>} - True if archive folder is configured, false otherwise
 */
async function hasArchiveFolderConfigured(tabId) {
  try {

    // This relies on unified config, and is not the correct way to do it:
    // const archiveFolder = await messenger.folders.getUnifiedFolder('archives');
    // const capabilities = await messenger.folders.getFolderCapabilities(archiveFolder.id);

    // Note: proper behavior is shown by the built-in menu item "Message > Archive" (shortcut A) where it does nothing if Archive folder not configured.
    // This looks up the folder by "specialUse" but it finds a folder even if it is not configured :
    const composeDetails = await messenger.compose.getComposeDetails(tabId);
    const identity = await messenger.identities.get(composeDetails.identityId);
    const queryAnswer = await messenger.folders.query({ accountId:  identity.accountId, specialUse: ['archives'] });
    const capabilities = await messenger.folders.getFolderCapabilities(queryAnswer[0].id)

    if (capabilities.canAddMessages) {
      console.log('Archive folder is configured');
      return true;
    }

    console.log('No archive folder configured');
    return false;
  } catch (error) {
    // If the API throws an error, it likely means no archive folder is configured
    console.log('Archive folder check failed (likely not configured):', error.message);
    return false;
  }
}

/**
 * Update button visibility based on compose type AND archive folder configuration
 * @param {number} tabId - The compose window tab ID
 */
async function updateButtonVisibility(tabId) {
  try {
    const isReply = await isReplyOrForward(tabId);
    const hasArchive = await hasArchiveFolderConfigured(tabId);

    // Button should only be enabled if BOTH conditions are true:
    // 1. It's a reply or forward (not a new message)
    // 2. An archive folder is configured
    if (isReply && hasArchive) {
      // Enable the button
      await messenger.composeAction.enable(tabId);
      console.log('Button enabled (reply/forward AND archive folder configured)');
    } else {
      // Disable the button
      await messenger.composeAction.disable(tabId);
      if (!isReply) {
        console.log('Button disabled (not a reply/forward)');
      } else if (!hasArchive) {
        console.log('Button disabled (no archive folder configured)');
      }
    }
  } catch (error) {
    console.error('Error updating button visibility:', error);
  }
}

/**
 * Main function to send message and archive the original
 * @param {number} tabId - The compose window tab ID
 */
async function sendAndArchive(tabId) {
  try {
    console.log('Send and Archive triggered for tab:', tabId);

    await settingsReady;

    // Get the compose details once so the related message and compose type remain consistent.
    const composeDetails = await messenger.compose.getComposeDetails(tabId);
    const isReply = composeDetails.type
      ? composeDetails.type === 'reply' || composeDetails.type === 'forward'
      : Boolean(composeDetails.relatedMessageId);

    if (!isReply) {
      console.log('Not a reply/forward - aborting');
      await messenger.notifications.create({
        type: 'basic',
        iconUrl: 'icons/icon-48.png',
        title: 'Send and Archive',
        message: 'This feature only works for replies and forwards, not new messages.'
      });
      return;
    }

    // Get the original message ID
    const originalMessageId = composeDetails.relatedMessageId;

    if (!originalMessageId) {
      console.log('No related message found - cannot archive');
      await messenger.notifications.create({
        type: 'basic',
        iconUrl: 'icons/icon-48.png',
        title: 'Send and Archive',
        message: 'Could not find the original message to archive.'
      });
      return;
    }

    console.log('Found related message ID:', originalMessageId);

    const shouldArchiveWholeThread = settings.archiveWholeThread && composeDetails.type === 'reply';
    let archivePlan = {
      messageIds: [originalMessageId],
      wholeThread: false,
      incomplete: false
    };

    if (shouldArchiveWholeThread) {
      archivePlan = await resolveThreadMessageIds(originalMessageId);
      console.log('Resolved thread archive targets:', archivePlan.messageIds);
    }

    // Send the message using the correct Thunderbird API
    // The sendMessage function requires the compose.send permission
    console.log('Sending message...');

    try {
      // Send the message immediately using sendNow mode
      await messenger.compose.sendMessage(tabId, { mode: 'sendNow' });
      console.log('Message sent successfully');

      // Archive only after sending has completed successfully.
      await archiveMessages(archivePlan);

    } catch (sendError) {
      console.error('Error sending message:', sendError);
      // Show error notification
      await messenger.notifications.create({
        type: 'basic',
        iconUrl: 'icons/icon-48.png',
        title: 'Send and Archive - Error',
        message: 'Failed to send message: ' + sendError.message
      });
    }

  } catch (error) {
    console.error('Error in sendAndArchive:', error);
    await messenger.notifications.create({
      type: 'basic',
      iconUrl: 'icons/icon-48.png',
      title: 'Send and Archive - Error',
      message: 'An error occurred: ' + error.message
    });
  }
}

/**
 * Resolve the messages in the original message's folder that confidently belong
 * to the same RFC email thread.
 * @param {number} originalMessageId - The related message ID
 * @returns {Promise<{messageIds: number[], wholeThread: boolean, incomplete: boolean}>}
 */
async function resolveThreadMessageIds(originalMessageId) {
  let incomplete = false;

  try {
    const original = await messenger.messages.get(originalMessageId);
    if (!original.folder || !original.folder.id) {
      throw new Error('The original message does not have an accessible folder');
    }

    const normalizedSubject = threadUtils.normalizeSubject(original.subject);
    const folderId = original.folder.id;
    const candidates = new Map();
    const knownHeaderIds = new Set();

    async function addCandidate(message) {
      if (candidates.has(message.id) || (message.folder && message.folder.id !== folderId)) {
        return;
      }
      let fullMessage;
      try {
        fullMessage = typeof messenger.messages.getHeaders === 'function'
          ? { headers: await messenger.messages.getHeaders(message.id) }
          : await messenger.messages.getFull(message.id);
      } catch (error) {
        incomplete = true;
        console.warn('Could not inspect message while resolving thread:', message.id, error);
      }

      knownHeaderIds.add(threadUtils.normalizeMessageId(message.headerMessageId));
      candidates.set(message.id, {
        id: message.id,
        threadMessageIds: threadUtils.collectThreadMessageIds(message, fullMessage),
        references: threadUtils.collectReferencedMessageIds(fullMessage?.headers)
      });
    }

    async function addQueryMatches(query, matches) {
      let page = await messenger.messages.query({ folderId, ...query });
      while (page) {
        for (const message of page.messages) {
          if (matches(message)) {
            await addCandidate(message);
          }
        }
        page = page.id ? await messenger.messages.continueList(page.id) : null;
      }
    }

    await addCandidate(original);
    if (normalizedSubject) {
      await addQueryMatches({ subject: normalizedSubject },
        message => threadUtils.normalizeSubject(message.subject) === normalizedSubject);
    }

    // Follow references from connected messages, even when the subject changed.
    // Search by exact Message-ID to avoid loading every message in the folder.
    const searchedReferences = new Set();
    let messageIds;
    let candidateCount;
    do {
      candidateCount = candidates.size;
      messageIds = threadUtils.findConnectedMessageIds([...candidates.values()], originalMessageId);
      for (const id of messageIds) {
        for (const reference of candidates.get(id).references) {
          const normalizedId = threadUtils.normalizeMessageId(reference);
          if (knownHeaderIds.has(normalizedId) || searchedReferences.has(reference)) {
            continue;
          }
          searchedReferences.add(reference);
          try {
            await addQueryMatches({ headerMessageId: reference },
              message => threadUtils.normalizeMessageId(message.headerMessageId) === normalizedId);
          } catch (error) {
            incomplete = true;
            console.warn('Could not search for a referenced message:', error);
          }
        }
      }
    } while (candidates.size !== candidateCount);

    return {
      messageIds,
      wholeThread: true,
      incomplete
    };
  } catch (error) {
    console.warn('Could not resolve the whole thread; falling back to the original message:', error);
    return {
      messageIds: [originalMessageId],
      wholeThread: true,
      incomplete: true
    };
  }
}

/**
 * Archive messages using Thunderbird's built-in archive functionality.
 * Note: This function assumes archive folder is configured (checked before button is enabled)
 * @param {{messageIds: number[], wholeThread: boolean, incomplete: boolean}} archivePlan
 */
async function archiveMessages(archivePlan) {
  try {
    console.log('Archiving messages:', archivePlan.messageIds);

    // Use Thunderbird's built-in archive functionality
    // The messages.archive() method automatically handles folder details
    // and respects the user's archive settings
    await messenger.messages.archive(archivePlan.messageIds);

    console.log('Messages archived successfully');

    if (archivePlan.incomplete) {
      const archivedDescription = archivePlan.messageIds.length === 1
        ? 'the original message was archived'
        : `${archivePlan.messageIds.length} matching messages were archived`;
      await messenger.notifications.create({
        type: 'basic',
        iconUrl: 'icons/icon-48.png',
        title: 'Send and Archive - Thread Warning',
        message: `Message sent and ${archivedDescription}, but some messages in the thread could not be checked.`
      });
      return;
    }

    // Show notification if enabled
    if (settings.showNotifications) {
      const message = archivePlan.wholeThread
        ? `Message sent and ${archivePlan.messageIds.length} message${archivePlan.messageIds.length === 1 ? '' : 's'} from the thread archived successfully`
        : 'Message sent and original archived successfully';
      await messenger.notifications.create({
        type: 'basic',
        iconUrl: 'icons/icon-48.png',
        title: 'Send and Archive',
        message
      });
    }

  } catch (error) {
    // This should rarely happen since we check for archive folder before enabling the button
    console.error('Error archiving message:', error);

    // Show simplified error notification
    await messenger.notifications.create({
      type: 'basic',
      iconUrl: 'icons/icon-48.png',
      title: 'Send and Archive - Archive Error',
      message: 'Message sent, but failed to archive message(s): ' + (error.message || 'Unknown error')
    });
  }
}

function initializeExtension() {
  settingsReady = loadSettings();

  messenger.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== 'local') {
      return;
    }
    if (changes.showNotifications) {
      settings.showNotifications = changes.showNotifications.newValue;
    }
    if (changes.archiveWholeThread) {
      settings.archiveWholeThread = changes.archiveWholeThread.newValue;
    }
  });

  // Listen for new compose windows being opened.
  messenger.tabs.onCreated.addListener(async (tab) => {
    if (tab.type === 'messageCompose') {
      console.log('New compose window opened:', tab.id);
      setTimeout(() => {
        updateButtonVisibility(tab.id);
      }, 100);
    }
  });

  messenger.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
    if (tab.type === 'messageCompose') {
      updateButtonVisibility(tabId);
    }
  });

  messenger.composeAction.onClicked.addListener(async (tab) => {
    console.log('Compose action button clicked');
    if (!await waitForComposeActionRelease(tab.id)) {
      console.log('Compose action cancelled before button release');
      return;
    }
    await sendAndArchive(tab.id);
  });

  messenger.commands.onCommand.addListener(async (command) => {
    if (command === 'send-and-archive') {
      console.log('Keyboard shortcut triggered');
      const windows = await messenger.windows.getAll({ populate: true, windowTypes: ['messageCompose'] });

      if (windows.length > 0) {
        const focusedWindow = windows.find(w => w.focused);
        if (focusedWindow && focusedWindow.tabs && focusedWindow.tabs.length > 0) {
          await sendAndArchive(focusedWindow.tabs[0].id);
        } else if (windows[0].tabs && windows[0].tabs.length > 0) {
          await sendAndArchive(windows[0].tabs[0].id);
        }
      }
    }
  });

  console.log('Send and Archive background script loaded (v1.0.7)');
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    resolveThreadMessageIds,
    sendAndArchive,
    archiveMessages,
    waitForComposeActionRelease,
    startLoadingSettingsForTesting() {
      settingsReady = loadSettings();
      return settingsReady;
    },
    setSettingsForTesting(newSettings) {
      settings = { ...settings, ...newSettings };
      settingsReady = Promise.resolve();
    }
  };
} else {
  initializeExtension();
}
