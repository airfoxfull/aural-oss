# OpenAI Realtime Interview Mode

This fork uses the official OpenAI Realtime API as the primary voice-interview engine while keeping Aural's existing browser protocol and UI intact.

## Architecture

```text
Aural browser
  ├─ microphone: 16 kHz PCM, hex over WebSocket
  ├─ interview context / question state
  └─ code + whiteboard context
          │
          ▼
server/openai-realtime-direct-relay.ts
  ├─ keeps OPENAI_API_KEY server-side
  ├─ resamples 16 kHz → 24 kHz PCM
  ├─ maps Aural relay events ↔ OpenAI Realtime events
  ├─ semantic/server VAD + barge-in
  ├─ input transcription
  └─ question-state Function Calling
          │
          ▼
OpenAI Realtime API (`gpt-realtime` by default)
          │
          ▼
24 kHz PCM audio + transcript + tool calls
```

## Local setup

1. Copy `.env.example` to `.env.local` and configure Supabase/Aural as usual.
2. Add an OpenAI API key:

```bash
OPENAI_API_KEY=sk-...
```

3. Recommended voice settings:

```bash
OPENAI_REALTIME_MODEL=gpt-realtime
OPENAI_REALTIME_VOICE=marin
OPENAI_REALTIME_TRANSCRIPTION_MODEL=gpt-4o-mini-transcribe
OPENAI_REALTIME_VAD=semantic_vad
NEXT_PUBLIC_VOICE_RELAY_PRIMARY=openai
NEXT_PUBLIC_OPENAI_VOICE_RELAY_URL=ws://localhost:8767
```

4. Start the web app and the Realtime relay in separate terminals:

```bash
npm run dev
npm run dev:openai-voice
```

The legacy Azure relay remains available for comparison:

```bash
npm run dev:openai-voice:legacy-azure
```

## Interview behavior

The Realtime system instructions are intentionally evidence-driven instead of acting like a fixed quiz reader. The interviewer should:

- ask one question at a time;
- probe individual ownership, why a decision was made, validation, metrics, failures, alternatives, and trade-offs;
- avoid giving model answers or scores during the interview;
- stay on vague answers and move on early when evidence is sufficient;
- use `signal_question_change` to keep the voice agent and Aural UI on the same question index;
- treat code and whiteboard snapshots as silent context unless the candidate asks the interviewer to inspect them.

## Browser protocol compatibility

No browser rewrite is required. The new relay accepts the existing Aural messages:

- `init`
- `audio`
- `text_input`
- `next_question`
- `prev_question`
- `code_update`
- `whiteboard_update`

It returns the event types already handled by `src/hooks/use-voice.ts`, including:

- `ready`
- `interrupt`
- `asr`
- `asr_ended`
- `response_started`
- `chat`
- binary 24 kHz PCM audio
- `tts_ended`
- `transitioning`
- `question_change`
- `interview_complete`
- `error` / `disconnected`

## Security

`OPENAI_API_KEY` is read only by the relay server. Do not place it in a `NEXT_PUBLIC_*` variable or ship it to browser/mobile code.

For an internet deployment, terminate TLS at the reverse proxy and expose the browser-facing relay as `wss://...`; keep the OpenAI key in the server secret store.

## Tuning

### More natural turn-taking

Use:

```bash
OPENAI_REALTIME_VAD=semantic_vad
```

### More deterministic pause timing

Use:

```bash
OPENAI_REALTIME_VAD=server_vad
```

The server-VAD fallback currently uses a 650 ms silence threshold in `buildRealtimeSessionUpdate`.

### Voice

`marin` is the default in this fork. Set `OPENAI_REALTIME_VOICE` to another Realtime built-in voice if desired.

## Tests

The direct relay's pure logic is covered by:

```bash
node --import tsx --test tests/openai-realtime-direct.test.ts
```

The test is also included in `npm run test:web`.

## Next product layer

The transport is intentionally separated from post-interview evaluation. Realtime handles the live interviewer. Scoring/report generation should continue as a separate model pass over the saved transcript, resume/JD context, and interview evidence so live latency and report quality can be optimized independently.
