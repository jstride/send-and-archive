/**
 * Pure helpers for identifying messages that belong to the same email thread.
 */
(function exposeThreadUtils(root, factory) {
  const api = factory();

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  } else {
    root.ThreadUtils = api;
  }
}(globalThis, () => {
  function normalizeSubject(subject) {
    let normalized = String(subject || '').trim();
    const prefix = /^(?:re|fw|fwd)(?:\s*(?:\[\d+\]|\(\d+\)))?\s*:\s*/i;

    while (prefix.test(normalized)) {
      normalized = normalized.replace(prefix, '').trim();
    }

    return normalized.replace(/\s+/g, ' ').toLocaleLowerCase();
  }

  function normalizeMessageId(messageId) {
    return String(messageId || '')
      .trim()
      .replace(/^<|>$/g, '')
      .toLocaleLowerCase();
  }

  function extractMessageIds(values) {
    const messageIds = new Set();

    for (const value of Array.isArray(values) ? values : [values]) {
      if (!value) {
        continue;
      }

      const text = String(value);
      const bracketedIds = text.match(/<[^<>\s]+>/g);
      const unbracketedId = text.trim();
      const candidates = bracketedIds || (
        /^[^\s<>@]+@[^\s<>@]+$/.test(unbracketedId) ? [unbracketedId] : []
      );

      for (const candidate of candidates) {
        const normalized = normalizeMessageId(candidate);
        if (normalized) {
          messageIds.add(normalized);
        }
      }
    }

    return messageIds;
  }

  function getHeaderValues(headers, headerName) {
    if (!headers || typeof headers !== 'object') {
      return [];
    }

    const matchingKey = Object.keys(headers).find(
      key => key.toLocaleLowerCase() === headerName.toLocaleLowerCase()
    );

    if (!matchingKey) {
      return [];
    }

    return Array.isArray(headers[matchingKey])
      ? headers[matchingKey]
      : [headers[matchingKey]];
  }

  function collectThreadMessageIds(messageHeader, fullMessage) {
    const ids = new Set();
    const addAll = values => {
      for (const id of extractMessageIds(values)) {
        ids.add(id);
      }
    };

    addAll(messageHeader && messageHeader.headerMessageId);
    addAll(getHeaderValues(fullMessage && fullMessage.headers, 'message-id'));
    addAll(getHeaderValues(fullMessage && fullMessage.headers, 'references'));
    addAll(getHeaderValues(fullMessage && fullMessage.headers, 'in-reply-to'));

    return ids;
  }

  function findConnectedMessageIds(candidates, originalMessageId) {
    const original = candidates.find(candidate => candidate.id === originalMessageId);
    if (!original) {
      return [originalMessageId];
    }

    const connectedHeaderIds = new Set(original.threadMessageIds);
    const connectedMessageIds = new Set([originalMessageId]);
    let changed = true;

    while (changed) {
      changed = false;

      for (const candidate of candidates) {
        if (connectedMessageIds.has(candidate.id)) {
          continue;
        }

        const sharesThreadId = [...candidate.threadMessageIds]
          .some(id => connectedHeaderIds.has(id));

        if (!sharesThreadId) {
          continue;
        }

        connectedMessageIds.add(candidate.id);
        for (const id of candidate.threadMessageIds) {
          connectedHeaderIds.add(id);
        }
        changed = true;
      }
    }

    return [...connectedMessageIds];
  }

  return {
    normalizeSubject,
    normalizeMessageId,
    extractMessageIds,
    getHeaderValues,
    collectThreadMessageIds,
    findConnectedMessageIds
  };
}));
