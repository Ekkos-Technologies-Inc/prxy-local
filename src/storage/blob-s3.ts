/**
 * BlobS3 — alternative S3-backed BlobStore for "local-mode-on-AWS" deploys.
 *
 * Local mode usually uses the filesystem-backed `LocalBlob` — that's the right
 * default for laptops, homelab boxes, and single-VPS installs. But when you
 * run prxy-local *on AWS* (e.g. a small EC2 / ECS task / App Runner) and want
 * blobs to survive instance churn without setting up an EFS mount, point this
 * blob backend at an S3 bucket instead.
 *
 * Selection: opt-in via the `LocalAdapterOptions.blobBackend = 's3'` flag, or
 * the `BLOB_BACKEND=s3` environment variable. Filesystem stays the default —
 * we don't want a fresh `docker run` to require AWS credentials.
 *
 * Auth: caller passes a region; if `accessKeyId`/`secretAccessKey` are
 * omitted the SDK uses its default credential provider chain (env vars,
 * shared config, IAM role, IRSA, etc.). Preferred is an instance role.
 */

import {
  DeleteObjectCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';

import type { BlobStore } from '../types/sdk.js';

export interface BlobS3Options {
  client: S3Client;
  bucket: string;
}

export class BlobS3 implements BlobStore {
  constructor(private opts: BlobS3Options) {}

  async put(key: string, content: Buffer | string): Promise<void> {
    const body = typeof content === 'string' ? Buffer.from(content, 'utf8') : content;
    await this.opts.client.send(
      new PutObjectCommand({ Bucket: this.opts.bucket, Key: key, Body: body }),
    );
  }

  async get(key: string): Promise<Buffer | null> {
    try {
      const res = await this.opts.client.send(
        new GetObjectCommand({ Bucket: this.opts.bucket, Key: key }),
      );
      const stream = res.Body as NodeJS.ReadableStream | undefined;
      if (!stream) return null;
      return await streamToBuffer(stream);
    } catch (err) {
      const code = (err as { name?: string; Code?: string }).name ?? (err as { Code?: string }).Code;
      if (code === 'NoSuchKey' || code === 'NotFound') return null;
      throw err;
    }
  }

  async delete(key: string): Promise<void> {
    await this.opts.client.send(
      new DeleteObjectCommand({ Bucket: this.opts.bucket, Key: key }),
    );
  }

  async list(prefix: string): Promise<string[]> {
    const out: string[] = [];
    let token: string | undefined = undefined;
    do {
      const res: import('@aws-sdk/client-s3').ListObjectsV2CommandOutput =
        await this.opts.client.send(
          new ListObjectsV2Command({
            Bucket: this.opts.bucket,
            Prefix: prefix,
            ContinuationToken: token,
          }),
        );
      for (const obj of res.Contents ?? []) {
        if (obj.Key) out.push(obj.Key);
      }
      token = res.IsTruncated ? res.NextContinuationToken : undefined;
    } while (token);
    return out;
  }
}

async function streamToBuffer(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : (chunk as Buffer));
  }
  return Buffer.concat(chunks);
}

/**
 * Build an S3 client. Omits credentials when not provided so the SDK uses its
 * default chain (env vars, shared config, IAM role, IRSA).
 */
export function buildS3Client(opts: {
  region: string;
  accessKeyId?: string;
  secretAccessKey?: string;
  sessionToken?: string;
}): S3Client {
  const cfg: ConstructorParameters<typeof S3Client>[0] = { region: opts.region };
  if (opts.accessKeyId && opts.secretAccessKey) {
    cfg.credentials = {
      accessKeyId: opts.accessKeyId,
      secretAccessKey: opts.secretAccessKey,
      ...(opts.sessionToken ? { sessionToken: opts.sessionToken } : {}),
    };
  }
  return new S3Client(cfg);
}
