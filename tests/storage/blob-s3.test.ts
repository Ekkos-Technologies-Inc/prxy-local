/**
 * Parity tests for the prxy-local S3 blob backend.
 *
 * Asserts BlobS3 implements the same BlobStore contract as LocalBlob
 * (filesystem) using only mocked S3 calls. Useful for "local-mode-on-AWS"
 * deploys where blobs need to survive instance churn.
 */

import { describe, expect, it, vi, beforeEach } from 'vitest';

import {
  DeleteObjectCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  type S3Client,
} from '@aws-sdk/client-s3';

import { BlobS3 } from '../../src/storage/blob-s3.js';

function makeMockClient(): { client: S3Client; send: ReturnType<typeof vi.fn> } {
  const send = vi.fn();
  const client = { send } as unknown as S3Client;
  return { client, send };
}

describe('BlobS3', () => {
  let store: BlobS3;
  let send: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    const built = makeMockClient();
    store = new BlobS3({ client: built.client, bucket: 'test-bucket' });
    send = built.send;
  });

  it('put sends a PutObjectCommand', async () => {
    send.mockResolvedValueOnce({});
    await store.put('foo/bar.txt', 'hello');
    const cmd = send.mock.calls[0][0];
    expect(cmd).toBeInstanceOf(PutObjectCommand);
    expect(cmd.input).toMatchObject({ Bucket: 'test-bucket', Key: 'foo/bar.txt' });
    expect(Buffer.isBuffer(cmd.input.Body)).toBe(true);
    expect((cmd.input.Body as Buffer).toString('utf8')).toBe('hello');
  });

  it('put accepts Buffer content', async () => {
    send.mockResolvedValueOnce({});
    const buf = Buffer.from([1, 2, 3]);
    await store.put('bin', buf);
    expect(send.mock.calls[0][0].input.Body).toBe(buf);
  });

  it('get reads bytes from a successful GetObject', async () => {
    async function* fakeStream() {
      yield Buffer.from('hello');
    }
    send.mockResolvedValueOnce({ Body: fakeStream() });
    const got = await store.get('foo/bar.txt');
    expect(got?.toString('utf8')).toBe('hello');
    expect(send.mock.calls[0][0]).toBeInstanceOf(GetObjectCommand);
  });

  it('get returns null on NoSuchKey', async () => {
    const err = new Error('No such key') as Error & { name: string };
    err.name = 'NoSuchKey';
    send.mockRejectedValueOnce(err);
    expect(await store.get('missing')).toBeNull();
  });

  it('get re-throws unknown errors', async () => {
    send.mockRejectedValueOnce(new Error('AccessDenied'));
    await expect(store.get('boom')).rejects.toThrow('AccessDenied');
  });

  it('delete sends DeleteObjectCommand', async () => {
    send.mockResolvedValueOnce({});
    await store.delete('foo/bar.txt');
    expect(send.mock.calls[0][0]).toBeInstanceOf(DeleteObjectCommand);
  });

  it('list paginates and aggregates keys', async () => {
    send.mockResolvedValueOnce({
      Contents: [{ Key: 'pre/a' }, { Key: 'pre/b' }],
      IsTruncated: true,
      NextContinuationToken: 'tok-1',
    });
    send.mockResolvedValueOnce({
      Contents: [{ Key: 'pre/c' }],
      IsTruncated: false,
    });
    const keys = await store.list('pre/');
    expect(keys).toEqual(['pre/a', 'pre/b', 'pre/c']);
    const first = send.mock.calls[0][0];
    expect(first).toBeInstanceOf(ListObjectsV2Command);
    expect(first.input.ContinuationToken).toBeUndefined();
    expect(send.mock.calls[1][0].input.ContinuationToken).toBe('tok-1');
  });
});
