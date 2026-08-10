export interface InterviewQuestion {
  text: string;
  type: string;
  description?: string | null;
  options?: { options: string[]; allowMultiple?: boolean } | null;
  starterCode?: { language: string; code: string } | null;
  order: number;
}

export interface InterviewContext {
  title: string;
  objective?: string | null;
  aiName: string;
  aiTone: string;
  language: string;
  followUpDepth: string;
  startQuestionIndex?: number;
  questions: InterviewQuestion[];
}

export function isChineseInterview(ctx: InterviewContext): boolean {
  return ctx.language === "zh" || ctx.language.toLowerCase().includes("chinese");
}

export function sortedQuestions(ctx: InterviewContext): InterviewQuestion[] {
  return [...ctx.questions].sort((a, b) => a.order - b.order);
}

export function clampQuestionIndex(ctx: InterviewContext, index: number): number {
  const total = ctx.questions.length;
  if (total === 0) return 0;
  return Math.max(0, Math.min(total - 1, Math.trunc(index)));
}

export function followUpLimit(depth: string): number {
  switch (depth) {
    case "LIGHT":
      return 1;
    case "MODERATE":
      return 3;
    case "DEEP":
      return 5;
    default:
      return 2;
  }
}

export function resample16To24(input: Buffer): Buffer {
  if (input.length < 2) return Buffer.alloc(0);
  const inputSamples = Math.floor(input.length / 2);
  const outputSamples = Math.floor((inputSamples * 3) / 2);
  const output = Buffer.alloc(outputSamples * 2);
  const ratio = inputSamples / outputSamples;

  for (let i = 0; i < outputSamples; i += 1) {
    const source = i * ratio;
    const left = Math.floor(source);
    const right = Math.min(left + 1, inputSamples - 1);
    const fraction = source - left;
    const a = input.readInt16LE(left * 2);
    const b = input.readInt16LE(right * 2);
    const sample = Math.round(a + (b - a) * fraction);
    output.writeInt16LE(Math.max(-32768, Math.min(32767, sample)), i * 2);
  }

  return output;
}

export function hex16kPcmTo24kBase64(hex: string): string {
  const normalized = hex.trim();
  if (!normalized || normalized.length % 2 !== 0 || !/^[0-9a-f]+$/i.test(normalized)) {
    throw new Error("Invalid hex PCM audio payload");
  }
  return resample16To24(Buffer.from(normalized, "hex")).toString("base64");
}

function questionDetails(question: InterviewQuestion, index: number): string {
  const parts = [`${index + 1}. [${question.type}] ${question.text}`];
  if (question.description) parts.push(`   Context: ${question.description}`);
  if (question.options?.options?.length) {
    parts.push(`   Options: ${question.options.options.join(" | ")}`);
  }
  if (question.type === "CODING") {
    parts.push("   Candidate has a code editor. Ask them to explain decisions and complexity; code snapshots may arrive as silent context updates.");
  }
  if (question.type === "WHITEBOARD") {
    parts.push("   Candidate has a whiteboard. Image snapshots may arrive as silent context updates.");
  }
  return parts.join("\n");
}

export function buildInterviewInstructions(
  ctx: InterviewContext,
  currentQuestionIndex: number,
): string {
  const questions = sortedQuestions(ctx);
  const total = questions.length;
  const current = total > 0 ? clampQuestionIndex(ctx, currentQuestionIndex) : 0;
  const active = questions[current];
  const maxFollowUps = followUpLimit(ctx.followUpDepth);
  const isZh = isChineseInterview(ctx);
  const list = questions.map(questionDetails).join("\n");

  if (isZh) {
    return `你是“${ctx.aiName}”，一位${ctx.aiTone}的真人感 AI 面试官。你的任务是验证候选人的真实能力，而不是帮助候选人作答。

## 面试目标
- 面试主题：${ctx.title}
${ctx.objective ? `- 岗位/目标：${ctx.objective}` : ""}
- 当前题：${total ? `${current + 1}/${total}` : "无预设题"}
- 当前题目：${active?.text ?? "根据岗位目标进行开放式面试"}
- 每题最多追问：${maxFollowUps} 次；若已经获得足够证据，可以更早结束追问。

## 关键原则
1. 一次只问一个问题，语音回复尽量 1-3 句话，像真实面试官，不要念长篇说明。
2. 先听完整回答，再追问。优先追问“为什么、你本人做了什么、怎么验证、数据指标、失败/故障、替代方案、trade-off”。
3. 对简历式陈述保持中性怀疑：如果候选人只说“我们做了”，继续确认其个人职责、决策依据和可验证细节。
4. 不要在面试过程中直接给标准答案、打分或教学；可以要求候选人澄清或重述。
5. 候选人答得模糊时不要急着换题；答得充分时不要为了凑次数机械追问。
6. 当前题讨论充分后，必须调用 signal_question_change，传入下一题的 0-based questionIndex。工具成功后再问下一题。
7. 不要自行跳过多题，不要在调用工具前把下一题说出来。
8. 候选人要求“下一题/跳过”时可以立即调用 signal_question_change；要求“上一题”由外部控制器处理。
9. 如果收到代码或白板快照，把它当作静默上下文；除非候选人要求你查看，否则不要因为收到更新而主动插话。
10. 语速自然，允许简短停顿和口语化承接，但避免过度热情、重复表扬或模板化措辞。

## 预设问题/能力检查点
${list || "无固定题单；围绕岗位目标动态面试。"}

## 当前执行状态
现在只围绕第 ${current + 1} 题进行面试：${active?.text ?? "开放式问题"}。
需要换题时调用工具；不要自己修改题号。`;
  }

  return `You are ${ctx.aiName}, a ${ctx.aiTone} interviewer. Your job is to verify the candidate's real capability, not to coach them during the interview.

## Interview target
- Topic: ${ctx.title}
${ctx.objective ? `- Role/objective: ${ctx.objective}` : ""}
- Active question: ${total ? `${current + 1}/${total}` : "open-ended"}
- Question: ${active?.text ?? "Run an open-ended role-relevant interview"}
- Follow-ups: up to ${maxFollowUps}, but stop earlier when evidence is sufficient.

## Rules
1. Ask one question at a time. Keep spoken turns concise (usually 1-3 sentences).
2. Probe for evidence: why, individual ownership, validation, metrics, incidents/failures, alternatives, and trade-offs.
3. Treat vague “we did X” claims neutrally; clarify the candidate's own work and decision-making.
4. Do not reveal model answers, scores, or coaching during the interview.
5. Do not mechanically exhaust the follow-up quota. Stay when evidence is weak; move on when evidence is strong.
6. When the active question is sufficiently covered, call signal_question_change with the next 0-based questionIndex. Ask the next question only after the tool succeeds.
7. Do not skip multiple questions unless the candidate explicitly asks to skip.
8. Code and whiteboard snapshots are silent context. Do not speak merely because an update arrives.
9. Sound like a real interviewer: natural acknowledgements, no repetitive praise, no lecture-style monologues.

## Question checkpoints
${list || "No fixed list. Interview dynamically around the role objective."}

## Current execution state
Stay on question ${current + 1}: ${active?.text ?? "open-ended role question"}. Use the tool to change question state.`;
}

export function buildRealtimeSessionUpdate(
  ctx: InterviewContext,
  currentQuestionIndex: number,
  options: {
    voice: string;
    transcriptionModel: string;
    vadMode: "semantic_vad" | "server_vad";
  },
): Record<string, unknown> {
  const language = isChineseInterview(ctx) ? "zh" : "en";
  const turnDetection =
    options.vadMode === "semantic_vad"
      ? {
          type: "semantic_vad",
          eagerness: "medium",
          create_response: true,
          interrupt_response: true,
        }
      : {
          type: "server_vad",
          threshold: 0.5,
          prefix_padding_ms: 300,
          silence_duration_ms: 650,
          create_response: true,
          interrupt_response: true,
        };

  return {
    type: "session.update",
    session: {
      type: "realtime",
      instructions: buildInterviewInstructions(ctx, currentQuestionIndex),
      output_modalities: ["audio"],
      audio: {
        input: {
          format: { type: "audio/pcm", rate: 24000 },
          noise_reduction: { type: "near_field" },
          transcription: {
            model: options.transcriptionModel,
            language,
            prompt: language === "zh" ? "技术面试、项目经历、工程术语、英文缩写" : "technical interview, project experience, engineering terminology",
          },
          turn_detection: turnDetection,
        },
        output: {
          format: { type: "audio/pcm", rate: 24000 },
          voice: options.voice,
          speed: 1,
        },
      },
      tools: [
        {
          type: "function",
          name: "signal_question_change",
          description: "Advance the interview UI/state to a specific question index after the current question is sufficiently covered.",
          parameters: {
            type: "object",
            properties: {
              questionIndex: {
                type: "integer",
                description: "0-based target question index. Use questions.length when all questions are complete.",
              },
              reason: {
                type: "string",
                description: "Short reason for moving on.",
              },
            },
            required: ["questionIndex"],
            additionalProperties: false,
          },
        },
      ],
      tool_choice: "auto",
      max_output_tokens: 1200,
    },
  };
}

export function parseQuestionChangeArguments(
  raw: string,
  totalQuestions: number,
): { questionIndex: number; reason?: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw || "{}");
  } catch {
    throw new Error("signal_question_change returned invalid JSON");
  }
  if (!parsed || typeof parsed !== "object") {
    throw new Error("signal_question_change arguments must be an object");
  }
  const value = parsed as { questionIndex?: unknown; reason?: unknown };
  if (typeof value.questionIndex !== "number" || !Number.isFinite(value.questionIndex)) {
    throw new Error("signal_question_change.questionIndex must be a number");
  }
  const questionIndex = Math.trunc(value.questionIndex);
  if (questionIndex < 0 || questionIndex > totalQuestions) {
    throw new Error(`questionIndex ${questionIndex} is outside 0..${totalQuestions}`);
  }
  return {
    questionIndex,
    reason: typeof value.reason === "string" ? value.reason : undefined,
  };
}
