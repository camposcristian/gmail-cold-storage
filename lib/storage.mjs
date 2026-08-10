import { S3Client, PutObjectCommand, GetObjectCommand, ListObjectsV2Command, DeleteObjectCommand } from '@aws-sdk/client-s3';

export function createStorage({ endpoint, accessKeyId, secretAccessKey, bucket, region = 'auto' }) {
  const client = new S3Client({
    endpoint,
    region,
    credentials: { accessKeyId, secretAccessKey },
    forcePathStyle: true,
  });

  return {
    async put(key, body, contentType) {
      await client.send(new PutObjectCommand({
        Bucket: bucket, Key: key, Body: body, ContentType: contentType,
      }));
    },

    async get(key) {
      try {
        const res = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
        const chunks = [];
        for await (const chunk of res.Body) chunks.push(chunk);
        return Buffer.concat(chunks);
      } catch (e) {
        if (e.name === 'NoSuchKey' || e.$metadata?.httpStatusCode === 404) return null;
        throw e;
      }
    },

    async list(prefix, maxKeys = 1000) {
      const keys = [];
      let token;
      do {
        const res = await client.send(new ListObjectsV2Command({
          Bucket: bucket, Prefix: prefix, MaxKeys: maxKeys, ContinuationToken: token,
        }));
        if (res.Contents) keys.push(...res.Contents.map(o => o.Key));
        token = res.IsTruncated ? res.NextContinuationToken : undefined;
      } while (token);
      return keys;
    },

    async delete(key) {
      await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
    },
  };
}
