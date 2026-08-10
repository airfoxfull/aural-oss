import { randomUUID } from "crypto";
import { config } from "dotenv";
import { WebSocket, WebSocketServer, type RawData } from "ws";
import { createLogger } from "../src/lib/logger";
import {
  buildRealtimeSessionUpdate,
  clampQuestionIndex,
  hex16kPcmTo24kBase64,
  type InterviewContext,
  parseQuestionChangeArguments,
  sortedQuestions,
} from "./openai-realtime-direct-helpers";

config({ path: ".env.local", override: true });
config({ path: ".env" });

const log = createLogger("openai-realtime-direct");

const RELAY_PORT =
  Number(process.env.OPENAI_VOICE_RELAY_PORT || process.env.VOICE_RELAY_PORT) || 8767;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
const OPENAI_REALTIME_MODEL = process.env.OPENAI_REALTIME_MODEL || "gpt-realtime-2.1";
const OPENAI_REALTIME_VOICE = process.env.OPENAI_REALTIME_VOICE || "marin";
const OPENAI_REALTIME_TRANSCRIPTION_MODEL =
  process.env.OPENAI_REALTIME_TRANSCRIPTION_MODEL || "gpt-4o-mini-transcribe";
const OPENAI_REALTIME_VAD =
  process.env.OPENAI_REALTIME_VAD === "server_vad" ? "server_vad" : "semantic_vad";
const OPENAI_REALTIME_WS_URL =
  process.env.OPENAI_REALTIME_WS_URL ||
  `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(OPENAI_REALTIME_MODEL)}`;

// Aural buffers a small amount of PCM before playback. WebSocket Realtime clients
// are responsible for truncating unheard assistant audio after a barge-in. Since
// the browser relay protocol does not expose an exact playback cursor, subtract a
// conservative guard from wall-clock playback when estimating what was heard.
const PLAYBACK_GUARD_MS = 180;
const PLAYBACK_TAIL_ALLOWANCE_MS = 350;
const PCM24_MONO_BYTES_PER_MS = 48; // 24,000 samples/sec * 2 bytes / 1,000

if (!OPENAI_API_KEY) {
  log.error("Missing OPENAI_API_KEY. Add it to .env.local before starting the relay.");
  process.exit(1);
}

type JsonRecord = Record<string, unknown>;

type ResponseState = {
  hadAssistantOutput: boolean;
  hadFunctionCall: boolean;
  transcript: string;
};

interface RelaySession {
  id: string;
  browser: WebSocket;
  upstream: WebSocket | null;
  context: InterviewContext | null;
  currentQuestionIndex: number;
  readySent: boolean;
  upstreamReady: boolean;
  responseActive: boolean;
  currentResponseId: string | null;
  responses: Map<string, ResponseState>;
  closing: boolean;
  asrByItem: Map<string, string>;
  lastAudioItemId: string | null;
  lastAudioContentIndex: number;
  lastAudioFirstSentAt: number | null;
  lastAudioBytesSent: number;
  keepAliveTimer: ReturnType<typeof setInterval> | null;
}

function safeJsonSend(ws: WebSocket, payload: JsonRecord): void {
  if (ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify(payload));
}

function safeBinarySend(ws: WebSocket, payload: Buffer): void {
  if (ws.readyState !== WebSocket.OPEN) return;
  ws.send(payload, { binary: true });
}

function sendUpstream(session: RelaySession, payload: JsonRecord): boolean {
  if (!session.upstream || session.upstream.readyState !== WebSocket.OPEN) return false;
  session.upstream.send(JSON.stringify(payload));
  return true;
}

function responseCreate(instructions?: string): JsonRecord {
  return instructions
    ? { type: "response.create", response: { instructions } }
    : { type: "response.create" };
}

function responseIdFromEvent(event: JsonRecord): string | null {
  if (typeof event.response_id === "string") return event.response_id;
  const response = event.response as JsonRecord | undefined;
  return response && typeof response.id === "string" ? response.id : null;
}

function responseStateForEvent(
  session: RelaySession,
  event: JsonRecord,
  create = true,
): ResponseState | null {
  const responseId = responseIdFromEvent(event) || session.currentResponseId;
  if (!responseId) return null;
  const existing = session.responses.get(responseId);
  if (existing || !create) return existing || null;
  const state: ResponseState = {
    hadAssistantOutput: false,
    hadFunctionCall: false,
    transcript: "",
  };
  session.responses.set(responseId, state);
  return state;
}

function questionText(ctx: InterviewContext, index: number): string {
  const questions = sortedQuestions(ctx);
  return questions[index]?.text || "";
}

function updateSessionInstructions(session: RelaySession): void {
  if (!session.context) return;
  sendUpstream(
    session,
    buildRealtimeSessionUpdate(session.context, session.currentQuestionIndex, {
      voice: OPENAI_REALTIME_VOICE,
      transcriptionModel: OPENAI_REALTIME_TRANSCRIPTION_MODEL,
      vadMode: OPENAI_REALTIME_VAD,
    }),
  );
}

function addSystemContext(session: RelaySession, text: string): void {
  sendUpstream(session, {
    type: "conversation.item.create",
    item: {
      type: "message",
      role: "system",
      content: [{ type: "input_text", text }],
    },
  });
}

function addUserText(session: RelaySession, text: string): void {
  sendUpstream(session, {
    type: "conversation.item.create",
    item: {
      type: "message",
      role: "user",
      content: [{ type: "input_text", text }],
    },
  });
}

function resetAudioTracking(session: RelaySession): void {
  session.lastAudioItemId = null;
  session.lastAudioContentIndex = 0;
  session.lastAudioFirstSentAt = null;
  session.lastAudioBytesSent = 0;
}

function assistantAudioMayStillBePlaying(session: RelaySession): boolean {
  if (
    !session.lastAudioItemId ||
    !session.lastAudioFirstSentAt ||
    session.lastAudioBytesSent <= 0
  ) {
    return false;
  }

  const generatedMs = session.lastAudioBytesSent / PCM24_MONO_BYTES_PER_MS;
  const elapsedMs = Math.max(0, Date.now() - session.lastAudioFirstSentAt);
  return elapsedMs <= generatedMs + PLAYBACK_TAIL_ALLOWANCE_MS;
}

function truncateUnheardAssistantAudio(session: RelaySession): void {
  const itemId = session.lastAudioItemId;
  if (!itemId || session.lastAudioBytesSent <= 0) return;

  const generatedMs = session.lastAudioBytesSent / PCM24_MONO_BYTES_PER_MS;
  const elapsedMs = session.lastAudioFirstSentAt
    ? Math.max(0, Date.now() - session.lastAudioFirstSentAt - PLAYBACK_GUARD_MS)
    : 0;
  const heardMs = Math.max(0, Math.min(generatedMs, elapsedMs));

  sendUpstream(session, {
    type: "conversation.item.truncate",
    item_id: itemId,
    content_index: session.lastAudioContentIndex,
    audio_end_ms: Math.floor(heardMs),
  });

  log.debug(
    `Truncated assistant audio item ${itemId} at ~${Math.floor(heardMs)}ms ` +
      `(generated ~${Math.floor(generatedMs)}ms)`,
  );
  resetAudioTracking(session);
}

function interruptAssistantPlayback(session: RelaySession): void {
  const playbackLikelyActive = assistantAudioMayStillBePlaying(session);

  // A normal interview turn starts after the interviewer has completely finished
  // speaking. Realtime still emits speech_started for that user turn; do not treat
  // it as a barge-in merely because we retain the last assistant item for possible
  // truncation. This also avoids clearing the finished AI transcript in the Aural UI.
  if (!session.responseActive && !playbackLikelyActive) {
    resetAudioTracking(session);
    return;
  }

  safeJsonSend(session.browser, { type: "interrupt" });
  if (playbackLikelyActive) {
    truncateUnheardAssistantAudio(session);
  } else {
    resetAudioTracking(session);
  }
}

function cancelActiveResponse(session: RelaySession): void {
  if (!session.responseActive) return;
  sendUpstream(session, { type: "response.cancel" });
  session.responseActive = false;
}

function transitionQuestion(
  session: RelaySession,
  targetIndex: number,
  options: { auto: boolean; direction?: "next" | "previous"; callId?: string; reason?: string },
): void {
  const ctx = session.context;
  if (!ctx) return;
  const total = ctx.questions.length;

  if (options.callId) {
    sendUpstream(session, {
      type: "conversation.item.create",
      item: {
        type: "function_call_output",
        call_id: options.callId,
        output: JSON.stringify({ ok: true, questionIndex: targetIndex }),
      },
    });
  }

  if (targetIndex >= total) {
    safeJsonSend(session.browser, { type: "interview_complete" });
    safeJsonSend(session.browser, {
      type: "question_change",
      questionIndex: total,
      totalQuestions: total,
      auto: options.auto,
    });
    addSystemContext(
      session,
      "All planned interview questions are complete. Give a short, professional closing only. Do not provide scores, coaching, or model answers yet.",
    );
    sendUpstream(
      session,
      responseCreate(
        "The interview is complete. Briefly thank the candidate and close the interview naturally. Do not give feedback or scores.",
      ),
    );
    return;
  }

  session.currentQuestionIndex = clampQuestionIndex(ctx, targetIndex);
  updateSessionInstructions(session);

  safeJsonSend(session.browser, {
    type: "question_change",
    questionIndex: session.currentQuestionIndex,
    totalQuestions: total,
    auto: options.auto,
  });

  const active = questionText(ctx, session.currentQuestionIndex);
  const transitionPrompt = options.auto
    ? `The interview state has advanced to question ${session.currentQuestionIndex + 1}. Give one brief natural acknowledgement of the prior answer, then ask this question: ${active}. Do not answer it yourself.`
    : `The candidate manually moved to question ${session.currentQuestionIndex + 1}. Ask this question now: ${active}. Keep the transition concise and do not answer it yourself.`;

  sendUpstream(session, responseCreate(transitionPrompt));
}

function handleFunctionCall(session: RelaySession, event: JsonRecord): void {
  if (!session.context) return;
  const name = typeof event.name === "string" ? event.name : "";
  if (name !== "signal_question_change") return;

  const callId = typeof event.call_id === "string" ? event.call_id : "";
  const raw = typeof event.arguments === "string" ? event.arguments : "{}";
  const state = responseStateForEvent(session, event);
  if (state) state.hadFunctionCall = true;

  try {
    const parsed = parseQuestionChangeArguments(raw, session.context.questions.length);
    transitionQuestion(session, parsed.questionIndex, {
      auto: true,
      direction: "next",
      callId,
      reason: parsed.reason,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Invalid question transition";
    log.warn(`Rejected question transition: ${message}`);
    if (callId) {
      sendUpstream(session, {
        type: "conversation.item.create",
        item: {
          type: "function_call_output",
          call_id: callId,
          output: JSON.stringify({ ok: false, error: message }),
        },
      });
      sendUpstream(
        session,
        responseCreate("The question transition failed. Continue the current question naturally."),
      );
    }
  }
}

function handleUpstreamEvent(session: RelaySession, raw: RawData): void {
  let event: JsonRecord;
  try {
    event = JSON.parse(raw.toString()) as JsonRecord;
  } catch {
    log.warn("Ignoring non-JSON Realtime event");
    return;
  }

  const type = typeof event.type === "string" ? event.type : "";

  switch (type) {
    case "session.created":
      break;

    case "session.updated":
      session.upstreamReady = true;
      if (!session.readySent) {
        session.readySent = true;
        safeJsonSend(session.browser, { type: "ready", sessionId: session.id });
        sendUpstream(
          session,
          responseCreate(
            "Begin the interview now. Introduce yourself in one short sentence, then ask the active question. Do not give any answer or hint.",
          ),
        );
      }
      break;

    case "input_audio_buffer.speech_started":
      // With WebSocket transport OpenAI cannot know what the end user has
      // actually heard. Stop local playback and truncate the assistant item so
      // unheard speech is removed from model context before the user continues.
      interruptAssistantPlayback(session);
      break;

    case "conversation.item.input_audio_transcription.delta": {
      const itemId = typeof event.item_id === "string" ? event.item_id : "unknown";
      const delta = typeof event.delta === "string" ? event.delta : "";
      if (!delta) break;
      const cumulative = `${session.asrByItem.get(itemId) || ""}${delta}`;
      session.asrByItem.set(itemId, cumulative);
      safeJsonSend(session.browser, {
        type: "asr",
        data: { results: [{ text: cumulative }] },
      });
      break;
    }

    case "conversation.item.input_audio_transcription.completed": {
      const itemId = typeof event.item_id === "string" ? event.item_id : "unknown";
      const transcript =
        typeof event.transcript === "string"
          ? event.transcript.trim()
          : (session.asrByItem.get(itemId) || "").trim();
      session.asrByItem.delete(itemId);
      if (transcript) {
        safeJsonSend(session.browser, { type: "asr_ended", text: transcript });
      }
      break;
    }

    case "conversation.item.input_audio_transcription.failed": {
      const itemId = typeof event.item_id === "string" ? event.item_id : "unknown";
      session.asrByItem.delete(itemId);
      safeJsonSend(session.browser, { type: "asr_ended", text: "" });
      break;
    }

    case "response.created": {
      const responseId = responseIdFromEvent(event) || randomUUID();
      session.currentResponseId = responseId;
      session.responses.set(responseId, {
        hadAssistantOutput: false,
        hadFunctionCall: false,
        transcript: "",
      });
      session.responseActive = true;
      safeJsonSend(session.browser, { type: "response_started" });
      break;
    }

    case "response.output_audio.delta": {
      const delta = typeof event.delta === "string" ? event.delta : "";
      if (!delta) break;
      const pcm = Buffer.from(delta, "base64");
      const state = responseStateForEvent(session, event);
      if (state) state.hadAssistantOutput = true;

      const itemId = typeof event.item_id === "string" ? event.item_id : null;
      const contentIndex =
        typeof event.content_index === "number" ? Math.trunc(event.content_index) : 0;
      if (itemId && itemId !== session.lastAudioItemId) {
        session.lastAudioItemId = itemId;
        session.lastAudioContentIndex = contentIndex;
        session.lastAudioFirstSentAt = Date.now();
        session.lastAudioBytesSent = 0;
      }
      if (itemId) session.lastAudioBytesSent += pcm.length;

      safeBinarySend(session.browser, pcm);
      break;
    }

    case "response.output_audio_transcript.delta":
    case "response.output_text.delta": {
      const delta = typeof event.delta === "string" ? event.delta : "";
      if (!delta) break;
      const state = responseStateForEvent(session, event);
      if (state) {
        state.hadAssistantOutput = true;
        state.transcript += delta;
      }
      safeJsonSend(session.browser, { type: "chat", data: { delta } });
      break;
    }

    case "response.output_audio_transcript.done": {
      const transcript = typeof event.transcript === "string" ? event.transcript : "";
      const state = responseStateForEvent(session, event);
      if (transcript && state && !state.transcript) {
        state.hadAssistantOutput = true;
        state.transcript = transcript;
        safeJsonSend(session.browser, { type: "chat", data: { delta: transcript } });
      }
      break;
    }

    case "response.output_text.done": {
      const text = typeof event.text === "string" ? event.text : "";
      const state = responseStateForEvent(session, event);
      if (text && state && !state.transcript) {
        state.hadAssistantOutput = true;
        state.transcript = text;
        safeJsonSend(session.browser, { type: "chat", data: { delta: text } });
      }
      break;
    }

    case "response.function_call_arguments.done":
      handleFunctionCall(session, event);
      break;

    case "response.done": {
      const responseId = responseIdFromEvent(event) || session.currentResponseId;
      const state = responseId ? session.responses.get(responseId) : null;
      if (responseId === session.currentResponseId) {
        session.currentResponseId = null;
        session.responseActive = false;
      }
      if (state?.hadAssistantOutput && !state.hadFunctionCall) {
        safeJsonSend(session.browser, { type: "tts_ended" });
      }
      if (responseId) session.responses.delete(responseId);
      break;
    }

    case "error": {
      const error = event.error as JsonRecord | undefined;
      const message =
        (error && typeof error.message === "string" && error.message) ||
        "OpenAI Realtime API error";
      log.error(`Realtime error: ${message}`);
      safeJsonSend(session.browser, { type: "error", message });
      break;
    }

    default:
      break;
  }
}

function connectOpenAI(session: RelaySession): void {
  const upstream = new WebSocket(OPENAI_REALTIME_WS_URL, {
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
    },
  });
  session.upstream = upstream;

  upstream.on("open", () => {
    log.info(`Connected session ${session.id} to ${OPENAI_REALTIME_MODEL}`);
    updateSessionInstructions(session);
  });

  upstream.on("message", (raw) => handleUpstreamEvent(session, raw));

  upstream.on("error", (error) => {
    log.error(`OpenAI upstream error for ${session.id}: ${error.message}`);
    safeJsonSend(session.browser, {
      type: "error",
      message: `OpenAI Realtime connection error: ${error.message}`,
    });
  });

  upstream.on("close", (code, reason) => {
    log.warn(`OpenAI upstream closed for ${session.id}: ${code} ${reason.toString()}`);
    if (!session.closing) {
      safeJsonSend(session.browser, { type: "disconnected" });
      try {
        session.browser.close(1011, "OpenAI Realtime disconnected");
      } catch {
        // ignore close race
      }
    }
  });
}

function handleBrowserMessage(session: RelaySession, raw: RawData): void {
  let message: JsonRecord;
  try {
    message = JSON.parse(raw.toString()) as JsonRecord;
  } catch {
    safeJsonSend(session.browser, { type: "error", message: "Invalid JSON message" });
    return;
  }

  const type = typeof message.type === "string" ? message.type : "";

  if (type === "init") {
    if (session.context) return;
    const context = message.context as InterviewContext | undefined;
    if (!context || !Array.isArray(context.questions)) {
      safeJsonSend(session.browser, { type: "error", message: "Missing interview context" });
      return;
    }
    session.context = context;
    session.currentQuestionIndex = clampQuestionIndex(
      context,
      typeof context.startQuestionIndex === "number" ? context.startQuestionIndex : 0,
    );
    connectOpenAI(session);
    return;
  }

  if (!session.context || !session.upstream) {
    safeJsonSend(session.browser, { type: "error", message: "Voice session is not initialized" });
    return;
  }

  switch (type) {
    case "audio": {
      if (!session.upstreamReady) return;
      const hex = typeof message.data === "string" ? message.data : "";
      if (!hex) return;
      try {
        sendUpstream(session, {
          type: "input_audio_buffer.append",
          audio: hex16kPcmTo24kBase64(hex),
        });
      } catch (error) {
        log.warn(error instanceof Error ? error.message : "Invalid audio payload");
      }
      break;
    }

    case "text_input": {
      const content = typeof message.content === "string" ? message.content.trim() : "";
      if (!content) return;
      interruptAssistantPlayback(session);
      cancelActiveResponse(session);
      addUserText(session, content);
      sendUpstream(session, responseCreate());
      break;
    }

    case "next_question": {
      const total = session.context.questions.length;
      const target = Math.min(total, session.currentQuestionIndex + 1);
      safeJsonSend(session.browser, { type: "transitioning", direction: "next", auto: false });
      interruptAssistantPlayback(session);
      cancelActiveResponse(session);
      transitionQuestion(session, target, { auto: false, direction: "next" });
      break;
    }

    case "prev_question": {
      const target = Math.max(0, session.currentQuestionIndex - 1);
      safeJsonSend(session.browser, { type: "transitioning", direction: "previous", auto: false });
      interruptAssistantPlayback(session);
      cancelActiveResponse(session);
      transitionQuestion(session, target, { auto: false, direction: "previous" });
      break;
    }

    case "code_update": {
      const content = typeof message.content === "string" ? message.content : "";
      const language = typeof message.language === "string" ? message.language : "text";
      if (!content) return;
      addSystemContext(
        session,
        `Silent code editor snapshot (${language}). Treat as evidence for the active question; do not speak solely because this update arrived.\n\n${content.slice(0, 16000)}`,
      );
      break;
    }

    case "whiteboard_update": {
      const imageDataUrl = typeof message.imageDataUrl === "string" ? message.imageDataUrl : "";
      if (!imageDataUrl.startsWith("data:image/")) return;
      sendUpstream(session, {
        type: "conversation.item.create",
        item: {
          type: "message",
          role: "user",
          content: [
            {
              type: "input_text",
              text: "Silent whiteboard snapshot for the active interview question. Do not respond unless the candidate asks you to review it.",
            },
            { type: "input_image", image_url: imageDataUrl },
          ],
        },
      });
      break;
    }

    default:
      break;
  }
}

const wss = new WebSocketServer({ port: RELAY_PORT });

wss.on("connection", (browser) => {
  const session: RelaySession = {
    id: randomUUID(),
    browser,
    upstream: null,
    context: null,
    currentQuestionIndex: 0,
    readySent: false,
    upstreamReady: false,
    responseActive: false,
    currentResponseId: null,
    responses: new Map(),
    closing: false,
    asrByItem: new Map(),
    lastAudioItemId: null,
    lastAudioContentIndex: 0,
    lastAudioFirstSentAt: null,
    lastAudioBytesSent: 0,
    keepAliveTimer: null,
  };

  log.info(`Browser connected: ${session.id}`);

  browser.on("message", (raw) => handleBrowserMessage(session, raw));

  browser.on("error", (error) => {
    log.warn(`Browser websocket error ${session.id}: ${error.message}`);
  });

  browser.on("close", () => {
    session.closing = true;
    if (session.keepAliveTimer) clearInterval(session.keepAliveTimer);
    if (session.upstream && session.upstream.readyState < WebSocket.CLOSING) {
      session.upstream.close(1000, "Browser disconnected");
    }
    log.info(`Browser disconnected: ${session.id}`);
  });

  session.keepAliveTimer = setInterval(() => {
    if (browser.readyState === WebSocket.OPEN) browser.ping();
    if (session.upstream?.readyState === WebSocket.OPEN) session.upstream.ping();
  }, 20_000);
});

wss.on("listening", () => {
  log.info(`OpenAI Realtime direct relay listening on ws://localhost:${RELAY_PORT}`);
  log.info(
    `model=${OPENAI_REALTIME_MODEL} voice=${OPENAI_REALTIME_VOICE} transcription=${OPENAI_REALTIME_TRANSCRIPTION_MODEL} vad=${OPENAI_REALTIME_VAD}`,
  );
});

wss.on("error", (error) => {
  log.error(`Relay server error: ${error.message}`);
});

function shutdown(signal: string): void {
  log.info(`Received ${signal}; shutting down relay`);
  wss.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2_000).unref();
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
