const test = require('node:test');
const assert = require('node:assert/strict');

const background = require('../background.js');

function createHarness({
  composeType = 'reply',
  sendError,
  queryPages,
  fullMessages = {},
  fullMessageErrors = new Set()
} = {}) {
  const archiveCalls = [];
  const notifications = [];
  const queryCalls = [];
  let pageIndex = 0;

  const sourceFolder = { id: 'inbox', name: 'Inbox' };
  const original = {
    id: 1,
    headerMessageId: '<reply@example.com>',
    subject: 'Re: Project update',
    folder: sourceFolder
  };
  const defaultPages = [{
    id: null,
    messages: [original]
  }];
  const pages = queryPages || defaultPages;

  global.messenger = {
    compose: {
      async getComposeDetails() {
        return { type: composeType, relatedMessageId: 1 };
      },
      async sendMessage() {
        if (sendError) {
          throw sendError;
        }
      }
    },
    messages: {
      async get() {
        return original;
      },
      async query(queryInfo) {
        queryCalls.push(queryInfo);
        pageIndex = 0;
        return pages[pageIndex++];
      },
      async continueList() {
        return pages[pageIndex++];
      },
      async getFull(messageId) {
        if (fullMessageErrors.has(messageId)) {
          throw new Error('Message unavailable');
        }
        return fullMessages[messageId] || {
          headers: { 'message-id': [`<message-${messageId}@example.com>`] }
        };
      },
      async archive(messageIds) {
        archiveCalls.push(messageIds);
      }
    },
    notifications: {
      async create(notification) {
        notifications.push(notification);
      }
    }
  };

  return { archiveCalls, notifications, queryCalls, original, sourceFolder };
}

test('disabled option archives only the original message', async () => {
  const harness = createHarness();
  background.setSettingsForTesting({ archiveWholeThread: false, showNotifications: false });

  await background.sendAndArchive(10);

  assert.deepEqual(harness.archiveCalls, [[1]]);
  assert.equal(harness.queryCalls.length, 0);
});

test('enabled reply follows pagination and archives only connected same-folder messages', async () => {
  const inbox = { id: 'inbox', name: 'Inbox' };
  const sent = { id: 'sent', name: 'Sent' };
  const messages = {
    original: { id: 1, headerMessageId: '<reply@example.com>', subject: 'Re: Project update', folder: inbox },
    root: { id: 2, headerMessageId: '<root@example.com>', subject: 'Project update', folder: inbox },
    sibling: { id: 3, headerMessageId: '<sibling@example.com>', subject: 'Re: Project update', folder: inbox },
    unrelated: { id: 4, headerMessageId: '<other@example.com>', subject: 'Project update', folder: inbox },
    sentCopy: { id: 5, headerMessageId: '<sent@example.com>', subject: 'Re: Project update', folder: sent }
  };
  const harness = createHarness({
    queryPages: [
      { id: 'next-page', messages: [messages.original, messages.root, messages.unrelated] },
      { id: null, messages: [messages.sibling, messages.sentCopy] }
    ],
    fullMessages: {
      1: { headers: { 'message-id': ['<reply@example.com>'], references: ['<root@example.com>'] } },
      2: { headers: { 'message-id': ['<root@example.com>'] } },
      3: { headers: { 'message-id': ['<sibling@example.com>'], references: ['<root@example.com>'] } },
      4: { headers: { 'message-id': ['<other@example.com>'] } },
      5: { headers: { 'message-id': ['<sent@example.com>'], references: ['<root@example.com>'] } }
    }
  });
  // The harness owns the original lookup; make its folder identity match the query.
  global.messenger.messages.get = async () => messages.original;
  background.setSettingsForTesting({ archiveWholeThread: true, showNotifications: true });

  await background.sendAndArchive(10);

  assert.deepEqual(harness.queryCalls, [{ folderId: 'inbox', subject: 'project update' }]);
  assert.deepEqual(harness.archiveCalls, [[1, 2, 3]]);
  assert.match(harness.notifications[0].message, /3 messages from the thread/);
});

test('enabled option does not expand forwards', async () => {
  const harness = createHarness({ composeType: 'forward' });
  background.setSettingsForTesting({ archiveWholeThread: true, showNotifications: false });

  await background.sendAndArchive(10);

  assert.deepEqual(harness.archiveCalls, [[1]]);
  assert.equal(harness.queryCalls.length, 0);
});

test('send failure archives nothing', async () => {
  const harness = createHarness({ sendError: new Error('SMTP failed') });
  background.setSettingsForTesting({ archiveWholeThread: false, showNotifications: false });

  await background.sendAndArchive(10);

  assert.deepEqual(harness.archiveCalls, []);
  assert.match(harness.notifications[0].message, /Failed to send message/);
});

test('partial discovery archives the original and always warns', async () => {
  const candidate = {
    id: 2,
    headerMessageId: '<candidate@example.com>',
    subject: 'Project update',
    folder: { id: 'inbox' }
  };
  const harness = createHarness({
    queryPages: [{ id: null, messages: [candidate] }],
    fullMessages: {
      1: { headers: { 'message-id': ['<reply@example.com>'] } }
    },
    fullMessageErrors: new Set([2])
  });
  background.setSettingsForTesting({ archiveWholeThread: true, showNotifications: false });

  await background.sendAndArchive(10);

  assert.deepEqual(harness.archiveCalls, [[1]]);
  assert.equal(harness.notifications[0].title, 'Send and Archive - Thread Warning');
});
