import { describe, expect, it } from 'vitest';

import { detectPatternFromConversation, patterns } from '../../src/modules/patterns.js';
import { FakeStorage, makeContext, makeRequest, makeResponse, makeResponseContext } from '../_helpers.js';

describe('detectPatternFromConversation', () => {
  it('extracts a pattern from a "the issue was X / fix is Y" response', () => {
    const req = makeRequest({
      messages: [{ role: 'user', content: 'why is the build failing?' }],
    });
    const resp = makeResponse({
      content: [
        {
          type: 'text',
          text: 'I checked the logs. The issue was the wrong NODE_ENV. The fix is by setting NODE_ENV=production.',
        },
      ],
    });
    const detected = detectPatternFromConversation(req, resp);
    expect(detected).not.toBeNull();
    expect(detected?.problem).toContain('NODE_ENV');
    expect(detected?.solution).toContain('NODE_ENV');
  });

  it('returns null when no fix marker matches', () => {
    const req = makeRequest();
    const resp = makeResponse({
      content: [{ type: 'text', text: 'a short response with no fix marker' }],
    });
    expect(detectPatternFromConversation(req, resp)).toBeNull();
  });
});

describe('patterns module', () => {
  it('runs pre/post without throwing on an empty store', async () => {
    const storage = new FakeStorage();
    const mod = patterns({ minScore: 0.5 });
    const ctx = makeContext(makeRequest(), storage);
    const r = await mod.pre!(ctx);
    expect(r.continue).toBe(true);

    const respCtx = makeResponseContext();
    respCtx.storage = storage;
    respCtx.metadata = ctx.metadata;
    await mod.post!(respCtx);
  });

  it('forges a pattern when the response contains a fix marker', async () => {
    const storage = new FakeStorage();
    const mod = patterns();
    const req = makeRequest({
      messages: [{ role: 'user', content: 'why is my pod crashing?' }],
    });
    const resp = makeResponse({
      content: [
        {
          type: 'text',
          text: 'Root cause: missing env. Fix: add MY_VAR in the manifest before deploy.',
        },
      ],
    });
    const respCtx = makeResponseContext(req, resp, storage);
    respCtx.metadata = new Map();
    await mod.post!(respCtx);

    const rows = storage.db.rows('patterns');
    expect(rows.length).toBe(1);
    expect((rows[0].problem as string).toLowerCase()).toContain('missing env');
  });
});
