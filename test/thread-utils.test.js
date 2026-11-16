const test = require('node:test');
const assert = require('node:assert/strict');

const {
  normalizeSubject,
  extractMessageIds,
  collectThreadMessageIds,
  findConnectedMessageIds
} = require('../thread-utils.js');

test('normalizes repeated reply and forward prefixes', () => {
  assert.equal(normalizeSubject(' Re: Fwd[2]:  Project   update '), 'project update');
  assert.equal(normalizeSubject('FW(3): RE: Project update'), 'project update');
});

test('extracts message IDs from folded and multiple header values', () => {
  assert.deepEqual(
    [...extractMessageIds(['<root@example.com>\r\n\t<reply@example.com>', '<later@example.com>'])],
    ['root@example.com', 'reply@example.com', 'later@example.com']
  );
});

test('collects IDs case-insensitively from standard thread headers', () => {
  const ids = collectThreadMessageIds(
    { headerMessageId: '<CURRENT@example.com>' },
    {
      headers: {
        'Message-ID': ['<current@example.com>'],
        References: ['<root@example.com> <parent@example.com>'],
        'In-Reply-To': ['<parent@example.com>']
      }
    }
  );

  assert.deepEqual([...ids], ['current@example.com', 'root@example.com', 'parent@example.com']);
});

test('finds the connected component and excludes unrelated same-subject messages', () => {
  const candidates = [
    { id: 1, threadMessageIds: new Set(['reply@example.com', 'root@example.com']) },
    { id: 2, threadMessageIds: new Set(['root@example.com']) },
    { id: 3, threadMessageIds: new Set(['sibling@example.com', 'root@example.com']) },
    { id: 4, threadMessageIds: new Set(['unrelated@example.com']) }
  ];

  assert.deepEqual(findConnectedMessageIds(candidates, 1), [1, 2, 3]);
});

test('malformed or missing headers do not create false thread matches', () => {
  const malformed = collectThreadMessageIds(
    { headerMessageId: '' },
    { headers: { references: ['not a valid bracketed id'] } }
  );
  const candidates = [
    { id: 1, threadMessageIds: new Set(['original@example.com']) },
    { id: 2, threadMessageIds: malformed },
    { id: 3, threadMessageIds: new Set() }
  ];

  assert.deepEqual(findConnectedMessageIds(candidates, 1), [1]);
});
