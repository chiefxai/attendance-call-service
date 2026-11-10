"use strict";

const fs = require("node:fs");
const fsp = require("node:fs/promises");
const { S3Client, PutObjectCommand, GetObjectCommand } = require("@aws-sdk/client-s3");

function createMinioRecordingStore({
  endpoint = process.env.MINIO_ENDPOINT,
  region = process.env.MINIO_REGION || "us-east-1",
  bucket = process.env.MINIO_BUCKET,
  accessKeyId = process.env.MINIO_ACCESS_KEY,
  secretAccessKey = process.env.MINIO_SECRET_KEY,
  vobizAuthId = process.env.VOBIZ_AUTH_ID,
  vobizAuthToken = process.env.VOBIZ_AUTH_TOKEN,
  allowedRecordingHosts = [...new Set(["api.vobiz.ai", "media.vobiz.ai", ...(process.env.VOBIZ_RECORDING_ALLOWED_HOSTS || "").split(",").map((host) => host.trim().toLowerCase()).filter(Boolean)])],
  fetchImpl = globalThis.fetch,
  maxDownloadBytes = Number(process.env.MAX_RECORDING_DOWNLOAD_BYTES || 100 * 1024 * 1024),
} = {}) {
  if (!endpoint || !bucket || !accessKeyId || !secretAccessKey) {
    throw new Error("MINIO_ENDPOINT, MINIO_BUCKET, MINIO_ACCESS_KEY and MINIO_SECRET_KEY are required");
  }
  const s3 = new S3Client({
    endpoint,
    region,
    forcePathStyle: true,
    credentials: { accessKeyId, secretAccessKey },
  });

  async function readLimited(responseBody) {
    const reader = responseBody?.getReader?.();
    if (!reader) throw new Error("Recording response did not include a readable body");
    const chunks = [];
    let size = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = Buffer.from(value);
        size += chunk.length;
        if (size > maxDownloadBytes) {
          await reader.cancel();
          throw new Error("Recording exceeds configured download size limit");
        }
        chunks.push(chunk);
      }
    } finally { reader.releaseLock(); }
    return Buffer.concat(chunks, size);
  }

  async function importProviderRecording(recordingUrl, { organizationId, sessionId, callAttemptId } = {}) {
    if (!recordingUrl || !organizationId || !sessionId || !callAttemptId) throw new Error("Recording URL and call ownership IDs are required");
    if (typeof fetchImpl !== "function") throw new Error("Fetch API implementation is required");
    const parsedUrl = new URL(recordingUrl);
    if (parsedUrl.protocol !== "https:" || !allowedRecordingHosts.includes(parsedUrl.hostname.toLowerCase())) {
      throw new Error("Recording URL host is not in VOBIZ_RECORDING_ALLOWED_HOSTS");
    }
    const headers = {};
    if (vobizAuthId && vobizAuthToken) {
      headers["X-Auth-ID"] = vobizAuthId;
      headers["X-Auth-Token"] = vobizAuthToken;
    }
    const response = await fetchImpl(recordingUrl, { headers, signal: AbortSignal.timeout(30_000) });
    if (!response.ok) throw new Error(`Recording download failed (${response.status})`);
    const declaredLength = Number(response.headers.get("content-length") || 0);
    if (declaredLength > maxDownloadBytes) throw new Error("Recording exceeds configured download size limit");
    const bytes = await readLimited(response.body);
    // Stable key makes the upload idempotent if a worker retries after the
    // object upload succeeded but before PostgreSQL recorded the object key.
    const key = `attendance/${encodeURIComponent(organizationId)}/${sessionId}/${callAttemptId}/recording.audio`;
    await s3.send(new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: bytes,
      ContentType: response.headers.get("content-type") || "application/octet-stream",
      ServerSideEncryption: process.env.MINIO_SERVER_SIDE_ENCRYPTION || undefined,
      Metadata: { organizationid: String(organizationId), sessionid: String(sessionId), callattemptid: String(callAttemptId) },
    }));
    return { key, bucket, contentType: response.headers.get("content-type") || null, sizeBytes: bytes.length };
  }

  async function storeCallRecordingBuffer(buffer, { organizationId, sessionId, callAttemptId } = {}) {
    if (!Buffer.isBuffer(buffer) || !buffer.length || !organizationId || !sessionId || !callAttemptId) {
      throw new Error("WAV recording buffer and call ownership IDs are required");
    }
    const key = `attendance/${encodeURIComponent(organizationId)}/${sessionId}/${callAttemptId}/recording.wav`;
    await s3.send(new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: buffer,
      ContentType: "audio/wav",
      ServerSideEncryption: process.env.MINIO_SERVER_SIDE_ENCRYPTION || undefined,
      Metadata: { organizationid: String(organizationId), sessionid: String(sessionId), callattemptid: String(callAttemptId) },
    }));
    return { key, bucket, contentType: "audio/wav", sizeBytes: buffer.length };
  }

  async function storeInboundCallRecordingBuffer(buffer, { organizationId, inboundCallId } = {}) {
    if (!Buffer.isBuffer(buffer) || !buffer.length || !organizationId || !inboundCallId) {
      throw new Error("WAV recording buffer and inbound call ownership IDs are required");
    }
    const key = `inbound/${encodeURIComponent(organizationId)}/${inboundCallId}/recording.wav`;
    await s3.send(new PutObjectCommand({
      Bucket: bucket, Key: key, Body: buffer, ContentType: "audio/wav",
      ServerSideEncryption: process.env.MINIO_SERVER_SIDE_ENCRYPTION || undefined,
      Metadata: { organizationid: String(organizationId), inboundcallid: String(inboundCallId) },
    }));
    return { key, bucket, contentType: "audio/wav", sizeBytes: buffer.length };
  }

  async function storeInboundCallRecordingFile(filePath, { organizationId, inboundCallId, contentType = "audio/wav" } = {}) {
    if (!filePath || !organizationId || !inboundCallId) throw new Error("Recording file and inbound call ownership IDs are required");
    const stat = await fsp.stat(filePath);
    if (!stat.isFile() || stat.size <= 44) throw new Error("Inbound recording file is empty or invalid");
    const key = `inbound/${encodeURIComponent(organizationId)}/${inboundCallId}/recording.wav`;
    await s3.send(new PutObjectCommand({
      Bucket: bucket, Key: key, Body: fs.createReadStream(filePath), ContentLength: stat.size,
      ContentType: contentType, ServerSideEncryption: process.env.MINIO_SERVER_SIDE_ENCRYPTION || undefined,
      Metadata: { organizationid: String(organizationId), inboundcallid: String(inboundCallId) },
    }));
    return { key, bucket, contentType, sizeBytes: stat.size };
  }

  async function getObjectBuffer(key) {
    const result = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    return Buffer.from(await result.Body.transformToByteArray());
  }

  async function deleteObject(key) {
    const { DeleteObjectCommand } = require("@aws-sdk/client-s3");
    await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
  }

  return { importProviderRecording, storeCallRecordingBuffer, storeInboundCallRecordingBuffer, storeInboundCallRecordingFile, getObjectBuffer, deleteObject, bucket };
}

module.exports = { createMinioRecordingStore };
