import { useEffect, useRef, useState } from 'react'
import {
  createFileRoute,
  useNavigate,
  useSearch,
} from '@tanstack/react-router'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'

import type {
  RiskProfileCompleteResponse,
  RiskQuestionsResponse,
} from '@/lib/types'
import { apiFetch } from '@/lib/api'
import { requireMemWal } from '@/lib/requireAuth'
import { useAuth } from '@/hooks/useAuth'
import { Card } from '@/components/ui/Card'
import { EyebrowTag } from '@/components/ui/EyebrowTag'
import { GlowBorderButton } from '@/components/ui/GlowBorderButton'
import { Skeleton } from '@/components/ui/Skeleton'
import AppNav from '@/components/ui/AppNav'
import { Container } from '@/components/ui/Container'
import { cnm } from '@/utils/style'
import { splitPrompt } from '@/utils/markdown'

interface SetupSearch {
  next?: string
}

export const Route = createFileRoute('/setup')({
  validateSearch: (search): SetupSearch => ({
    next:
      typeof search.next === 'string' &&
      search.next.startsWith('/') &&
      !search.next.startsWith('//')
        ? search.next
        : undefined,
  }),
  beforeLoad: requireMemWal,
  component: SetupPage,
  head: () => ({
    meta: [
      { title: 'Risk profile setup · Lighthouse' },
      { name: 'robots', content: 'noindex' },
    ],
  }),
})

// ── sessionStorage persistence helpers ──────────────────────────────────

function storageKey(suiAddress: string, field: 'answers' | 'step'): string {
  return `lh.setup.${field}.${suiAddress}`
}

function loadAnswers(suiAddress: string): Array<string> {
  try {
    const raw = sessionStorage.getItem(storageKey(suiAddress, 'answers'))
    if (!raw) return []
    const parsed: unknown = JSON.parse(raw)
    if (Array.isArray(parsed) && parsed.every((v) => typeof v === 'string')) {
      return parsed
    }
  } catch {
    // ignore
  }
  return []
}

function loadStep(suiAddress: string): number {
  try {
    const raw = sessionStorage.getItem(storageKey(suiAddress, 'step'))
    if (!raw) return 0
    const n = parseInt(raw, 10)
    return Number.isFinite(n) && n >= 0 ? n : 0
  } catch {
    return 0
  }
}

function saveAnswers(suiAddress: string, answers: Array<string>): void {
  try {
    sessionStorage.setItem(
      storageKey(suiAddress, 'answers'),
      JSON.stringify(answers),
    )
  } catch {
    // storage quota — ignore
  }
}

function saveStep(suiAddress: string, step: number): void {
  try {
    sessionStorage.setItem(storageKey(suiAddress, 'step'), String(step))
  } catch {
    // ignore
  }
}

function clearStorage(suiAddress: string): void {
  try {
    sessionStorage.removeItem(storageKey(suiAddress, 'answers'))
    sessionStorage.removeItem(storageKey(suiAddress, 'step'))
  } catch {
    // ignore
  }
}

// ── Page ────────────────────────────────────────────────────────────────

function SetupPage() {
  const { profile } = useAuth()
  const navigate = useNavigate()
  const search = useSearch({ from: '/setup' })
  const destination = search.next ?? '/coach'

  // If the user already completed setup, send them on their way.
  useEffect(() => {
    if (profile?.riskProfileCompletedAt) {
      void navigate({ to: destination as never, replace: true })
    }
  }, [profile?.riskProfileCompletedAt, destination, navigate])

  if (!profile) return null

  return (
    <main className="bg-lh-bg text-lh-text min-h-screen">
      <AppNav />
      <section className="pt-24 pb-20">
        <Container>
          <div className="max-w-2xl mx-auto">
            <SetupWizard
              suiAddress={profile.suiAddress}
              destination={destination}
            />
          </div>
        </Container>
      </section>
    </main>
  )
}

// ── Wizard ───────────────────────────────────────────────────────────────

type Phase = 'loading' | 'quiz' | 'review' | 'success' | 'error'

function SetupWizard({
  suiAddress,
  destination,
}: {
  suiAddress: string
  destination: string
}) {
  const navigate = useNavigate()
  const qc = useQueryClient()
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  // Restore persisted state — run once on mount (suiAddress never changes here)
  const [step, setStepState] = useState<number>(() => loadStep(suiAddress))
  const [answers, setAnswersState] = useState<Array<string>>(() =>
    loadAnswers(suiAddress),
  )
  const [draft, setDraft] = useState<string>('')
  const [phase, setPhase] = useState<Phase>('loading')
  const [submitResult, setSubmitResult] =
    useState<RiskProfileCompleteResponse | null>(null)

  function setStep(n: number) {
    setStepState(n)
    saveStep(suiAddress, n)
  }

  function setAnswers(next: Array<string>) {
    setAnswersState(next)
    saveAnswers(suiAddress, next)
  }

  const { data: questionsData, isError: questionsError, refetch } = useQuery<RiskQuestionsResponse>({
    queryKey: ['onboarding', 'risk-questions'],
    queryFn: () =>
      apiFetch<RiskQuestionsResponse>('/onboarding/risk-questions'),
    staleTime: Infinity,
    gcTime: Infinity,
  })

  const questions = questionsData?.questions ?? []

  // Transition to quiz once we have questions
  useEffect(() => {
    if (questionsData && phase === 'loading') {
      setPhase('quiz')
    }
  }, [questionsData, phase])

  // Error state when questions fetch fails
  useEffect(() => {
    if (questionsError && phase === 'loading') {
      setPhase('error')
    }
  }, [questionsError, phase])

  // Focus textarea when step changes
  useEffect(() => {
    if (phase === 'quiz') {
      textareaRef.current?.focus()
    }
  }, [step, phase])

  // Pre-fill draft from saved answer when navigating back.
  // Intentionally omits `answers` from deps — we only want to sync
  // on step/phase transitions, not on every keystroke.
  const answersRef = useRef(answers)
  answersRef.current = answers
  useEffect(() => {
    if (phase === 'quiz') {
      setDraft(answersRef.current[step] ?? '')
    }
  }, [step, phase])

  const submitMutation = useMutation({
    mutationFn: (finalAnswers: Array<string>) =>
      apiFetch<RiskProfileCompleteResponse>(
        '/onboarding/risk-profile/complete',
        {
          method: 'POST',
          body: {
            answers: questions.map((q, i) => ({
              id: q.id,
              text: finalAnswers[i] ?? '',
            })),
          },
        },
      ),
    onSuccess: async (data) => {
      setSubmitResult(data)
      setPhase('success')
      clearStorage(suiAddress)
      await qc.invalidateQueries({ queryKey: ['auth', 'profile-me'] })
    },
    onError: () => {
      setPhase('error')
    },
  })

  function advance() {
    const trimmed = draft.trim()
    if (trimmed.length < 3) return
    const next = [...answers.slice(0, step), trimmed]
    setAnswers(next)
    if (step < questions.length - 1) {
      setStep(step + 1)
    } else {
      setPhase('review')
    }
  }

  function back() {
    if (step === 0) return
    const trimmed = draft.trim()
    if (trimmed.length >= 3) {
      setAnswers([...answers.slice(0, step), trimmed])
    }
    setStep(step - 1)
  }

  function goBack() {
    // From review → back to last question
    setPhase('quiz')
    setStep(questions.length - 1)
    setDraft(answers[questions.length - 1] ?? '')
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      advance()
    }
  }

  const canAdvance = draft.trim().length >= 3

  if (phase === 'loading') {
    return <SetupSkeleton />
  }

  if (phase === 'error') {
    return (
      <Card className="p-8">
        <EyebrowTag prefix="dot" className="mb-4">
          Setup
        </EyebrowTag>
        <h2 className="text-xl font-semibold mb-2">Could not load questions</h2>
        <p className="text-sm text-lh-text-dim mb-6">
          {submitMutation.error instanceof Error
            ? submitMutation.error.message
            : 'Failed to fetch the risk questionnaire. Check your connection and try again.'}
        </p>
        <button
          type="button"
          onClick={() => {
            setPhase('loading')
            void refetch()
          }}
          className={cnm(
            'rounded-full bg-lh-accent text-lh-bg font-semibold text-sm px-5 py-2.5',
            'hover:bg-lh-accent-warm transition-colors duration-150',
          )}
        >
          Retry
        </button>
      </Card>
    )
  }

  if (phase === 'success' && submitResult) {
    return (
      <SuccessScreen
        result={submitResult}
        onNavigate={() => navigate({ to: destination as never, replace: true })}
      />
    )
  }

  if (phase === 'review') {
    return (
      <ReviewScreen
        questions={questions}
        answers={answers}
        onBack={goBack}
        onSubmit={() => submitMutation.mutate(answers)}
        isPending={submitMutation.isPending}
      />
    )
  }

  // quiz phase — questions is non-empty when we reach here
  const currentQuestion = questions[step] ?? questions[0]
  const { headline, examples } = splitPrompt(currentQuestion.prompt)
  const completedCount = Math.min(step, answers.length)

  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <EyebrowTag prefix="dot" className="mb-3">
          Step 2 of 2
        </EyebrowTag>
        <h1 className="text-3xl font-bold tracking-[-0.03em] mb-2">
          Set up your risk profile
        </h1>
        <p className="text-lh-text-dim text-sm max-w-lg">
          Five quick questions so your coach can advise you properly. Your
          answers are stored in your encrypted MemWal — only you can recall
          them.
        </p>
      </div>

      {/* Progress */}
      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <span className="text-xs font-mono text-lh-text-mute">
            Question {step + 1} of {questions.length}
          </span>
          <span className="text-xs font-mono text-lh-text-mute">
            {Math.round(((completedCount) / questions.length) * 100)}%
          </span>
        </div>
        <div
          role="progressbar"
          aria-valuenow={step + 1}
          aria-valuemin={1}
          aria-valuemax={questions.length}
          aria-label={`Question ${step + 1} of ${questions.length}`}
          className="h-1 w-full rounded-full bg-lh-line overflow-hidden"
        >
          <div
            className="h-full bg-lh-accent rounded-full transition-all duration-300"
            style={{
              width: `${((completedCount) / questions.length) * 100}%`,
            }}
          />
        </div>
      </div>

      {/* Question card */}
      <Card className="p-6 md:p-8 space-y-5">
        <div>
          <label
            htmlFor="setup-answer"
            className="block text-base font-semibold leading-snug mb-1"
          >
            {headline}
          </label>
          {examples && (
            <p className="text-sm text-lh-text-mute leading-relaxed">
              {examples}
            </p>
          )}
        </div>

        <textarea
          id="setup-answer"
          ref={textareaRef}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={handleKeyDown}
          rows={4}
          placeholder="Type your answer…"
          aria-required="true"
          aria-label={headline}
          className={cnm(
            'w-full rounded-xl border border-lh-line bg-lh-bg/60',
            'px-4 py-3 text-sm leading-relaxed resize-none',
            'text-lh-text placeholder:text-lh-text-mute',
            'focus:outline-none focus:border-lh-accent/60 focus:ring-1 focus:ring-lh-accent/20',
            'transition-colors duration-150',
          )}
        />

        <div className="flex items-center justify-between gap-3">
          <button
            type="button"
            onClick={back}
            disabled={step === 0}
            className={cnm(
              'rounded-full border border-lh-line text-sm font-medium px-5 py-2',
              'text-lh-text-dim hover:text-lh-text transition-colors duration-150',
              'disabled:opacity-30 disabled:pointer-events-none',
            )}
          >
            Back
          </button>

          <div className="flex items-center gap-3">
            <p className="text-[11px] text-lh-text-mute font-mono hidden sm:block">
              Enter to advance
            </p>
            <button
              type="button"
              onClick={advance}
              disabled={!canAdvance}
              className={cnm(
                'rounded-full bg-lh-accent text-lh-bg font-semibold text-sm px-5 py-2',
                'hover:bg-lh-accent-warm transition-colors duration-150',
                'disabled:opacity-40 disabled:pointer-events-none',
              )}
            >
              {step < questions.length - 1 ? 'Next' : 'Review'}
            </button>
          </div>
        </div>
      </Card>

      {/* Step dots */}
      <div
        className="flex items-center justify-center gap-2"
        aria-hidden="true"
      >
        {questions.map((_, i) => (
          <span
            key={i}
            className={cnm(
              'w-1.5 h-1.5 rounded-full transition-all duration-200',
              i < completedCount
                ? 'bg-lh-accent'
                : i === step
                  ? 'bg-lh-accent/50 scale-125'
                  : 'bg-lh-line',
            )}
          />
        ))}
      </div>
    </div>
  )
}

// ── Review screen ─────────────────────────────────────────────────────────

function ReviewScreen({
  questions,
  answers,
  onBack,
  onSubmit,
  isPending,
}: {
  questions: RiskQuestionsResponse['questions']
  answers: Array<string>
  onBack: () => void
  onSubmit: () => void
  isPending: boolean
}) {
  return (
    <div className="space-y-6">
      <div>
        <EyebrowTag prefix="dot" className="mb-3">
          Risk profile
        </EyebrowTag>
        <h1 className="text-3xl font-bold tracking-[-0.03em] mb-2">
          Review your answers
        </h1>
        <p className="text-lh-text-dim text-sm">
          Check everything looks right before we save to your profile and
          MemWal.
        </p>
      </div>

      <Card className="p-6 md:p-8">
        <ul className="space-y-5">
          {questions.map((q, i) => {
            const { headline } = splitPrompt(q.prompt)
            return (
              <li
                key={q.id}
                className="pb-5 border-b border-lh-line last:border-0 last:pb-0"
              >
                <p className="text-xs text-lh-text-mute mb-1">{headline}</p>
                <p className="text-sm font-medium text-lh-text">
                  {answers[i] ?? ''}
                </p>
              </li>
            )
          })}
        </ul>
      </Card>

      <div className="flex items-center justify-between gap-3">
        <button
          type="button"
          onClick={onBack}
          disabled={isPending}
          className={cnm(
            'rounded-full border border-lh-line text-sm font-medium px-5 py-2',
            'text-lh-text-dim hover:text-lh-text transition-colors duration-150',
            'disabled:opacity-30 disabled:pointer-events-none',
          )}
        >
          Back
        </button>

        <GlowBorderButton
          as="button"
          onClick={onSubmit}
          size="md"
          className={cnm(isPending && 'opacity-50 pointer-events-none')}
        >
          {isPending ? 'Saving…' : 'Save and start coaching'}
        </GlowBorderButton>
      </div>
    </div>
  )
}

// ── Success screen ────────────────────────────────────────────────────────

function SuccessScreen({
  result,
  onNavigate,
}: {
  result: RiskProfileCompleteResponse
  onNavigate: () => void
}) {
  const summaryEntries = Object.entries(result.summary)

  return (
    <div className="space-y-6">
      <div>
        <EyebrowTag prefix="dot" className="mb-3">
          Risk profile
        </EyebrowTag>
        <h1 className="text-3xl font-bold tracking-[-0.03em] mb-2">
          Profile complete
        </h1>
        <p className="text-lh-text-dim text-sm">
          Your coach has everything it needs. Here is what was recorded.
        </p>
      </div>

      {!result.memwalPersisted && (
        <div className="rounded-2xl border border-amber-500/30 bg-amber-500/5 px-4 py-3 flex items-start gap-3">
          <span
            className="mt-0.5 text-amber-400 text-xs leading-none select-none"
            aria-hidden="true"
          >
            ▲
          </span>
          <p className="text-xs text-amber-300 leading-relaxed">
            Your MemWal is not set up yet — answers saved to your profile only.{' '}
            <a
              href="/portfolio"
              className="underline underline-offset-2 hover:text-amber-200 transition-colors"
            >
              Set up MemWal
            </a>{' '}
            to enable encrypted memory recall.
          </p>
        </div>
      )}

      <Card className="p-6 md:p-8">
        <p className="font-mono text-[11px] uppercase tracking-[0.14em] text-lh-text-mute mb-4">
          Summary
        </p>
        <dl className="space-y-3">
          {summaryEntries.map(([key, value]) => (
            <div key={key} className="flex flex-col gap-0.5">
              <dt className="text-xs text-lh-text-mute capitalize">{key}</dt>
              <dd className="text-sm font-medium text-lh-text">{value}</dd>
            </div>
          ))}
        </dl>
      </Card>

      <div className="flex justify-end">
        <GlowBorderButton as="button" onClick={onNavigate} size="md">
          Start coaching
        </GlowBorderButton>
      </div>
    </div>
  )
}

// ── Loading skeleton ──────────────────────────────────────────────────────

function SetupSkeleton() {
  return (
    <div className="space-y-6">
      <div className="space-y-3">
        <Skeleton className="h-3 w-24" />
        <Skeleton className="h-9 w-64" />
        <Skeleton className="h-4 w-80" />
      </div>
      <Skeleton className="h-1 w-full rounded-full" />
      <Card className="p-8 space-y-5">
        <div className="space-y-2">
          <Skeleton className="h-5 w-3/4" />
          <Skeleton className="h-4 w-1/2" />
        </div>
        <Skeleton className="h-28 w-full rounded-xl" />
        <div className="flex justify-between">
          <Skeleton className="h-9 w-20 rounded-full" />
          <Skeleton className="h-9 w-24 rounded-full" />
        </div>
      </Card>
    </div>
  )
}
