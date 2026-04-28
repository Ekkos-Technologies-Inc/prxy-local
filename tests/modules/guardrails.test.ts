import { describe, expect, it } from 'vitest';

import { guardrails } from '../../src/modules/guardrails.js';
import { makeContext, makeRequest } from '../_helpers.js';

describe('guardrails', () => {
  it('reports name + version', () => {
    const mod = guardrails();
    expect(mod.name).toBe('guardrails');
    expect(mod.version).toBe('1.0.0');
  });

  it('default config is fully permissive', async () => {
    const mod = guardrails();
    const ctx = makeContext(
      makeRequest({
        messages: [{ role: 'user', content: 'email me at test@example.com' }],
      }),
    );
    const result = await mod.pre!(ctx);
    expect(result.continue).toBe(true);
    expect(ctx.request.messages[0].content).toBe('email me at test@example.com');
  });

  it('redacts email PII', async () => {
    const mod = guardrails({ pii_redact: true });
    const ctx = makeContext(
      makeRequest({
        messages: [{ role: 'user', content: 'contact me at john@acme.com please' }],
      }),
    );
    await mod.pre!(ctx);
    expect(ctx.request.messages[0].content).toBe(
      'contact me at [REDACTED_EMAIL] please',
    );
  });

  it('redacts SSN', async () => {
    const mod = guardrails({ pii_redact: true });
    const ctx = makeContext(
      makeRequest({ messages: [{ role: 'user', content: 'my ssn is 123-45-6789' }] }),
    );
    await mod.pre!(ctx);
    expect(ctx.request.messages[0].content).toBe('my ssn is [REDACTED_SSN]');
  });

  it('redacts credit cards', async () => {
    const mod = guardrails({ pii_redact: true });
    const ctx = makeContext(
      makeRequest({
        messages: [{ role: 'user', content: 'card: 4111-1111-1111-1111 expires 12/25' }],
      }),
    );
    await mod.pre!(ctx);
    expect(ctx.request.messages[0].content).toBe(
      'card: [REDACTED_CARD] expires 12/25',
    );
  });

  it('redacts PII in system prompt and content blocks', async () => {
    const mod = guardrails({ pii_redact: true });
    const ctx = makeContext(
      makeRequest({
        system: 'support agent for user@example.com',
        messages: [
          { role: 'user', content: [{ type: 'text', text: 'reach me at me@x.io' }] },
        ],
      }),
    );
    await mod.pre!(ctx);
    expect(ctx.request.system).toBe('support agent for [REDACTED_EMAIL]');
    const blocks = ctx.request.messages[0].content as Array<{ type: string; text: string }>;
    expect(blocks[0].text).toBe('reach me at [REDACTED_EMAIL]');
  });

  it('blocks on PII when on_pii: block', async () => {
    const mod = guardrails({ on_pii: 'block' });
    const ctx = makeContext(
      makeRequest({ messages: [{ role: 'user', content: 'my email is hi@x.com' }] }),
    );
    const result = await mod.pre!(ctx);
    expect(result.continue).toBe(false);
    if (result.continue) throw new Error('expected block');
    const err = JSON.parse((result.response.content[0] as { type: 'text'; text: string }).text);
    expect(err.error.type).toBe('guardrail_pii_block');
  });

  it('log-only counts but does not mutate or block', async () => {
    const mod = guardrails({ on_pii: 'log-only', pii_redact: false });
    const ctx = makeContext(
      makeRequest({ messages: [{ role: 'user', content: 'find john@example.com' }] }),
    );
    const result = await mod.pre!(ctx);
    expect(result.continue).toBe(true);
    expect(ctx.request.messages[0].content).toBe('find john@example.com');
    const stats = ctx.metadata.get('guardrails.stats') as { pii_redactions: number };
    expect(stats.pii_redactions).toBeGreaterThan(0);
  });

  it('blocks profanity when profanity_block: true', async () => {
    const mod = guardrails({ profanity_block: true });
    const ctx = makeContext(makeRequest({ messages: [{ role: 'user', content: 'this is shit' }] }));
    const result = await mod.pre!(ctx);
    expect(result.continue).toBe(false);
    if (result.continue) throw new Error('expected block');
    const err = JSON.parse((result.response.content[0] as { type: 'text'; text: string }).text);
    expect(err.error.type).toBe('guardrail_profanity_block');
  });

  it('lets clean content through profanity filter', async () => {
    const mod = guardrails({ profanity_block: true });
    const ctx = makeContext(
      makeRequest({ messages: [{ role: 'user', content: 'have a nice day' }] }),
    );
    const result = await mod.pre!(ctx);
    expect(result.continue).toBe(true);
  });

  it('blocks on custom_patterns match', async () => {
    const mod = guardrails({ custom_patterns: ['sk-[a-zA-Z0-9]{20,}'] });
    const ctx = makeContext(
      makeRequest({
        messages: [{ role: 'user', content: 'use my key sk-abc123def456ghi789jkl' }],
      }),
    );
    const result = await mod.pre!(ctx);
    expect(result.continue).toBe(false);
    if (result.continue) throw new Error('expected block');
    const err = JSON.parse((result.response.content[0] as { type: 'text'; text: string }).text);
    expect(err.error.type).toBe('guardrail_custom_block');
  });

  it('ignores invalid custom regex (does not throw)', async () => {
    const mod = guardrails({ custom_patterns: ['(unclosed'] });
    const ctx = makeContext(makeRequest());
    const result = await mod.pre!(ctx);
    expect(result.continue).toBe(true);
  });

  it('records backend in metadata', async () => {
    const mod = guardrails({ backend: 'regex' });
    const ctx = makeContext(makeRequest());
    await mod.pre!(ctx);
    expect(ctx.metadata.get('guardrails.backend')).toBe('regex');
  });
});
