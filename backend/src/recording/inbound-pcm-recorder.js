"use strict";

const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");

function wavHeader(dataBytes, sampleRate = 16_000) {
  const header = Buffer.alloc(44);
  header.write("RIFF", 0); header.writeUInt32LE(36 + dataBytes, 4); header.write("WAVE", 8);
  header.write("fmt ", 12); header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22); header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28); header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34); header.write("data", 36); header.writeUInt32LE(dataBytes, 40);
  return header;
}

// Writes audio as it arrives so active calls do not accumulate full recordings
// in process memory. Audio parts from both caller and agent are converted to
// 16 kHz PCM and written in arrival order, then transcribed after upload.
async function createInboundPcmRecorder(options = {}) {
  const configuredMaxBytes = Number(options.maxBytes ?? process.env.INBOUND_RECORDING_MAX_BYTES);
  const maxBytes = Number.isSafeInteger(configuredMaxBytes) && configuredMaxBytes > 1024
    ? Math.min(configuredMaxBytes, 250 * 1024 * 1024)
    : 50 * 1024 * 1024;
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "attendance-inbound-"));
  await fsp.chmod(dir, 0o700);
  const filePath = path.join(dir, `${crypto.randomUUID()}.wav`);
  const handle = await fsp.open(filePath, "wx", 0o600);
  await handle.write(wavHeader(0), 0, 44, 0);
  let position = 44;
  let reservedBytes = 0;
  let chain = Promise.resolve();
  let closed = false;
  let truncated = false;

  function resample24kTo16k(buffer) {
    const samples = Math.floor(buffer.length / 2);
    const outputSamples = Math.floor(samples * 2 / 3);
    const out = Buffer.allocUnsafe(outputSamples * 2);
    for (let i = 0; i < outputSamples; i += 1) out.writeInt16LE(buffer.readInt16LE(Math.floor(i * 1.5) * 2), i * 2);
    return out;
  }
  function append(base64, sourceRate = 16_000) {
    if (closed || truncated || !base64) return;
    let audio = Buffer.from(base64, "base64");
    audio = audio.subarray(0, audio.length - (audio.length % 2));
    if (sourceRate === 24_000) audio = resample24kTo16k(audio);
    const allowed = Math.max(0, maxBytes - reservedBytes);
    if (audio.length > allowed) { audio = audio.subarray(0, allowed - (allowed % 2)); truncated = true; }
    if (!audio.length) return;
    reservedBytes += audio.length;
    chain = chain.then(async () => { await handle.write(audio, 0, audio.length, position); position += audio.length; });
  }
  async function finalize() {
    if (closed) return null;
    closed = true;
    try {
      await chain;
      const dataBytes = position - 44;
      await handle.write(wavHeader(dataBytes), 0, 44, 0);
      await handle.sync();
      await handle.close();
      return { path: filePath, sizeBytes: position, truncated, contentType: "audio/wav", cleanup: () => fsp.rm(dir, { recursive: true, force: true }) };
    } catch (error) {
      await handle.close().catch(() => {});
      await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
      throw error;
    }
  }
  return { append, finalize };
}

module.exports = { createInboundPcmRecorder };
