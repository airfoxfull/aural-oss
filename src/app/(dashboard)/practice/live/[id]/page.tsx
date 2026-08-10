"use client";

/* eslint-disable @typescript-eslint/no-explicit-any */

import { PreparingScreen } from "@/components/session/preparing-screen";
import type { InterviewContext } from "@/hooks/use-voice";
import { trpc } from "@/lib/trpc/client";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { CheckCircle2, RotateCcw } from "lucide-react";
import dynamic from "next/dynamic";
import Link from "next/link";
import { useParams, useSearchParams } from "next/navigation";
import { useMemo, useState } from "react";

const VoiceInterface = dynamic(
  () => import("@/components/session/voice-interface").then((m) => m.VoiceInterface),
  { ssr: false, loading: () => <PreparingScreen /> },
);

export default function PrivateLivePracticePage() {
  const params = useParams();
  const searchParams = useSearchParams();
  const interviewId = params.id as string;
  const sessionId = searchParams.get("sid");
  const [completed, setCompleted] = useState(false);

  const interview = trpc.interview.getById.useQuery(
    { id: interviewId },
    { retry: false },
  );
  const session = trpc.session.getById.useQuery(
    { id: sessionId! },
    { enabled: !!sessionId, retry: false },
  );

  const questionIndex = useMemo(() => {
    if (!interview.data || !session.data?.currentQuestionId) return 0;
    const index = interview.data.questions.findIndex(
      (question: any) => question.id === session.data?.currentQuestionId,
    );
    return index >= 0 ? index : 0;
  }, [interview.data, session.data?.currentQuestionId]);

  if (!sessionId) {
    return (
      <Card>
        <CardContent className="flex min-h-[420px] flex-col items-center justify-center gap-3 text-center">
          <p className="font-medium">Live practice session is missing.</p>
          <p className="text-sm text-muted-foreground">
            Start a new live mock interview from the practice page.
          </p>
          <Button asChild>
            <Link href={`/practice/${interviewId}`}>Back to practice</Link>
          </Button>
        </CardContent>
      </Card>
    );
  }

  if (interview.isLoading || session.isLoading) {
    return (
      <PreparingScreen
        title="Starting live mock interview..."
        description="Loading your resume, job context, and interview plan."
      />
    );
  }

  if (interview.isError || !interview.data || session.isError || !session.data) {
    return (
      <Card>
        <CardContent className="flex min-h-[420px] flex-col items-center justify-center gap-3 text-center">
          <p className="font-medium">Could not load this live practice session.</p>
          <p className="text-sm text-muted-foreground">
            The session may have expired or you may no longer have access to this interview.
          </p>
          <Button asChild>
            <Link href={`/practice/${interviewId}`}>Back to practice</Link>
          </Button>
        </CardContent>
      </Card>
    );
  }

  if (session.data.interviewId !== interviewId) {
    return (
      <Card>
        <CardContent className="flex min-h-[420px] flex-col items-center justify-center gap-3 text-center">
          <p className="font-medium">Session does not belong to this interview.</p>
          <Button asChild>
            <Link href={`/practice/${interviewId}`}>Back to practice</Link>
          </Button>
        </CardContent>
      </Card>
    );
  }

  if (completed || session.data.status === "COMPLETED") {
    return (
      <div className="flex min-h-[70vh] items-center justify-center p-4">
        <Card className="w-full max-w-lg">
          <CardContent className="py-12 text-center">
            <CheckCircle2 className="mx-auto h-14 w-14 text-primary" />
            <h1 className="mt-4 text-2xl font-semibold">Mock interview completed</h1>
            <p className="mt-2 text-sm text-muted-foreground">
              Your transcript was saved and Aural can generate the normal session analysis from this interview.
            </p>
            <div className="mt-6 flex flex-col justify-center gap-2 sm:flex-row">
              <Button asChild>
                <Link href={`/practice/${interviewId}`}>Review and practice</Link>
              </Button>
              <Button variant="outline" asChild>
                <Link href={`/practice/${interviewId}`}>
                  <RotateCcw className="mr-2 h-4 w-4" />
                  Start another round
                </Link>
              </Button>
            </div>
          </CardContent>
        </Card>
      </div>
    );
  }

  const context: InterviewContext & {
    jobDescription?: string | null;
    candidateProfile?: string | null;
  } = {
    title: interview.data.title,
    objective: interview.data.objective,
    jobDescription: interview.data.jobDescription,
    candidateProfile: interview.data.resumeText,
    aiName: interview.data.aiName ?? "AI Interviewer",
    aiTone: interview.data.aiTone,
    language: interview.data.language,
    followUpDepth: interview.data.followUpDepth,
    startQuestionIndex: questionIndex,
    questions: interview.data.questions.map((question: any) => ({
      text: question.text,
      type: question.type,
      description: question.description,
      options: question.options,
      starterCode: question.starterCode as { language: string; code: string } | null,
      order: question.order,
    })),
  };

  return (
    <VoiceInterface
      sessionId={sessionId}
      interviewId={interview.data.id}
      interviewTitle={interview.data.title}
      aiName={interview.data.aiName ?? "AI Interviewer"}
      questionCount={interview.data.questions.length}
      interviewContext={context}
      durationMinutes={interview.data.timeLimitMinutes ?? undefined}
      chatEnabled={!!interview.data.chatEnabled}
      onComplete={() => setCompleted(true)}
      videoMode={false}
    />
  );
}
