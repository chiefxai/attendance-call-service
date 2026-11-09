"use strict";

const crypto = require("node:crypto");
const { URL } = require("node:url");
const { WebSocketServer } = require("ws");
const { createVertexClientProvider, formatSessionContext } = require("./vertex-agent");

const LIVE_MODEL = process.env.VERTEX_LIVE_AUDIO_MODEL || "gemini-live-2.5-flash-native-audio";
const MEDIA_PATH = process.env.VOBIZ_MEDIA_PATH || "/api/call-service/media";
const OUTPUT_RATE = 24_000;
const OUTPUT_FRAME_BYTES = OUTPUT_RATE * 2 * 40 / 1000; // 40 ms, mono, 16-bit PCM

function timingSafeEqualText(a, b) {
  if (!a || !b) return false;
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function xmlEscape(value) {
  return String(value).replace(/[<>&"']/g, (char) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&apos;" })[char]);
}

function createToken({ callId, sessionId, callAttemptId, stage }, secret, ttlSeconds = 600) {
  if (!secret) throw new Error("VOBIZ_STREAM_SECRET or VOBIZ_AUTH_TOKEN must be configured");
  const payload = Buffer.from(JSON.stringify({ callId, sessionId, callAttemptId, stage, exp: Math.floor(Date.now() / 1000) + ttlSeconds })).toString("base64url");
  const signature = crypto.createHmac("sha256", secret).update(payload).digest("base64url");
  return `${payload}.${signature}`;
}

function verifyToken(token, secret) {
  if (!token || !secret) return null;
  const [payload, suppliedSignature] = String(token).split(".");
  if (!payload || !suppliedSignature) return null;
  const expected = crypto.createHmac("sha256", secret).update(payload).digest("base64url");
  if (!timingSafeEqualText(suppliedSignature, expected)) return null;
  try {
    const parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    if (!parsed.callId || !parsed.sessionId || !parsed.callAttemptId || !parsed.stage || parsed.exp < Date.now() / 1000) return null;
    return parsed;
  } catch { return null; }
}

function createVobizLiveRuntime({ repository, vobiz, getClientForOrg, verifyWebhook, mediaPath = MEDIA_PATH } = {}) {
  if (!repository || !vobiz) throw new Error("repository and Vobiz client are required for live voice runtime");
  const clientForOrg = createVertexClientProvider({ getClientForOrg });
  const activeCalls = new Set();
  const wss = new WebSocketServer({ noServer: true, maxPayload: 2 * 1024 * 1024 });

  function getSecret() {
    if (process.env.VOBIZ_STREAM_SECRET) return process.env.VOBIZ_STREAM_SECRET;
    return process.env.NODE_ENV === "production" ? "" : (process.env.VOBIZ_AUTH_TOKEN || "");
  }

  function displayLanguage(language) {
    const value = String(language || "en").trim().toLowerCase();
    if (value.startsWith("ta")) return "Tamil";
    if (value.startsWith("ml")) return "Malayalam";
    if (value.startsWith("te")) return "Telugu";
    if (value.startsWith("en")) return "English";
    return String(language || "English");
  }

  async function answerHandler(req, res) {
    try {
      if (!await verifyWebhook(req)) return res.status(401).send("Invalid Vobiz signature");
      const callId = req.body?.CallUUID || req.query?.CallUUID || req.body?.call_uuid || req.query?.call_uuid;
      const sessionId = req.query?.sessionId || req.body?.sessionId;
      const callAttemptId = req.query?.callAttemptId || req.body?.callAttemptId;
      const stage = req.query?.stage || req.body?.stage;
      if (!callId || !sessionId || !callAttemptId || !["check_in", "check_out"].includes(stage)) {
        return res.status(400).send("Missing Vobiz attendance call context");
      }
      const [session, attempt] = await Promise.all([
        repository.getAttendanceSession(sessionId),
        repository.getCallAttempt(callAttemptId),
      ]);
      if (!session || !attempt || attempt.sessionId !== session.id || (attempt.providerCallId && attempt.providerCallId !== String(callId))
          || attempt.callTargetRole !== "employee" || attempt.stage !== stage) {
        return res.status(403).send("Call context does not match the attendance session");
      }
      if (!attempt.providerCallId) await repository.attachProviderCallId(attempt.id, String(callId), { answerCallbackAccepted: true });

      const token = createToken({ callId: String(callId), sessionId, callAttemptId, stage }, getSecret());
      const publicBase = process.env.PUBLIC_BASE_URL
        ? new URL(process.env.PUBLIC_BASE_URL)
        : new URL(`${req.get("x-forwarded-proto") || req.protocol}://${req.get("x-forwarded-host") || req.get("host")}`);
      const wsProtocol = publicBase.protocol === "https:" ? "wss:" : "ws:";
      const streamUrl = new URL(mediaPath, publicBase);
      streamUrl.protocol = wsProtocol;
      streamUrl.searchParams.set("token", token);
      res.set("Content-Type", "text/xml; charset=utf-8");
      return res.status(200).send(`<?xml version="1.0" encoding="UTF-8"?>\n<Response><Stream bidirectional="true" keepCallAlive="true" contentType="audio/x-l16;rate=16000">${xmlEscape(streamUrl.toString())}</Stream></Response>`);
    } catch (error) {
      return res.status(error.status || 503).send("Unable to initialize the voice session");
    }
  }

  function handleUpgrade(request, socket, head) {
    let parsed;
    try { parsed = new URL(request.url, "http://localhost"); } catch { return false; }
    if (parsed.pathname !== mediaPath) return false;
    const token = verifyToken(parsed.searchParams.get("token"), getSecret());
    if (!token || activeCalls.has(token.callId)) {
      socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return true;
    }
    socket.once("close", () => activeCalls.delete(token.callId));
    Promise.all([
      repository.getAttendanceSession(token.sessionId),
      repository.getCallAttempt(token.callAttemptId),
    ]).then(([session, attempt]) => {
      if (!session || !attempt || attempt.sessionId !== session.id || attempt.providerCallId !== token.callId
          || attempt.callTargetRole !== "employee" || attempt.stage !== token.stage) {
        socket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
        socket.destroy();
        return;
      }
      repository.claimCallStream(token.callAttemptId).then((claimed) => {
        if (!claimed) {
          socket.write("HTTP/1.1 409 Conflict\r\nConnection: close\r\n\r\n");
          socket.destroy();
          return;
        }
      activeCalls.add(token.callId);
      wss.handleUpgrade(request, socket, head, (ws) => {
        wss.emit("connection", ws, request, { token, session, attempt });
      });
      }).catch(() => {
        socket.write("HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n");
        socket.destroy();
      });
    }).catch(() => {
      socket.write("HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n");
      socket.destroy();
    });
    return true;
  }

  wss.on("connection", (vobizWs, _request, context) => {
    const { token, session, attempt } = context;
    let streamId = null;
    let liveSession = null;
    let setupComplete = false;
    let greetingSent = false;
    let active = true;
    let startTimer;
    const pendingAudio = [];
    const seenToolCalls = new Set();
    startTimer = setTimeout(() => { if (!streamId) vobizWs.close(1008, "Missing Vobiz start event"); }, 10_000);

    function safeSend(payload) {
      if (vobizWs.readyState === 1 && streamId) vobizWs.send(JSON.stringify({ ...payload, streamId }));
    }
    function sendGreeting() {
      if (greetingSent || !setupComplete || !liveSession || !active) return;
      greetingSent = true;
      const language = displayLanguage(session.language);
      const greeting = token.stage === "check_in"
        ? "Greet the employee and explain that you are checking their home care shift arrival. Verify their identity and assigned patient, ask if they reached the patient, and capture the actual arrival time or expected arrival time."
        : "Greet the employee and explain that you are checking completion of their home care shift. Verify their identity and assigned patient, ask if the duty is complete, and capture the actual departure time or expected departure time.";
      liveSession.sendClientContent({
        turns: [{ role: "user", parts: [{ text: `[System direction, not caller speech] Begin the call now in ${language}. ${greeting} Keep responses short and natural for a phone conversation.` }] }],
        turnComplete: true,
      });
    }
    function sendPcmAudio(data) {
      if (!active || !streamId || vobizWs.readyState !== 1) return;
      const alignedLength = data.length - (data.length % 2);
      for (let offset = 0; offset < alignedLength; offset += OUTPUT_FRAME_BYTES) {
        const frame = data.subarray(offset, Math.min(offset + OUTPUT_FRAME_BYTES, alignedLength));
        safeSend({ event: "playAudio", media: { contentType: "audio/x-l16", sampleRate: OUTPUT_RATE, payload: frame.toString("base64") } });
      }
    }
    async function endCallAfterGoodbye(call) {
      if (seenToolCalls.has(call.id)) return;
      seenToolCalls.add(call.id);
      if (call.name !== "end_call") return;
      setTimeout(() => {
        vobiz.hangupCall(token.callId).catch((error) => console.error("[vobiz-live] hangup failed", error.message));
      }, 2500);
      try {
        await liveSession?.sendToolResponse({ functionResponses: [{ id: call.id, name: call.name, response: { result: { success: true, ending: true } } }] });
      } catch (error) { console.error("[vobiz-live] end-call tool response failed", error.message); }
    }
    function startLiveSession() {
      if (liveSession) return;
      (async () => {
        const [agent, agentContext] = await Promise.all([
          repository.getAgent(session.organizationId, session.agentId),
          repository.getAgentSessionContext(session.id, token.stage),
        ]);
        if (!agent?.active) throw new Error("Agent is missing or inactive");
        const client = await clientForOrg(session.organizationId);
        const language = displayLanguage(session.language);
        const systemPrompt = [
          "You are an AI attendance caller for home care shifts. You are calling the employee only; never call or ask the patient to speak.",
          `Speak naturally in ${language}.`,
          "Use the supplied session context and the previous call attempts so you remember the full assignment and what has already happened.",
          "Verify the employee and assigned patient. Ask the employee to confirm the patient name and location; do not read out private phone numbers or unnecessarily disclose the full address. Do not guess or claim GPS verification.",
          "For check-in, establish whether the employee reached the assigned patient and the actual arrival time. If they have not arrived, ask their expected arrival time and confirm a clear callback time.",
          "For check-out, establish whether the duty is complete and the actual departure time. If they are still working, ask the expected departure time and confirm when to call back.",
          "If any identity, client, time, or assignment detail is uncertain, ask a brief follow-up question. Never invent a time.",
          "After collecting the required information, thank the employee, say goodbye, then call end_call.",
          "Agent-specific instructions:", agent.systemPrompt || "Confirm attendance accurately and politely.",
          "Full session context:", formatSessionContext(agentContext),
        ].join("\n\n");
        liveSession = await client.live.connect({
          model: LIVE_MODEL,
          config: {
            responseModalities: ["AUDIO"],
            systemInstruction: { parts: [{ text: systemPrompt }] },
            inputAudioTranscription: {},
            outputAudioTranscription: {},
            speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: agent.voice || "Achird" } } },
            tools: [{ functionDeclarations: [{
              name: "end_call",
              description: "End this attendance call after the required details have been collected and the employee has heard the goodbye.",
              parameters: { type: "OBJECT", properties: {} },
            }] }],
          },
          callbacks: {
            onmessage: async (response) => {
              if (!active) return;
              if (response.setupComplete) {
                setupComplete = true;
                sendGreeting();
                for (const audio of pendingAudio.splice(0)) liveSession.sendRealtimeInput({ media: { data: audio, mimeType: "audio/pcm;rate=16000" } });
              }
              if (response.serverContent?.interrupted) safeSend({ event: "clearAudio" });
              const calls = response.toolCall?.functionCalls || [];
              for (const call of calls) await endCallAfterGoodbye(call);
              for (const part of response.serverContent?.modelTurn?.parts || []) {
                if (part.inlineData?.mimeType?.startsWith("audio/")) sendPcmAudio(Buffer.from(part.inlineData.data, "base64"));
                if (part.functionCall) await endCallAfterGoodbye(part.functionCall);
              }
            },
            onerror: (error) => {
              console.error("[vobiz-live] Vertex Live session error", error?.message || "unknown error");
              try { vobizWs.close(1011, "Voice agent error"); } catch {}
            },
            onclose: () => { if (active) { try { vobizWs.close(1011, "Voice agent disconnected"); } catch {} } },
          },
        });
        sendGreeting();
        for (const audio of pendingAudio.splice(0)) liveSession.sendRealtimeInput({ media: { data: audio, mimeType: "audio/pcm;rate=16000" } });
      })().catch((error) => {
        console.error("[vobiz-live] session setup failed", error.message);
        try { vobizWs.close(1011, "Voice session initialization failed"); } catch {}
      });
    }

    vobizWs.on("message", (raw) => {
      let message;
      try { message = JSON.parse(raw.toString()); } catch { vobizWs.close(1003, "Expected JSON media events"); return; }
      if (message.event === "start") {
        const callId = String(message.start?.callId || "");
        const mediaFormat = message.start?.mediaFormat || {};
        if (callId !== token.callId || !message.start?.streamId || Number(mediaFormat.sampleRate) !== 16000 || !String(mediaFormat.encoding || "").includes("l16")) {
          vobizWs.close(1008, "Vobiz call or media format mismatch");
          return;
        }
        streamId = message.start.streamId;
        clearTimeout(startTimer);
        startLiveSession();
      } else if (message.event === "media") {
        const payload = message.media?.payload;
        if (!payload) return;
        if (liveSession && setupComplete) liveSession.sendRealtimeInput({ media: { data: payload, mimeType: "audio/pcm;rate=16000" } });
        else if (pendingAudio.length < 150) pendingAudio.push(payload);
      }
    });

    vobizWs.on("close", () => {
      active = false;
      clearTimeout(startTimer);
      activeCalls.delete(token.callId);
      repository.endCallStream(attempt.id).catch(() => {});
      try { liveSession?.close(); } catch {}
    });
    vobizWs.on("error", () => {
      active = false;
      clearTimeout(startTimer);
      activeCalls.delete(token.callId);
      repository.endCallStream(attempt.id).catch(() => {});
      try { liveSession?.close(); } catch {}
    });
  });

  return {
    answerHandler,
    handleUpgrade,
    mediaPath,
    close() { wss.close(); },
  };
}

module.exports = { createVobizLiveRuntime, createToken, verifyToken };
