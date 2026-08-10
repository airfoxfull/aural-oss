import assert from "node:assert/strict";
import test from "node:test";
import {
  buildInterviewInstructions,
  buildRealtimeSessionUpdate,
  hex16kPcmTo24kBase64,
  parseQuestionChangeArguments,
  resample16To24,
  type InterviewContext,
} from "../server/openai-realtime-direct-helpers";

const context: InterviewContext = {
  title: "AI Infra 技术面",
  objective: "验证候选人的 GPU 集群、RDMA 与分布式训练能力",
  aiName: "Alex",
  aiTone: "严格但专业",
  language: "zh",
  followUpDepth: "DEEP",
  questions: [
    {
      text: "你为什么在这个项目里引入 RDMA？",
      type: "TEXT",
      order: 0,
    },
    {
      text: "如果 GPU 利用率只有 50%，你会怎么定位？",
      type: "TEXT",
      order: 1,
    },
  ],
};

test("resample16To24 expands 16k PCM by 1.5x", () => {
  const input = Buffer.alloc(160 * 2);
  for (let i = 0; i < 160; i += 1) input.writeInt16LE(i * 10, i * 2);
  const output = resample16To24(input);
  assert.equal(output.length, 240 * 2);
});

test("hex16kPcmTo24kBase64 validates and converts audio", () => {
  const pcm = Buffer.alloc(16 * 2, 1);
  const encoded = hex16kPcmTo24kBase64(pcm.toString("hex"));
  assert.ok(Buffer.from(encoded, "base64").length > pcm.length);
  assert.throws(() => hex16kPcmTo24kBase64("xyz"), /Invalid hex PCM/);
});

test("interview instructions are evidence-driven and question-scoped", () => {
  const instructions = buildInterviewInstructions(context, 0);
  assert.match(instructions, /真实能力/);
  assert.match(instructions, /你本人做了什么/);
  assert.match(instructions, /signal_question_change/);
  assert.match(instructions, /你为什么在这个项目里引入 RDMA/);
});

test("session update uses GA Realtime audio schema and semantic VAD", () => {
  const event = buildRealtimeSessionUpdate(context, 0, {
    voice: "marin",
    transcriptionModel: "gpt-4o-mini-transcribe",
    vadMode: "semantic_vad",
  }) as {
    type: string;
    session: {
      output_modalities: string[];
      audio: {
        input: {
          format: { type: string; rate: number };
          transcription: { model: string; language: string };
          turn_detection: { type: string; interrupt_response: boolean };
        };
        output: { voice: string; format: { type: string; rate: number } };
      };
      tools: Array<{ name: string }>;
    };
  };

  assert.equal(event.type, "session.update");
  assert.deepEqual(event.session.output_modalities, ["audio"]);
  assert.deepEqual(event.session.audio.input.format, { type: "audio/pcm", rate: 24000 });
  assert.equal(event.session.audio.input.transcription.model, "gpt-4o-mini-transcribe");
  assert.equal(event.session.audio.input.transcription.language, "zh");
  assert.equal(event.session.audio.input.turn_detection.type, "semantic_vad");
  assert.equal(event.session.audio.input.turn_detection.interrupt_response, true);
  assert.equal(event.session.audio.output.voice, "marin");
  assert.deepEqual(event.session.audio.output.format, { type: "audio/pcm", rate: 24000 });
  assert.equal(event.session.tools[0].name, "signal_question_change");
});

test("question transition parser accepts completion sentinel", () => {
  assert.deepEqual(
    parseQuestionChangeArguments('{"questionIndex":2,"reason":"done"}', 2),
    { questionIndex: 2, reason: "done" },
  );
  assert.throws(
    () => parseQuestionChangeArguments('{"questionIndex":3}', 2),
    /outside 0\.\.2/,
  );
});
