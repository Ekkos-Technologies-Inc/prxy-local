import { describe, expect, it } from 'vitest';

import { toolCache } from '../../src/modules/tool-cache.js';
import {
  FakeStorage,
  makeContext,
  makeRequest,
  makeResponse,
  makeResponseContext,
} from '../_helpers.js';

describe('toolCache', () => {
  it('reports name + version', () => {
    const mod = toolCache();
    expect(mod.name).toBe('tool-cache');
    expect(mod.version).toBe('1.0.0');
  });

  it('post records observed tool_use → tool_result pairs', async () => {
    const mod = toolCache();
    const storage = new FakeStorage();
    const request = makeRequest({
      messages: [
        { role: 'user', content: 'list files in /tmp' },
        {
          role: 'assistant',
          content: [
            { type: 'tool_use', id: 'call_1', name: 'list_dir', input: { path: '/tmp' } },
          ],
        },
        {
          role: 'user',
          content: [
            { type: 'tool_result', toolUseId: 'call_1', content: 'a.txt\nb.txt' },
          ],
        },
      ],
    });
    const postCtx = makeResponseContext(request, makeResponse(), storage);
    await mod.post!(postCtx);

    expect(postCtx.metadata.get('tool-cache.recorded_count')).toBe(1);
    const keys = [...storage.kv.store.keys()].filter((k) => k.startsWith('tool-cache:list_dir:'));
    expect(keys).toHaveLength(1);
  });

  it('pre detects a hit when same tool_use repeats', async () => {
    const mod = toolCache();
    const storage = new FakeStorage();

    const firstReq = makeRequest({
      messages: [
        { role: 'user', content: 'list files' },
        {
          role: 'assistant',
          content: [
            { type: 'tool_use', id: 'call_a', name: 'read_file', input: { path: '/x' } },
          ],
        },
        {
          role: 'user',
          content: [{ type: 'tool_result', toolUseId: 'call_a', content: 'file contents' }],
        },
      ],
    });
    await mod.post!(makeResponseContext(firstReq, makeResponse(), storage));

    const secondReq = makeRequest({
      messages: [
        { role: 'user', content: 'do it again' },
        {
          role: 'assistant',
          content: [
            { type: 'tool_use', id: 'call_b', name: 'read_file', input: { path: '/x' } },
          ],
        },
      ],
    });
    const preCtx = makeContext(secondReq, storage);
    const result = await mod.pre!(preCtx);
    expect(result.continue).toBe(true);
    expect(preCtx.metadata.get('tool-cache.would_hit_count')).toBe(1);
    expect(preCtx.metadata.get('tool-cache.observed_calls')).toBe(1);
  });

  it('NEVER caches excluded (side-effecting) tools by default', async () => {
    const mod = toolCache();
    const storage = new FakeStorage();
    const request = makeRequest({
      messages: [
        { role: 'user', content: 'run a command' },
        {
          role: 'assistant',
          content: [
            { type: 'tool_use', id: 'call_1', name: 'shell_exec', input: { cmd: 'ls' } },
          ],
        },
        {
          role: 'user',
          content: [{ type: 'tool_result', toolUseId: 'call_1', content: 'output' }],
        },
      ],
    });
    await mod.post!(makeResponseContext(request, makeResponse(), storage));
    expect([...storage.kv.store.keys()]).toHaveLength(0);
  });

  it('respects custom excludeTools', async () => {
    const mod = toolCache({ excludeTools: ['my_dangerous_tool'] });
    const storage = new FakeStorage();
    const request = makeRequest({
      messages: [
        { role: 'user', content: 'go' },
        {
          role: 'assistant',
          content: [{ type: 'tool_use', id: '1', name: 'my_dangerous_tool', input: {} }],
        },
        { role: 'user', content: [{ type: 'tool_result', toolUseId: '1', content: 'ok' }] },
      ],
    });
    await mod.post!(makeResponseContext(request, makeResponse(), storage));
    expect([...storage.kv.store.keys()]).toHaveLength(0);
  });

  it('does NOT cache failed tool calls', async () => {
    const mod = toolCache();
    const storage = new FakeStorage();
    const request = makeRequest({
      messages: [
        { role: 'user', content: 'try' },
        {
          role: 'assistant',
          content: [
            { type: 'tool_use', id: '1', name: 'read_file', input: { path: '/missing' } },
          ],
        },
        {
          role: 'user',
          content: [
            { type: 'tool_result', toolUseId: '1', content: 'no such file', isError: true },
          ],
        },
      ],
    });
    await mod.post!(makeResponseContext(request, makeResponse(), storage));
    expect([...storage.kv.store.keys()]).toHaveLength(0);
  });

  it('cache key is stable across param key ordering', async () => {
    const mod = toolCache();
    const storage = new FakeStorage();

    const reqA = makeRequest({
      messages: [
        { role: 'user', content: 'go' },
        {
          role: 'assistant',
          content: [{ type: 'tool_use', id: '1', name: 'read_file', input: { a: 1, b: 2 } }],
        },
        { role: 'user', content: [{ type: 'tool_result', toolUseId: '1', content: 'X' }] },
      ],
    });
    await mod.post!(makeResponseContext(reqA, makeResponse(), storage));

    const reqB = makeRequest({
      messages: [
        { role: 'user', content: 'whatever' },
        {
          role: 'assistant',
          content: [{ type: 'tool_use', id: '2', name: 'read_file', input: { b: 2, a: 1 } }],
        },
      ],
    });
    const preCtx = makeContext(reqB, storage);
    await mod.pre!(preCtx);
    expect(preCtx.metadata.get('tool-cache.would_hit_count')).toBe(1);
  });
});
