Warning: truncated output (original token count: 13314)
Total output lines: 739

"use strict";

const crypto = require("node:crypto");
const { URL } = require("node:url");
const { WebSocketServer } = require("ws");
const { createVertexClientProvider, formatSessionContext } = require("../agents/vertex-agent");
const { createPatientContactTool } = require("../agents/patient-contact-tool");
const { createInboundPcmRecorder } = require("../recording/inbound-pcm-recorder");
const { createCallRecorder } = require("../recording/manager");

const LIVE_MODEL = process.env.VERTEX_LIVE_AUDIO_MODEL || "gemini-live-2.5-flash-native-audio";
const MEDIA_PATH = process.env.VOBIZ_MEDIA_PATH || "/api/call-service/media";
// Vobiz expects the bidirectional stream at 16 kHz. Gemini Live returns 24 kHz.
const OUTPUT_RATE = 16_000;

function downsample24kTo16k(pcm24) {
  const inputSamples = Math.floor(pcm24.length / 2);
  const outputSamples = Math.floor(inputSamples * 2 / 3);
  const output = Buffer.allocUnsafe(outputSamples * 2);
  for (let i = 0; i < outputSamples; i++) {
    const position = i * 1.5;
    const leftIndex = Math.floor(position);
    const rightIndex = Math.min(inputSamples - 1, leftIndex + 1);
    const fraction = position - leftIndex;
    const left = pcm24.readInt16LE(leftIndex * 2);
    const right = pcm24.readInt16LE(rightIndex * 2);
    output.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(left + (right - left) * fraction))), i * 2);
  }
  return output;
}
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

function createToken({ callId, sessionId, callAttemptId, stage, direction, inboundCallId, appointmentCallId, organizationId }, secret, ttlSeconds = 600) {
  if (!secret) throw new Error("VOBIZ_STREAM_SECRET or VOBIZ_AUTH_TOKEN must be configured");
  const payload = Buffer.from(JSON.stringify({ callId, sessionId, callAttemptId, stage, direction, inboundCallId, appointmentCallId, organizationId, exp: Math.floor(Date.now() / 1000) + ttlSeconds })).toString("base64url");
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
    const validInbound = parsed.direction === "inbound" && parsed.inboundCallId && parsed.organizationId;
    const validAppointment = parsed.appointmentCallId;
    const validOutbound = parsed.sessionId && parsed.callAttemptId && parsed.stage;
    if (!parsed.callId || (!validInbound && !validOutbound && !validAppointment) || parsed.exp < Date.now() / 1000) return null;
    return parsed;
  } catch { return null; }
}

function createVobizLiveRuntime({ repository, vobiz, getClientForOrg, verifyWebhook, recordings, queue, mediaPath = MEDIA_PATH } = {}) {
  if (!repository || !vobiz || !recordings?.storeCallRecordingBuffer || !queue?.enqueue) throw new Error("repository, Vobiz, recording storage and durable queue are required for live voice runtime");
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

  function speechLanguageCode(language) {
    const value = String(language || "en").trim().toLowerCase();
    if (value.startsWith("ta")) return "ta-IN";
    if (value.startsWith("ml")) return "ml-IN";
    if (value.startsWith("te")) return "te-IN";
    return "en-IN";
  }

  function formatLocalAppointmentTime(value) {
    const date = new Date(value);
    if (!Number.isFinite(date.getTime())) return String(value || "the requested time");
    return new Intl.DateTimeFormat("en-IN", {
      timeZone: process.env.APP_TIMEZONE || "Asia/Kolkata", dateStyle: "full", timeStyle: "short",
    }).format(date);
  }

  function inboundGreetingPeriod() {
    const timeZone = process.env.APP_TIMEZONE || "Asia/Kolkata";
    try {
      const hour = Number(new Intl.DateTimeFormat("en-IN", { timeZone, hour: "2-digit", hourCycle: "h23" }).format(new Date()));
      return hour < 12 ? "morning" : hour < 17 ? "afternoon" : "evening";
    } catch {
      const hour = new Date().getUTCHours();
      return hour < 12 ? "morning" : hour < 17 ? "afternoon" : "evening";
    }
  }
  function inboundPatientAgentPrompt(language, dialect, patientContext, matchedByRegisteredPhone, careActivities) {
    const name = process.env.INBOUND_PATIENT_AGENT_NAME || "Athulya Patient Care Assistant";
    const extraInstructions = process.env.INBOUND_PATIENT_AGENT_PROMPT?.trim();
    return [
      `You are ${name}, the incoming-call patient support voice assistant for Athulya Senior Care.`,
      `Speak naturally in ${language}${dialect ? ` using the ${dialect} dialect` : ""}. Be warm, calm, and concise. Ask one short question at a time, then wait for the caller to answer.`,
      `Use the local good ${inboundGreetingPeriod()} greeting in ${language}. Greet the patient by their first name when available, then confirm who is speaking before discussing private care details.`,
      "After confirming the caller's name, ask what help or care they need. Listen carefully and map the caller's wording, common alternate names, or described task to the closest canonical activity in the catalog below. Ask a brief clarification if no listed activity fits.",
      "Ask when they want this care to start, including the date if they say a relative day such as tomorrow. Do not ask for duration or end time; the platform uses the activity's configured duration. Repeat the activity and requested start date/time briefly to confirm.",
      "Acknowledge the request in their language: say you have noted it and the care team will review it, coordinate an appropriate staff member, and contact them with next steps. Do not claim a staff member or appointment has already been assigned.",
      "You answer patients and their caregivers who called Athulya. You are not making an outbound call. Never introduce yourself as attendance management or discuss staff attendance/check-in/check-out.",
      matchedByRegisteredPhone
        ? "The caller number matches a registered patient contact. Caller ID alone does not prove identity: ask the caller to confirm their name before discussing private care details."
        : "This call was permitted by the organization's non-patient inbound-call setting. The caller is not matched to a registered patient; ask for their name and reason for calling, and do not imply that they are registered.",
      "Use only the patient context below. Never reveal phone numbers, another patient's information, staff records, or internal attendance data. Do not diagnose, recommend treatment, promise availability, or claim to have changed a booking. For immediate danger in India, direct the caller to emergency services at 112.",
      "When the caller is finished, summarize the request briefly, thank them, say goodbye, and call end_call.",
      extraInstructions ? `Additional patient-support instructions:\n${extraInstructions}` : "",
      "Available care activities (canonical id and name, alternate names/synonyms, duration minutes, and description):", JSON.stringify(careActivities),
      "Patient context:", JSON.stringify({ patient: patientContext, matchedByRegisteredPhone }),
    ].filter(Boolean).join("\n\n");
  }

  function languageKey(language) {
    const value = String(language || "en").trim().toLowerCase();
    if (value.startsWith("ta") || value.includes("tamil")) return "ta";
    if (value.startsWith("ml") || value.includes("malayalam")) return "ml";
    if (value.startsWith("te") || value.includes("telugu")) return "te";
    return "en";
  }

  async function answerHandler(req, res) {
    try {
      if (!await verifyWebhook(req)) {
        console.warn("[vobiz-inbound] rejected Answer URL request: invalid Vobiz signature");
        return res.status(401).send("Invalid Vobiz signature");
      }
      console.info("[vobiz-inbound] Answer URL request signature verified");
      const callId = req.body?.CallUUID || req.query?.CallUUID || req.body?.call_uuid || req.query?.call_uuid;
      const appointmentCallId = req.query?.appointmentCallId || req.body?.appointmentCallId;
      if (callId && appointmentCallId) {
        const appointmentCall = await repository.getAppointmentCallContext(appointmentCallId);
        if (!appointmentCall || (appointmentCall.providerCallId && appointmentCall.providerCallId !== String(callId))) {
          return res.status(403).send("Call context does not match the appointment booking");
        }
        if (!appointmentCall.providerCallId) await repository.attachAppointmentProviderCallId(appointmentCallId, String(callId));
        const token = createToken({ callId: String(callId), appointmentCallId }, getSecret());
        const publicBase = process.env.PUBLIC_BASE_URL ? new URL(process.env.PUBLIC_BASE_URL)
          : new URL(`${req.get("x-forwarded-proto") || req.protocol}://${req.get("x-forwarded-host") || req.get("host")}`);
        const streamUrl = new URL(mediaPath, publicBase);
        streamUrl.protocol = publicBase.protocol === "https:" ? "wss:" : "ws:";
        streamUrl.searchParams.set("token", token);
        res.set("Content-Type", "text/xml; charset=utf-8");
        return res.status(200).send(`<?xml version="1.0" encoding="UTF-8"?>\n<Response><Stream bidirectional="true" audioTrack="inbound" keepCallAlive="true" contentType="audio/x-l16;rate=16000">${xmlEscape(streamUrl.toString())}</Stream></Response>`);
      }
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
      console.info(`[vobiz-inbound] returning bidirectional stream XML call=${callId}`);
      return res.status(200).send(`<?xml version="1.0" encoding="UTF-8"?>\n<Response><Stream bidirectional="true" audioTrack="inbound" keepCallAlive="true" contentType="audio/x-l16;rate=16000">${xmlEscape(streamUrl.toString())}</Stream></Response>`);
    } catch (error) {
      return res.status(error.status || 503).send("Unable to initialize the voice session");
    }
  }

  async function incomingAnswerHandler(req, res) {
    try {
      if (!await verifyWebhook(req)) return res.status(401).send("Invalid Vobiz signature");
      const callId = req.body?.CallUUID || req.query?.CallUUID || req.body?.call_uuid || req.query?.call_uuid;
      const fromNumber = req.body?.From || req.body?.from || req.body?.Caller || "";
      const toNumber = req.body?.To || req.body?.to || "";
      const direction = String(req.body?.Direction || req.body?.direction || "inbound").toLowerCase();
      if (!callId || !fromNumber || (direction && direction !== "inbound")) {
        console.warn(`[vobiz-inbound] rejected Answer URL payload callIdPresent=${Boolean(callId)} fromPresent=${Boolean(fromNumber)} direction=${direction || "unknown"}`);
        return res.status(400).send("Missing inbound Vobiz call details");
      }

      // This tool performs one exact patient-phone lookup and cannot enumerate
      // contacts or retrieve staff records.
      const organizationId = process.env.DEFAULT_ORGANIZATION_ID;
      if (!organizationId) return res.status(503).send("Inbound calls are not configured");
      const patientTool = createPatientContactTool(repository, organizationId);
      const patientResult = await patientTool.invoke({ phoneNumber: fromNumber });
      const patient = typeof patientResult === "string" ? JSON.parse(patientResult) : patientResult;
      if (!patient) {
        const callingSettings = await repository.getOrganizationCallSettings(organizationId);
        if (callingSettings.allowNonPatientInboundCalls !== true) {
          console.info(`[vobiz-inbound] rejected unregistered caller call=${callId}`);
          res.set("Content-Type", "text/xml; charset=utf-8");
          return res.status(200).send('<?xml version="1.0" encoding="UTF-8"?><Response><Hangup/></Response>');
        }
      }
      const language = patient?.language || "en";
      const agents = await repository.listAgents(organizationId);
      const agent = agents.find((candidate) => candidate.active && displayLanguage(candidate.language).toLowerCase() === displayLanguage(language).toLowerCase())
        || agents.find((candidate) => candidate.active);
      if (!agent) return res.status(503).send("No active voice agent is configured");
      const inboundCall = await repository.createInboundCall({ organizationId, providerCallId: String(callId), fromNumber, toNumber, patient, agentId: agent.id, language });
      console.info(`[vobiz-inbound] call initialized call=${callId} language=${language} patientMatched=${Boolean(patient?.id)}`);
      const token = createToken({ callId: String(callId), direction: "inbound", inboundCallId: inboundCall.id, organizationId }, getSecret());
      const publicBase = process.env.PUBLIC_BASE_URL
        ? new URL(process.env.PUBLIC_BASE_URL)
        : new URL(`${req.get("x-forwarded-proto") || req.protocol}://${req.get("x-forwarded-host") || req.get("host")}`);
      const streamUrl = new URL(mediaPath, publicBase);
      streamUrl.protocol = publicBase.protocol === "https:" ? "wss:" : "ws:";
      streamUrl.searchParams.set("token", token);
      res.set("Content-Type", "text/xml; charset=utf-8");
      return res.status(200).send(`<?xml version="1.0" encoding="UTF-8"?>\n<Response><Stream bidirectional="true" audioTrack="inbound" keepCallAlive="true" contentType="audio/x-l16;rate=16000">${xmlEscape(streamUrl.toString())}</Stream></Response>`);
    } catch (error) {
      console.error("[vobiz-inbound] answer initialization failed", error?.stack || error?.message || error);
      return res.status(error.status || 503).send("Unable to initialize inbound voice session");
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
    if (token.direction === "inbound") {
      repository.getInboundCall(token.inboundCallId, token.organizationId).then(async (inboundCall) => {
        if (!inboundCall || inboundCall.providerCallId !== token.callId) {
          socket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n"); socket.destroy(); return;
        }
        const claimed = await repository.claimInboundCallStream(inboundCall.id);
        if (!claimed) {
          socket.write("HTTP/1.1 409 Conflict\r\nConnection: close\r\n\r\n"); socket.destroy(); return;
        }
        activeCalls.add(token.callId);
        wss.handleUpgrade(request, socket, head, (ws) => wss.emit("connection", ws, request, { token, inboundCall }));
      }).catch((error) => {
        console.error("[vobiz-inbound] media context lookup failed", error.message);
        socket.write("HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n"); socket.destroy();
      });
      return true;
    }
    if (token.appointmentCallId) {
      repository.getAppointmentCallContext(token.appointmentCallId).then(async (appointmentCall) => {
        if (!appointmentCall || appointmentCall.providerCallId !== token.callId) {
          socket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n"); socket.destroy(); return;
        }
        const claimed = await repository.claimAppointmentCallStream(token.appointmentCallId);
        if (!claimed) { socket.write("HTTP/1.1 409 Conflict\r\nConnection: close\r\n\r\n"); socket.destroy(); return; }
        activeCalls.add(token.callId);
        wss.handleUpgrade(request, socket, head, (ws) => wss.emit("connection", ws, request, { token, appointmentCall }));
      }).catch((error) => {
        console.error("[appointment-booking] media context lookup failed", error.message);
        socket.write("HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n"); socket.destroy();
      });
      return true;
    }
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
        socket.write("HTTP/1.1 503 Service Unavailable\r…3314 tokens truncated…ve] end-call tool response failed call=${token.callId}`, error.message); }
      // end_call can arrive beside the final goodbye audio. Do not reuse the
      // previous turn's checkpoint while this turn still has uncheckpointed
      // frames, or its already-played acknowledgement can cut off the goodbye.
      if (latestCheckpoint && outboundFrames === checkpointFrameOffset) requestHangupAfterPlayback(latestCheckpoint);
    }
    function startLiveSession() {
      if (liveSession) return;
      (async () => {
        const [agent, agentContext, careActivities] = await Promise.all([
          repository.getAgent(callContext.organizationId, callContext.agentId),
          inboundCall || appointmentCall
            ? Promise.resolve({ patient: inboundCall?.patient || appointmentCall?.patient || {}, caller: { matchedPatient: Boolean(inboundCall?.patient?.id) } })
            : repository.getAgentSessionContext(session.id, token.stage),
          inboundCall ? repository.listCareActivities(callContext.organizationId) : Promise.resolve([]),
        ]);
        if (!agent?.active) throw new Error("Agent is missing or inactive");
        const client = await clientForOrg(callContext.organizationId);
        const activeLanguage = appointmentCall?.staff?.language || callContext.language;
        const language = displayLanguage(activeLanguage);
        const languageConfig = agent.languagePrompts?.[languageKey(activeLanguage)] || {};
        const dialect = String(languageConfig.dialect || "").trim();
        const languageInstructions = String(languageConfig.systemPrompt || "").trim();
        const systemPrompt = appointmentCall ? [
          `You are ${process.env.APPOINTMENT_BOOKING_AGENT_NAME || "Athulya Appointment Coordinator"}, a separate appointment coordination voice agent calling staff to confirm a requested care duty.`,
          `Speak naturally in ${language}${dialect ? ` using ${dialect}` : ""}. The schedule uses UTC timestamps; convert and speak them in ${process.env.APP_TIMEZONE || "Asia/Kolkata"} local time. Ask whether the staff member is available and willing to take the assignment at the stated exact time. If yes, explicitly confirm the activity and time once more and obtain a clear final yes. If no, acknowledge the decline. Never claim availability or booking without the staff member's explicit confirmation. Do not ask attendance check-in/check-out questions. Ask one short question at a time and wait for the answer. End only after the staff member has responded and the availability outcome is clear.`,
          "Additional appointment agent instructions:", process.env.APPOINTMENT_BOOKING_AGENT_PROMPT?.trim() || "",
          `Language instructions (${language}${dialect ? `, ${dialect}` : ""}):`, languageInstructions,
          "Appointment context:", JSON.stringify({ staff: appointmentCall.staff?.name, activity: appointmentCall.analysis?.activityName, requestedStartAt: appointmentCall.analysis?.requestedStartAt, durationMinutes: appointmentCall.analysis?.durationMinutes, patientDistrict: String(appointmentCall.patient?.address || "").split(" | ")[1] || "" }),
        ].join("\n\n") : inboundCall ? inboundPatientAgentPrompt(
          language,
          String(languageConfig.dialect || "").trim(),
          { id: agentContext.patient?.id || null, name: agentContext.patient?.name || null, address: agentContext.patient?.address || null },
          Boolean(inboundCall.patient?.id),
          careActivities.slice(0, 100).map(({ id, name, aliases = [], durationMinutes, description }) => ({ id, name, aliases, durationMinutes, description })),
        ) : [
          "You are an AI attendance caller for home care shifts. You are calling the employee only; never call or ask the patient to speak.",
          "Tell the employee this call is recorded for attendance verification before asking for attendance details.",
          `Speak unmistakably and naturally in ${language}${dialect ? ` using the ${dialect} dialect` : ""}.`,
          "Use the supplied session context and previous call attempts. Schedule timestamps in context are UTC; assignment.timeZone is the employee's IANA local timezone from the frontend. Interpret and speak schedule times in that local timezone, never read UTC timestamps aloud.",
          "Never simulate an employee response. Ask one short question at a time and wait for a live answer before continuing. Keep the call connected while waiting; do not end it until the employee has spoken during this call and the required attendance details are collected.",
          "For every check-in call, including automatic retries after no-answer and callbacks, ask one short question at a time and follow this order. First ask whether the employee has reached the patient's home now; do not ask for or reveal employee/patient details before this answer. If yes, ask them to state the assigned patient's full name and home address without reading either value to them, and compare both answers with the assignment context. Then ask the employee's full name, followed by the time they actually arrived at the patient's home. Always ask for the actual arrival time, even when this is a retry after the scheduled check-in; never use the call time or scheduled start as the reported arrival time. If they have not arrived, ask when they expect to arrive and when they want the callback. Confirm the callback time by saying you will call again then to check if they have reached the patient, and wait for confirmation. Do not ask patient identity/address on a no-arrival answer. Never invent a time or claim GPS verification. Use prior call context but always ask arrival status again on every answered retry or callback.",
          "For every check-out call, including automatic retries after no-answer and callbacks, first ask whether the duty is complete and the employee has left the patient's home now. Do not ask for patient name or address during check-out. If yes, ask the employee's full name and the actual time they left. Always ask for the actual departure time, even if this is a retry after the scheduled check-out; never use the call time or scheduled end as the reported departure time. If the duty is not complete, ask when they expect to finish and when they want the callback. Confirm that you will call again then to check whether the duty is complete, and wait for confirmation. Ask one short question at a time, do not assume a prior attempt's answer applies now, and do not invent times.",
          "For check-in completion, the employee must confirm arrival, correctly state the assigned patient's name and address, verify their own name, and report the actual arrival time. For check-out completion, the employee must confirm duty completion, verify their own name, and report the actual departure time. Do not ask patient name or address during check-out. When not yet arrived or still on duty, capture the agreed callback time and say you will call again then; do not mark the stage confirmed.",
          "If any identity, client, time, or assignment detail is uncertain, ask a brief follow-up question. Never invent a time.",
          "Ask only one verification question per turn, wait for the employee's answer, and continue the checklist. After collecting all required information, summarize the verification result, ask if anything needs correction, then thank the employee, say goodbye, and call end_call.",
          "General agent instructions:", agent.systemPrompt || "Confirm attendance accurately and politely.",
          `Instructions for ${language}${dialect ? ` (${dialect})` : ""}:`, languageInstructions || `Use natural spoken ${language} and familiar local wording; remain clear and respectful.`,
          "Full session context:", formatSessionContext(agentContext),
        ].join("\n\n");
        liveSession = await client.live.connect({
          model: LIVE_MODEL,
          config: {
            responseModalities: ["AUDIO"],
            systemInstruction: { parts: [{ text: systemPrompt }] },
            inputAudioTranscription: {},
            outputAudioTranscription: {},
            speechConfig: {
              languageCode: speechLanguageCode(appointmentCall?.staff?.language || callContext.language),
              voiceConfig: { prebuiltVoiceConfig: { voiceName: (inboundCall ? process.env.INBOUND_PATIENT_AGENT_VOICE : appointmentCall ? process.env.APPOINTMENT_BOOKING_AGENT_VOICE : "") || agent.voice || "Achird" } },
            },
            tools: [{ functionDeclarations: [{
              name: "end_call",
              description: "End this attendance call only after the employee has spoken during this call and the mandatory check-in or check-out verification checklist has been completed, including address/location confirmation for check-in.",
              parameters: { type: "OBJECT", properties: {} },
            }] }],
          },
          callbacks: {
            onopen: () => {
              console.info(`[vobiz-live] Vertex Live websocket opened call=${token.callId} model=${LIVE_MODEL} location=${process.env.GOOGLE_CLOUD_LOCATION || "us-central1"}`);
            },
            onmessage: async (response) => {
              if (!active) return;
              try {
              if (response.setupComplete) {
                setupComplete = true;
                console.info(`[vobiz-live] Gemini Live setup complete call=${token.callId} model=${LIVE_MODEL}`);
                // Live.connect() can deliver this callback before its promise
                // resolves and assigns liveSession. Defer session I/O until
                // the await below has completed.
              }
              // Gemini Live sends input transcription as a top-level server message.
              // Keep the serverContent fallback for compatible SDK/model variants.
              const callerText = response.inputTranscription?.text?.trim()
                || response.serverContent?.inputTranscription?.text?.trim();
              if (callerText && !callerResponseObserved) {
                callerResponseObserved = true;
                console.info(`[vobiz-live] ${appointmentCall ? "staff" : "employee"} response detected call=${token.callId} transcriptChars=${callerText.length}`);
              }
              if (response.serverContent?.interrupted) safeSend({ event: "clearAudio" });
              const inputText = String(response.inputTranscription?.text || response.serverContent?.inputTranscription?.text || response.serverContent?.inputAudioTranscription?.text || "").trim();
              if (inputText) {
                if (appointmentCall) clearTimeout(appointmentNoResponseTimer);
                employeeTranscriptChars += inputText.length;
                employeeResponseTurns += 1;
                console.info(`[vobiz-live] ${appointmentCall ? "staff" : "employee"} response detected call=${token.callId} transcriptChars=${inputText.length} totalResponses=${employeeResponseTurns}`);
              }
              for (const part of response.serverContent?.modelTurn?.parts || []) {
                if (part.inlineData?.mimeType?.startsWith("audio/")) {
                  const audio = Buffer.from(part.inlineData.data, "base64");
                  generatedAudioParts += 1;
                  if (generatedAudioParts === 1) console.info(`[vobiz-live] first Gemini audio part call=${token.callId} mime=${part.inlineData.mimeType} bytes=${audio.length}`);
                  if (recorder) recorder.write(downsample24kTo16k(audio), { track: "agent" });
                  sendPcmAudio(audio);
                }
              }
              const calls = response.toolCall?.functionCalls || [];
              for (const call of calls) await endCallAfterGoodbye(call);
              for (const part of response.serverContent?.modelTurn?.parts || []) {
                if (part.functionCall) await endCallAfterGoodbye(part.functionCall);
              }
              if (response.serverContent?.turnComplete && outboundFrames > checkpointFrameOffset) {
                playbackTurn += 1;
                checkpointFrameOffset = outboundFrames;
                latestCheckpoint = `gemini-turn-${playbackTurn}`;
                safeSend({ event: "checkpoint", name: latestCheckpoint });
                console.info(`[vobiz-live] playback checkpoint sent call=${token.callId} name=${latestCheckpoint}`);
                if (hangupRequested) requestHangupAfterPlayback(latestCheckpoint);
              }
              } catch (error) {
                console.error(`[vobiz-live] Gemini message handling failed call=${token.callId}`, error?.stack || error?.message || error);
                try { vobizWs.close(1011, "Voice message processing failed"); } catch {}
              }
            },
            onerror: (error) => {
              console.error(`[vobiz-live] Vertex Live session error call=${token.callId} message=${error?.message || error?.error?.message || "unknown error"}`);
              try { vobizWs.close(1011, "Voice agent error"); } catch {}
            },
            onclose: (event) => {
              console.error(`[vobiz-live] Vertex Live websocket closed call=${token.callId} code=${event?.code ?? "unknown"} reason=${JSON.stringify(event?.reason || "")} wasClean=${event?.wasClean ?? "unknown"} setupComplete=${setupComplete}`);
              if (active) { try { vobizWs.close(1011, "Voice agent disconnected"); } catch {} }
            },
          },
        });
        sendGreeting();
        for (const audio of pendingAudio.splice(0)) liveSession.sendRealtimeInput({ media: { data: audio, mimeType: "audio/pcm;rate=16000" } });
      })().catch((error) => {
        console.error(`[vobiz-live] session setup failed call=${token.callId}`, error?.stack || error?.message || error);
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
        console.info(`[vobiz-live] Vobiz stream started call=${token.callId} stream=${streamId} encoding=${mediaFormat.encoding} sampleRate=${mediaFormat.sampleRate}`);
        if (inboundCall) {
          inboundRecorderPromise.then(() => startLiveSession()).catch((error) => {
            console.error(`[vobiz-inbound] recorder start failed call=${token.callId}`, error.message);
            try { vobizWs.close(1011, "Recording initialization failed"); } catch {}
          });
          return;
        }
        recorder = createCallRecorder({
          provider: "vobiz",
          callId: appointmentCall?.id || attempt.id,
          orgId: appointmentCall?.organizationId || session.organizationId,
          mode: process.env.RECORDING_MODE || "platform",
          tempDir: process.env.RECORDING_TEMP_DIR || "/tmp/attendance-recordings",
          uploadPlatformRecording: async (wavBuffer) => {
            const object = appointmentCall
              ? await recordings.storeAppointmentCallRecordingBuffer(wavBuffer, { organizationId: appointmentCall.organizationId, appointmentCallId: appointmentCall.id })
              : await recordings.storeCallRecordingBuffer(wavBuffer, { organizationId: session.organizationId, sessionId: session.id, callAttemptId: attempt.id });
            if (appointmentCall) {
              await repository.saveAppointmentCallRecording(appointmentCall.id, object.key, object.contentType);
              await queue.enqueue("process_appointment_call", { appointmentCallId: appointmentCall.id }, { idempotencyKey: `appointment-result:${appointmentCall.id}` });
              console.info(`[appointment-booking] call recording stored attempt=${appointmentCall.id} bytes=${object.sizeBytes}`);
            } else {
              await repository.setRecordingObjectKey(attempt.id, object.key, object.contentType);
              console.info(`[vobiz-recording] platform recording stored attempt=${attempt.id} bytes=${object.sizeBytes} key=${object.key}`);
              await queue.enqueue("transcribe_call", { callAttemptId: attempt.id }, { idempotencyKey: `transcribe:${attempt.id}` });
            }
            return object.key;
          },
        });
        recorder.start().then(startLiveSession).catch((error) => {
          console.error(`[vobiz-recording] recorder start failed attempt=${appointmentCall?.id || attempt?.id || "unknown"}`, error?.message || error);
          try { vobizWs.close(1011, "Recording initialization failed"); } catch {}
        });
      } else if (message.event === "playedStream") {
        const checkpoint = message.name || message.playedStream?.name;
        if (checkpoint) playedCheckpoints.add(checkpoint);
        console.info(`[vobiz-live] playback confirmed call=${token.callId} name=${checkpoint || "unknown"}`);
        if (checkpoint && checkpoint === pendingHangupCheckpoint) requestHangupAfterPlayback(checkpoint);
      } else if (message.event === "clearedAudio") {
        console.info(`[vobiz-live] playback cleared call=${token.callId}`);
      } else if (message.event === "media") {
        const payload = message.media?.payload;
        if (!payload) return;
        inboundFrames += 1;
        const callerPcm = Buffer.from(payload, "base64");
        recorder?.write(callerPcm, { track: "caller" });
        if (inboundCall) appendInboundAudio(payload, 16_000);
        if (inboundFrames === 1) console.info(`[vobiz-live] first caller audio frame call=${token.callId} bytes=${callerPcm.length}`);
        if (liveSession && setupComplete) liveSession.sendRealtimeInput({ media: { data: payload, mimeType: "audio/pcm;rate=16000" } });
        else if (pendingAudio.length < 150) pendingAudio.push(payload);
      }
    });

    vobizWs.on("close", (code, reason) => {
      active = false;
      clearTimeout(startTimer);
      clearTimeout(appointmentNoResponseTimer);
      activeCalls.delete(token.callId);
      console.info(`[vobiz-live] stream closed call=${token.callId} code=${code} reason=${reason?.toString() || ""} inboundFrames=${inboundFrames} outboundFrames=${outboundFrames} generatedAudioParts=${generatedAudioParts}`);
      if (inboundCall) void finalizeInboundCall(code === 1000 ? "completed" : "failed");
      recorderFinalizePromise ||= Promise.resolve(recorder?.finalize()).catch((error) => {
        console.error(`[vobiz-recording] finalize failed attempt=${appointmentCall?.id || attempt?.id || "unknown"}`, error?.message || error);
      });
      if (!appointmentCall && !inboundCall) repository.endCallStream(attempt.id).catch(() => {});
      try { liveSession?.close(); } catch {}
    });
    vobizWs.on("error", () => {
      active = false;
      clearTimeout(startTimer);
      clearTimeout(appointmentNoResponseTimer);
      activeCalls.delete(token.callId);
      recorderFinalizePromise ||= Promise.resolve(recorder?.finalize()).catch((error) => {
        console.error(`[vobiz-recording] finalize failed attempt=${appointmentCall?.id || attempt?.id || "unknown"}`, error?.message || error);
      });
      if (!appointmentCall && !inboundCall) repository.endCallStream(attempt.id).catch(() => {});
      try { liveSession?.close(); } catch {}
    });
  });

  return {
    answerHandler,
    incomingAnswerHandler,
    handleUpgrade,
    mediaPath,
    close() { wss.close(); },
  };
}

module.exports = { createVobizLiveRuntime, createToken, verifyToken };
