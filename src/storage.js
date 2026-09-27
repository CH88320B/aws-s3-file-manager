const { S3Client, GetObjectCommand, HeadObjectCommand, DeleteObjectsCommand, PutObjectCommand } = require('@aws-sdk/client-s3');
const { createPresignedPost } = require('@aws-sdk/s3-presigned-post');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');

function createStorage({ region, bucket, endpoint, cloudfrontUrl }) {
  const s3 = new S3Client({ region, ...(endpoint && { endpoint, forcePathStyle: true }) });

  return {
    s3,

    /**
     * Pre-signed POST (not PUT) so S3 itself enforces the exact size range and content type:
     * the browser cannot upload more bytes than it declared.
     */
    presignUpload: ({ key, contentType, size, expiresIn }) =>
      createPresignedPost(s3, {
        Bucket: bucket,
        Key: key,
        Conditions: [
          ['content-length-range', size, size],
          ['eq', '$Content-Type', contentType],
        ],
        Fields: { 'Content-Type': contentType },
        Expires: expiresIn,
      }),

    head: async (key) => {
      try {
        return await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
      } catch (err) {
        if (err.name === 'NotFound' || err.$metadata?.httpStatusCode === 404) return null;
        throw err;
      }
    },

    getBuffer: async (key) => {
      const res = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
      return Buffer.from(await res.Body.transformToByteArray());
    },

    put: (key, body, contentType) =>
      s3.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: body, ContentType: contentType, CacheControl: 'public, max-age=31536000, immutable' })),

    presignDownload: (key, filename, expiresIn = 300) =>
      getSignedUrl(
        s3,
        new GetObjectCommand({
          Bucket: bucket,
          Key: key,
          ResponseContentDisposition: `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`,
        }),
        { expiresIn },
      ),

    remove: (keys) =>
      s3.send(new DeleteObjectsCommand({ Bucket: bucket, Delete: { Objects: keys.filter(Boolean).map((Key) => ({ Key })), Quiet: true } })),

    publicUrl: (key) => (cloudfrontUrl && key ? `${cloudfrontUrl.replace(/\/$/, '')}/${key}` : null),
  };
}

module.exports = { createStorage };
