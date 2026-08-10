# OpenAI Realtime Interview Mode

This fork uses the official OpenAI Realtime API as the primary live interview engine while keeping Aural's existing browser protocol, session UI, question state, transcript persistence, and downstream reporting intact.

## End-to-end product flow

The self-service mock interview path is now:

```text
New Interview
  │
  ├─ upload resume PDF
  ├─ upload/paste JD
  └─ describe target interview
          │
          ▼
AI Generator
  ├─ generates questions / assessment criteria
  └─ uses resume + JD during generation
          │
          ▼
Accept & Create
  ├─ persists interview + questions
  ├─ persists extracted resume/JD via prep.updateContext
  └─ redirects to Prep
          │
          ▼
Prep
  ├─ existing focused per-question coaching
  └─ Start live mock interview
          │
          ▼
Private owner-only live session
  ├─ no publish required
  ├─ no public slug required
  └─ /practice/live/{interviewId}?sid=...
          │
          ▼
GPT-Realtime-2.1 live interviewer
          │
          ▼
Aural transcript/session persistence
          │
          ▼
Interview report + return to weak-area practice
```

The live-practice session is created by `POST /api/practice/live-session`. It is authenticated and intentionally owner-only. This avoids publishing an interview merely to practice against it, which is especially important when the interview contains a personal resume and JD context.

## Realtime architecture

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

For a cost-sensitive deployment, set `OPENAI_REALTIME_MODEL=gpt-realtime-2.1-mini` without changing application code. The model ID is intentionally configurable so the relay can follow future Realtime model updates without another transport rewrite.

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

## Resume/JD persistence

Aural's AI Generator already extracted resume/JD text and used it while generating the interview. This fork also persists those extracted source texts after `Accept & Create` by calling the existing `prep.updateContext` mutation.

That means the user does not need to upload the same documents again before live practice. The same source context is available to:

- question generation;
- focused Prep coaching;
- the live Realtime interviewer;
- downstream interview review/reporting context.

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

When candidate speech starts while assistant speech is still active, the relay:

1. tells the Aural browser to stop queued assistant playback immediately;
2. tracks the current assistant audio item and generated PCM duration;
3. estimates the playback point with a small jitter-buffer guard;
4. sends `conversation.item.truncate` so unheard assistant audio is removed from the Realtime conversation state.

This prevents a common failure mode where the model assumes the candidate heard a sentence that was actually interrupted.

The relay also distinguishes a true barge-in from a normal next turn. If the Realtime response has finished and the estimated browser playback tail has elapsed, the candidate beginning to speak does **not** emit an `interrupt` event or clear the completed interviewer transcript.

The current relay uses a server-side playback estimate because Aural's existing browser protocol does not expose an exact playback cursor. A later transport refinement can report the browser's true playback position for sample-accurate truncation, but the current implementation is intentionally conservative and keeps the existing UI protocol unchanged.

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

## Private live practice and security

`OPENAI_API_KEY` is read only by the relay server. Never place it in a `NEXT_PUBLIC_*` variable or ship it to browser/mobile code.

For self-practice, the new live-session API:

- requires an authenticated user;
- verifies the current user is the interview creator;
- requires at least one interview question;
- creates the session through Aural's existing `create_interview_session` RPC;
- does not require `publicSlug` or `isActive`;
- does not publish the interview.

For an internet deployment, terminate TLS at the reverse proxy and expose the browser-facing relay as `wss://...`; keep the OpenAI key in the server secret store.

Note: Aural's existing public interview/session data routes currently return broad interview records. This fork avoids those public routes for the new private self-practice path, but it does not redesign every legacy public DTO in this PR. A production privacy hardening pass should still narrow public interview DTOs if public interviews can contain sensitive candidate data.

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

## Verification boundary

The code path can be reviewed without credentials, but a real end-to-end voice smoke test requires a developer-controlled `OPENAI_API_KEY` in `.env.local`. Do not commit API keys to the repository or paste them into issue/PR comments.

Before production deployment, run:

```bash
npm ci
npm run lint
npx tsc --noEmit
npm run test:web
npm run build
```

Then run the full self-service path:

1. create a new interview;
2. upload a resume and JD;
3. generate and accept the interview;
4. confirm Prep opens with the saved context;
5. start private live mock interview;
6. test normal turns and genuine candidate barge-in;
7. test manual next/previous question;
8. test optional text input, code update, and whiteboard update;
9. complete the interview;
10. open the specific session report and return to weak-area practice.

## Post-interview evaluation

Realtime handles the low-latency interviewer. Post-interview scoring remains a separate model pass over the saved transcript plus resume/JD and interview evidence. Keeping these paths separate lets the product optimize live latency and report quality independently.
