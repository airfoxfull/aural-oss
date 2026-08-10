# OpenAI Realtime Interview Mode

This fork uses the official OpenAI Realtime API as the primary live interview engine while keeping Aural's existing browser protocol, session UI, question state, transcript persistence, and downstream reporting intact.

## Product architecture

```text
Resume + JD + interview configuration
              │
              ▼
Aural browser
  ├─ microphone: 16 kHz PCM, hex over WebSocket
  ├─ interview/question state
  ├─ resume + JD context
  └─ code + whiteboard context
              │
              ▼
server/openai-realtime-direct-relay.ts
  ├─ keeps OPENAI_API_KEY server-side
  ├─ resamples 16 kHz → 24 kHz PCM
  ├─ maps Aural relay events ↔ OpenAI Realtime events
  ├─ semantic/server VAD + barge-in
  ├─ truncates unheard assistant audio after interruption
  ├─ input transcription
  └─ question-state Function Calling
              │
              ▼
OpenAI Realtime API
  └─ gpt-realtime-2.1 by default
              │
              ▼
24 kHz PCM audio + transcript + tool calls
              │
              ▼
Aural transcript/session/report pipeline
```

For a cost-sensitive deployment, set `OPENAI_REALTIME_MODEL=gpt-realtime-2.1-mini` without changing application code.

## Local setup

1. Copy `.env.example` to `.env.local` and configure Supabase/Aural as usual.
2. Add an OpenAI API key:

```bash
OPENAI_API_KEY=sk-...
```

3. Recommended voice settings:

```bash
OPENAI_REALTIME_MODEL=gpt-realtime-2.1
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

The legacy Azure relay remains available for comparison/fallback:

```bash
npm run dev:openai-voice:legacy-azure
```

## Interview behavior

The live interviewer is evidence-driven rather than a fixed quiz reader. It is instructed to:

- ask one question at a time and keep spoken turns concise;
- use the JD and resume as silent evidence context rather than reading them aloud;
- prioritize resume claims most relevant to the target role;
- probe individual ownership, why a decision was made, validation, metrics, failures, alternatives, and trade-offs;
- treat vague "we did X" answers as a reason to ask for the candidate's own work and evidence;
- avoid giving model answers, coaching, or scores during the live interview;
- stay on vague answers and move on early once sufficient evidence has been gathered;
- use `signal_question_change` to keep the voice agent and Aural UI on the same question index;
- treat code and whiteboard snapshots as silent context unless the candidate asks the interviewer to inspect them.

Resume/JD text is bounded before it is inserted into Realtime instructions:

- JD: up to 12,000 characters;
- resume/profile: up to 16,000 characters.

This keeps long source documents from dominating the live context and cost.

## Interruption / barge-in

A voice interview needs more than merely stopping the speaker. With WebSocket Realtime, the client is responsible for keeping model context aligned with what the user actually heard.

When candidate speech starts, the relay now:

1. tells the Aural browser to stop queued assistant playback immediately;
2. tracks the current assistant audio item and generated PCM duration;
3. estimates the playback point with a small jitter-buffer guard;
4. sends `conversation.item.truncate` so unheard assistant audio is removed from the Realtime conversation state.

This prevents a common failure mode where the model assumes the candidate heard a sentence that was actually interrupted.

## Response isolation

Realtime may emit overlapping lifecycle events around tool calls and question transitions. The relay stores assistant-output/function-call state by `response_id` rather than a single global response flag, so a tool-triggered question transition does not accidentally inherit completion state from the previous response.

## Browser protocol compatibility

No browser rewrite is required. The relay accepts the existing Aural messages:

- `init`
- `audio`
- `text_input`
- `next_question`
- `prev_question`
- `code_update`
- `whiteboard_update`

It returns event types already handled by `src/hooks/use-voice.ts`, including:

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

`OPENAI_API_KEY` is read only by the relay server. Never place it in a `NEXT_PUBLIC_*` variable or ship it to browser/mobile code.

For an internet deployment, terminate TLS at the reverse proxy and expose the browser-facing relay as `wss://...`; keep the OpenAI key in the server secret store.

Note: Aural's existing public interview/session data routes currently return broad interview records. This fork does not redesign that data-access boundary in this PR; the Realtime transport protects the OpenAI credential, but a production privacy hardening pass should narrow public interview DTOs if resumes contain sensitive candidate data.

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

### Model cost

Highest-quality default:

```bash
OPENAI_REALTIME_MODEL=gpt-realtime-2.1
```

Lower-cost option:

```bash
OPENAI_REALTIME_MODEL=gpt-realtime-2.1-mini
```

### Voice

`marin` is the default in this fork. Set `OPENAI_REALTIME_VOICE` to another supported Realtime built-in voice if desired.

## Tests

The direct relay's pure logic is covered by:

```bash
node --import tsx --test tests/openai-realtime-direct.test.ts
```

The test is also included in `npm run test:web` and covers audio resampling, input validation, context clipping, resume/JD-aware prompt construction, Realtime session schema, semantic VAD, and question-transition parsing.

The repository CI also defines lint, TypeScript checking, web tests, functional tests, and a Next.js build. On a fresh fork, GitHub Actions may need to be enabled before those checks appear on the PR.

## Post-interview evaluation

Realtime handles the low-latency interviewer. Post-interview scoring should remain a separate model pass over the saved transcript plus resume/JD and interview evidence. Keeping these paths separate lets the product optimize live latency and report quality independently.
