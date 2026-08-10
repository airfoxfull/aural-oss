import { createLogger } from "@/lib/logger";
import { createClient } from "@/lib/supabase/server";
import { NextResponse } from "next/server";

const log = createLogger("api/practice/live-session");

type LiveSessionRequest = {
  interviewId?: string;
};

/**
 * Create a private, authenticated mock-interview session for the interview owner.
 *
 * Unlike the public/preview interview flow, this endpoint does NOT publish the
 * interview and does not require a public slug. That keeps resume/JD-backed
 * self-practice private by default.
 */
export async function POST(req: Request) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let payload: LiveSessionRequest;
  try {
    payload = (await req.json()) as LiveSessionRequest;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const interviewId = payload.interviewId?.trim();
  if (!interviewId) {
    return NextResponse.json({ error: "interviewId is required" }, { status: 400 });
  }

  const { data: interview, error: interviewError } = await supabase
    .from("interviews")
    .select("id, userId, title, questions(id, order)")
    .eq("id", interviewId)
    .single();

  if (interviewError || !interview) {
    return NextResponse.json({ error: "Interview not found" }, { status: 404 });
  }

  // Self-practice intentionally has a stricter boundary than the normal org
  // interview editor: only the creator can launch a private live mock session.
  if (interview.userId !== user.id) {
    return NextResponse.json(
      { error: "Only the interview owner can start private live practice" },
      { status: 403 },
    );
  }

  const questions = [...(interview.questions ?? [])].sort(
    (a, b) => (a.order ?? 0) - (b.order ?? 0),
  );
  if (questions.length === 0) {
    return NextResponse.json(
      { error: "Add at least one interview question before starting live practice" },
      { status: 400 },
    );
  }

  const { data: profile } = await supabase
    .from("profiles")
    .select("name, email")
    .eq("id", user.id)
    .single();

  const { data: sessionJson, error: sessionError } = await supabase.rpc(
    "create_interview_session",
    {
      p_interview_id: interview.id,
      p_participant_name: profile?.name ?? "Practice User",
      p_participant_email: profile?.email ?? user.email ?? null,
      p_mode_used: "VOICE",
      p_current_question_id: questions[0]?.id ?? null,
    },
  );

  if (sessionError) {
    log.error("RPC error creating private live practice session:", sessionError);
    return NextResponse.json({ error: sessionError.message }, { status: 500 });
  }

  const session = sessionJson as { id?: string } | null;
  if (!session?.id) {
    log.error("create_interview_session returned no session id");
    return NextResponse.json(
      { error: "Could not create live practice session" },
      { status: 500 },
    );
  }

  return NextResponse.json({
    sessionId: session.id,
    interviewId: interview.id,
  });
}
