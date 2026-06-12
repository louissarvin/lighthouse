import type { CoachDecision, ProofResponse } from '@/lib/types'
import { Card } from '@/components/ui/Card'
import { cnm } from '@/utils/style'
import { config } from '@/config'

interface Props {
  proof: ProofResponse
}

/**
 * Public, judge-shareable verifiable receipt for a Lighthouse decision or
 * trade.
 *
 * Reads the `/proof/recommendation/:id` or `/proof/trade/:id` envelope and
 * lays out the four trust columns: Atoma (inference), SEAL (access policy),
 * Walrus (encrypted blob), Sui (on-chain anchor).
 *
 * No auth required — anyone with the URL can verify.
 */
export function ProofCard({ proof }: Props) {
  const isRec = proof.kind === 'recommendation'
  const isTrade = proof.kind === 'trade'
  const rec = isRec ? (proof) : null
  const trade = isTrade ? (proof) : null

  // Distinguish two recommendation flavours:
  //  - structured coach decision (side/price/quantity, Guardian eval)
  //  - free-form chat snippet anchored via /coach/anchor-reply
  const recDecision = rec?.decision as
    | (CoachDecision & { kind?: undefined })
    | { kind: 'chat-anchor'; text: string; originalUserPrompt?: string | null }
    | null
    | undefined
  const isChatAnchor =
    !!recDecision &&
    typeof recDecision === 'object' &&
    'kind' in recDecision &&
    recDecision.kind === 'chat-anchor'
  const guarded = rec && !isChatAnchor

  const explorer = config.links.explorerBase

  const headerEyebrow = isTrade
    ? 'Trade execution receipt'
    : isChatAnchor
      ? 'Coach chat anchor receipt'
      : 'Coach recommendation receipt'
  const headerTitle = isChatAnchor
    ? 'Verify this AI chat'
    : 'Verify this AI trade'

  return (
    <div className="space-y-6">
      {/* Header */}
      <Card className="p-6">
        <div className="flex flex-col md:flex-row md:items-start md:justify-between gap-4">
          <div className="min-w-0">
            <p className="font-mono text-[11px] uppercase tracking-[0.18em] text-lh-text-mute mb-2">
              {headerEyebrow}
            </p>
            <h1 className="text-3xl md:text-[40px] font-bold tracking-[-0.03em] mb-2">
              {headerTitle}
            </h1>
            <p className="text-sm text-lh-text-dim leading-relaxed max-w-2xl">
              {isChatAnchor
                ? 'This receipt binds a free-form coach reply to a Walrus blob and a Sui audit anchor. No Guardian evaluation — this is a verifiable chat snippet, not a trade decision.'
                : 'This document binds an Atoma inference, a SEAL access policy, a Walrus blob, and a Sui audit anchor. Re-hashing the Atoma request and resolving the audit_anchor tx digest reproduces the same fingerprint anyone else can verify independently.'}
            </p>
          </div>
          <div className="shrink-0">
            <CopyButton
              label="Copy as JSON"
              value={JSON.stringify(proof, null, 2)}
            />
          </div>
        </div>
      </Card>

      {guarded && recDecision && (
        <Card className="p-6">
          <p className="font-mono text-[11px] uppercase tracking-[0.18em] text-lh-text-mute mb-3">
            Decision
          </p>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            <Metric
              label="Side"
              value={
                (recDecision as CoachDecision).side === 'bid' ? 'Buy' : 'Sell'
              }
            />
            <Metric
              label="Price"
              value={(recDecision as CoachDecision).price}
              mono
            />
            <Metric
              label="Quantity"
              value={(recDecision as CoachDecision).quantity}
              mono
            />
            <Metric
              label="Guardian"
              value={rec.guardian.pass ? 'Pass' : 'Block'}
              emphasize={rec.guardian.pass ? 'accent' : 'danger'}
            />
          </div>
          {(recDecision as CoachDecision).reasoning && (
            <p className="mt-4 text-sm text-lh-text leading-relaxed border-t border-lh-line pt-4">
              {(recDecision as CoachDecision).reasoning}
            </p>
          )}
        </Card>
      )}

      {isChatAnchor && recDecision && 'text' in recDecision && (
        <Card className="p-6">
          <p className="font-mono text-[11px] uppercase tracking-[0.18em] text-lh-text-mute mb-3">
            Anchored coach reply
          </p>
          {recDecision.originalUserPrompt && (
            <div className="mb-4 pb-4 border-b border-lh-line">
              <p className="font-mono text-[10px] uppercase tracking-[0.14em] text-lh-text-mute mb-2">
                User asked
              </p>
              <p className="text-sm text-lh-text-dim leading-relaxed whitespace-pre-wrap">
                {recDecision.originalUserPrompt}
              </p>
            </div>
          )}
          <p className="font-mono text-[10px] uppercase tracking-[0.14em] text-lh-text-mute mb-2">
            Coach said
          </p>
          <p className="text-sm text-lh-text leading-relaxed whitespace-pre-wrap">
            {recDecision.text}
          </p>
        </Card>
      )}

      {trade && (
        <Card className="p-6">
          <p className="font-mono text-[11px] uppercase tracking-[0.18em] text-lh-text-mute mb-3">
            Order
          </p>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            <Metric label="Status" value={trade.status} />
            <Metric
              label="Side"
              value={trade.side === 'bid' ? 'Buy' : 'Sell'}
            />
            <Metric label="Price" value={trade.price} mono />
            <Metric label="Quantity" value={trade.quantity} mono />
            <Metric label="Notional" value={trade.notional} mono />
            <Metric label="Filled" value={trade.filledQuantity} mono />
          </div>
        </Card>
      )}

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        {/* Atoma */}
        <Section
          title="Atoma"
          eyebrow="Decentralized inference"
          accent="text-lh-accent"
        >
          {rec && (
            <>
              <Field label="Model" value={rec.atoma.model} mono />
              <Field label="Endpoint" value={rec.atoma.endpoint} mono />
              <Field
                label="Request hash"
                value={rec.atoma.requestHash}
                mono
                truncate
              />
              {rec.atoma.responseHash && (
                <Field
                  label="Response hash"
                  value={rec.atoma.responseHash}
                  mono
                  truncate
                />
              )}
              {rec.atoma.nodeSignature && (
                <Field
                  label="Node signature"
                  value={rec.atoma.nodeSignature}
                  mono
                  truncate
                />
              )}
              <p className="mt-3 text-[11px] text-lh-text-mute leading-relaxed">
                Re-hash the request with the same input bytes; the digest must
                match. Anyone running their own Atoma node can prove the
                signature corresponds to that node's verifying key.
              </p>
            </>
          )}
          {trade && trade.recommendation && (
            <>
              <Field label="Model" value={trade.recommendation.model} mono />
              <Field
                label="Endpoint"
                value={trade.recommendation.endpoint}
                mono
              />
              <Field
                label="Request hash"
                value={trade.recommendation.atomaRequestHash}
                mono
                truncate
              />
              <p className="mt-3 text-[11px] text-lh-text-mute leading-relaxed">
                This trade was driven by recommendation{' '}
                <a
                  className="text-lh-accent hover:underline"
                  href={`/receipt/${trade.recommendation.id}`}
                >
                  {trade.recommendation.id.slice(0, 10)}…
                </a>
                .
              </p>
            </>
          )}
        </Section>

        {/* SEAL */}
        <Section title="SEAL" eyebrow="Access policy" accent="text-emerald-300">
          <Field label="Package" value={proof.seal.packageId} mono truncate />
          <Field label="Slice" value={proof.seal.slice} mono />
          {proof.seal.identityHex && (
            <Field
              label="Identity (hex)"
              value={proof.seal.identityHex}
              mono
              truncate
            />
          )}
          <p className="mt-3 text-[11px] text-lh-text-mute leading-relaxed">
            Identity layout:{' '}
            <span className="font-mono">
              [profile_id_32_bytes][\":\"][slice]
            </span>
            . The same Move policy is invoked by every SEAL key server before
            releasing the decryption share.
          </p>
        </Section>

        {/* Walrus */}
        <Section title="Walrus" eyebrow="Encrypted blob" accent="text-sky-300">
          {proof.walrus ? (
            <>
              <Field
                label="Blob ID"
                value={proof.walrus.blobId}
                mono
                truncate
              />
              <Field
                label="Aggregator"
                value={proof.walrus.readUrl}
                mono
                truncate
                href={proof.walrus.readUrl}
              />
              <a
                href={proof.walrus.readUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="mt-3 inline-flex items-center gap-2 rounded-full bg-sky-500/15 text-sky-300 text-xs font-mono uppercase tracking-[0.14em] px-3 py-1.5 hover:bg-sky-500/25 transition-colors"
              >
                Open ciphertext →
              </a>
            </>
          ) : (
            <p className="text-sm text-lh-text-mute">
              No Walrus blob recorded yet — recommendation archived in MemWal
              only.
            </p>
          )}
        </Section>

        {/* Sui */}
        <Section title="Sui" eyebrow="On-chain anchor" accent="text-violet-300">
          <Field
            label="Lighthouse package"
            value={proof.lighthouse.packageId ?? '—'}
            mono
            truncate
            href={
              proof.lighthouse.packageId
                ? `${explorer}/package/${proof.lighthouse.packageId}`
                : undefined
            }
          />
          {proof.lighthouse.profileObjectId && (
            <Field
              label="Trader profile"
              value={proof.lighthouse.profileObjectId}
              mono
              truncate
              href={`${explorer}/object/${proof.lighthouse.profileObjectId}`}
            />
          )}
          {proof.lighthouse.executorAgentId && (
            <Field
              label="ExecutorAgent"
              value={proof.lighthouse.executorAgentId}
              mono
              truncate
              href={`${explorer}/object/${proof.lighthouse.executorAgentId}`}
            />
          )}
          <Field
            label="Owner"
            value={proof.lighthouse.suiAddress}
            mono
            truncate
            href={`${explorer}/account/${proof.lighthouse.suiAddress}`}
          />
          {trade?.sui?.txDigest && (
            <Field
              label="Place-limit tx"
              value={trade.sui.txDigest}
              mono
              truncate
              href={`${explorer}/tx/${trade.sui.txDigest}`}
            />
          )}
          {rec?.sui?.txDigest && (
            <Field
              label="AuditAnchor tx"
              value={rec.sui.txDigest}
              mono
              truncate
              href={`${explorer}/tx/${rec.sui.txDigest}`}
            />
          )}
          {rec && !rec.sui?.txDigest && rec.walrus && (
            <p className="text-[10px] text-lh-text-mute italic">
              AuditAnchor tx digest is indexing — refresh in a few seconds.
            </p>
          )}
        </Section>
      </div>

      {rec?.verification && (
        <Card className="p-6">
          <p className="font-mono text-[11px] uppercase tracking-[0.18em] text-lh-text-mute mb-2">
            Verification instructions
          </p>
          <p className="text-sm text-lh-text-dim leading-relaxed">
            {rec.verification.instructions}
          </p>
        </Card>
      )}
    </div>
  )
}

function Section({
  title,
  eyebrow,
  accent,
  children,
}: {
  title: string
  eyebrow: string
  accent?: string
  children: React.ReactNode
}) {
  return (
    <Card className="p-6">
      <div className="mb-4">
        <p
          className={cnm(
            'font-mono text-[11px] uppercase tracking-[0.18em] mb-1',
            accent ?? 'text-lh-accent',
          )}
        >
          {eyebrow}
        </p>
        <h2 className="text-xl font-semibold tracking-[-0.01em]">{title}</h2>
      </div>
      <dl className="space-y-2 text-xs">{children}</dl>
    </Card>
  )
}

function Field({
  label,
  value,
  mono,
  truncate,
  href,
}: {
  label: string
  value: string
  mono?: boolean
  truncate?: boolean
  href?: string
}) {
  const cls = cnm(
    'text-right break-all',
    mono ? 'font-mono tabular-nums' : '',
    truncate ? 'truncate max-w-[260px]' : '',
    href ? 'text-lh-accent hover:underline' : 'text-lh-text-dim',
  )
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="text-lh-text-mute uppercase tracking-[0.12em] font-mono text-[10px] shrink-0">
        {label}
      </dt>
      <dd className={cls}>
        {href ? (
          <a href={href} target="_blank" rel="noopener noreferrer">
            {value}
          </a>
        ) : (
          value
        )}
      </dd>
    </div>
  )
}

function Metric({
  label,
  value,
  mono,
  emphasize,
}: {
  label: string
  value: string
  mono?: boolean
  emphasize?: 'accent' | 'danger'
}) {
  return (
    <div>
      <dt className="font-mono uppercase tracking-[0.12em] text-[10px] text-lh-text-mute mb-1">
        {label}
      </dt>
      <dd
        className={cnm(
          'text-base font-semibold',
          mono ? 'font-mono tabular-nums' : '',
          emphasize === 'danger' && 'text-red-300',
          emphasize === 'accent' && 'text-emerald-300',
        )}
      >
        {value}
      </dd>
    </div>
  )
}

function CopyButton({ label, value }: { label: string; value: string }) {
  return (
    <button
      type="button"
      onClick={() => {
        try {
          void navigator.clipboard.writeText(value)
        } catch {
          // ignore — user can copy manually
        }
      }}
      className={cnm(
        'inline-flex items-center gap-2 rounded-full',
        'border border-lh-line bg-lh-bg/40 px-4 py-2',
        'text-xs font-mono uppercase tracking-[0.14em] text-lh-text-dim',
        'hover:text-lh-text hover:border-lh-accent/50 transition-colors',
      )}
    >
      {label}
    </button>
  )
}
