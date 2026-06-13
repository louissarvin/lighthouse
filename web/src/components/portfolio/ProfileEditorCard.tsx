/**
 * ProfileEditorCard — Avatar upload + Bio editor.
 *
 * Avatar upload security checklist (CWE-434 — Unrestricted File Upload):
 *  - MIME validated via ArrayBuffer magic bytes (not browser File.type).
 *  - Only PNG, JPEG, WebP accepted. SVG explicitly rejected.
 *  - Resized to 256x256 via <canvas> before upload to keep Walrus cost low.
 *  - Max 256 KB enforced on the resized output bytes, not just source file.
 *  - img src is always from walrusBlobUrl(), which only builds URLs against
 *    the known aggregator base — no user-controlled string reaches img.src.
 */

import { useRef, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { AlertCircle, CheckCircle, Upload } from 'lucide-react'
import { useCurrentAccount, useSignTransaction, useSuiClient } from '@mysten/dapp-kit'
import type { Signer } from '@mysten/sui/cryptography'

import type {
  AvatarSetRequest,
  AvatarSetResponse,
  BioSetRequest,
  BioSetResponse,
  ProfileMe,
} from '@/lib/types'
import { Card } from '@/components/ui/Card'
import { apiFetch } from '@/lib/api'
import { walrusBlobUrl } from '@/lib/walrus'
import { uploadBlobToWalrus } from '@/lib/walrus-write'
import { cnm } from '@/utils/style'

// ────────────────────────────────────────────────────────────────────────
// Constants
// ────────────────────────────────────────────────────────────────────────

const ALLOWED_MIME = new Set(['image/png', 'image/jpeg', 'image/webp'])
const MAX_BYTES = 256 * 1024 // 256 KB after resize
const TARGET_SIZE = 256 // px

// Magic byte signatures for content-based MIME detection.
const MAGIC: Array<{ mime: string; bytes: Array<number | null> }> = [
  { mime: 'image/png', bytes: [0x89, 0x50, 0x4e, 0x47] },
  { mime: 'image/jpeg', bytes: [0xff, 0xd8, 0xff] },
  // WebP: RIFF....WEBP (bytes 0-3 = RIFF, 8-11 = WEBP)
  {
    mime: 'image/webp',
    bytes: [0x52, 0x49, 0x46, 0x46, null, null, null, null, 0x57, 0x45, 0x42, 0x50],
  },
]

function detectMime(buf: ArrayBuffer): string | null {
  const view = new Uint8Array(buf, 0, 16)
  for (const sig of MAGIC) {
    const match = sig.bytes.every((b, i) => b === null || view[i] === b)
    if (match) return sig.mime
  }
  return null
}

// ────────────────────────────────────────────────────────────────────────
// Canvas resize: crop to square, scale to 256x256
// ────────────────────────────────────────────────────────────────────────

async function resizeToSquare(file: File, mime: string): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file)
    const img = new Image()
    img.onload = () => {
      URL.revokeObjectURL(url)
      const canvas = document.createElement('canvas')
      canvas.width = TARGET_SIZE
      canvas.height = TARGET_SIZE
      const ctx = canvas.getContext('2d')
      if (!ctx) {
        reject(new Error('Canvas 2D context unavailable'))
        return
      }
      const srcSide = Math.min(img.width, img.height)
      const srcX = (img.width - srcSide) / 2
      const srcY = (img.height - srcSide) / 2
      ctx.drawImage(img, srcX, srcY, srcSide, srcSide, 0, 0, TARGET_SIZE, TARGET_SIZE)

      const outMime = mime === 'image/png' ? 'image/png' : 'image/jpeg'
      const quality = mime === 'image/png' ? undefined : 0.85
      canvas.toBlob(
        (blob) => {
          if (!blob) {
            reject(new Error('Canvas toBlob returned null'))
            return
          }
          blob
            .arrayBuffer()
            .then((ab) => resolve(new Uint8Array(ab)))
            .catch(reject)
        },
        outMime,
        quality,
      )
    }
    img.onerror = () => {
      URL.revokeObjectURL(url)
      reject(new Error('Failed to load image for resize'))
    }
    img.src = url
  })
}

// ────────────────────────────────────────────────────────────────────────
// Types
// ────────────────────────────────────────────────────────────────────────

type Status = 'idle' | 'busy' | 'success' | 'error'

// ────────────────────────────────────────────────────────────────────────
// Avatar upload section
// ────────────────────────────────────────────────────────────────────────

interface AvatarUploadProps {
  profile: ProfileMe
  currentAvatarBlobId?: string | null
}

export function AvatarUploadSection({ profile, currentAvatarBlobId }: AvatarUploadProps) {
  const [status, setStatus] = useState<Status>('idle')
  const [errorMsg, setErrorMsg] = useState<string | null>(null)
  const [previewUrl, setPreviewUrl] = useState<string | null>(null)
  const [uploadedBlobId, setUploadedBlobId] = useState<string | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const qc = useQueryClient()

  const suiClient = useSuiClient()
  const account = useCurrentAccount()
  const { mutateAsync: signTransaction } = useSignTransaction()

  const effectiveBlobId = uploadedBlobId ?? currentAvatarBlobId ?? null
  const displayUrl = previewUrl ?? walrusBlobUrl(effectiveBlobId)

  async function handleFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    // Reset so the same file can be re-selected after an error
    if (fileRef.current) fileRef.current.value = ''

    if (!file) return

    setStatus('busy')
    setErrorMsg(null)
    setPreviewUrl(null)

    let objUrl: string | null = null

    try {
      // 1. Read first 16 bytes for magic-based MIME check
      const head = await file.slice(0, 16).arrayBuffer()
      const detectedMime = detectMime(head)
      if (!detectedMime || !ALLOWED_MIME.has(detectedMime)) {
        throw new Error('Only PNG, JPEG, and WebP images are accepted. SVG is not allowed.')
      }

      // 2. Resize to 256x256
      const bytes = await resizeToSquare(file, detectedMime)

      // 3. Enforce size after resize
      if (bytes.byteLength > MAX_BYTES) {
        throw new Error(
          `Resized image is ${Math.round(bytes.byteLength / 1024)} KB — max is 256 KB. Try a simpler image.`,
        )
      }

      // 4. Show preview
      const plainBuf = new ArrayBuffer(bytes.byteLength)
      new Uint8Array(plainBuf).set(bytes)
      const blob = new Blob([plainBuf], { type: detectedMime })
      objUrl = URL.createObjectURL(blob)
      setPreviewUrl(objUrl)

      // 5. Build Signer adapter from dapp-kit (same pattern as AnchorNoteCard)
      if (!account) {
        throw new Error('Connect your wallet before uploading an avatar.')
      }
      const signer: Signer = {
        toSuiAddress: () => account.address,
        signTransaction: async (txBytes: Uint8Array) => {
          const { Transaction } = await import('@mysten/sui/transactions')
          const tx = Transaction.from(txBytes)
          const result = await signTransaction({ transaction: tx, account })
          return { signature: result.signature, bytes: result.bytes }
        },
        signWithIntent: () => {
          return Promise.reject(new Error('signWithIntent not supported in Enoki context'))
        },
      } as unknown as Signer

      // 6. Upload bytes to Walrus
      const result = await uploadBlobToWalrus(bytes, suiClient, signer)

      // 7. Notify backend
      const resp = await apiFetch<AvatarSetResponse>('/profile/me/avatar', {
        method: 'POST',
        body: { blobId: result.blobId, mimeType: detectedMime } satisfies AvatarSetRequest,
      })

      setUploadedBlobId(resp.avatarBlobId)
      if (objUrl) {
        URL.revokeObjectURL(objUrl)
        objUrl = null
      }
      setPreviewUrl(null)

      // Invalidate profile cache
      await qc.invalidateQueries({ queryKey: ['auth', 'profile-me'] })
      if (profile.suinsName) {
        await qc.invalidateQueries({ queryKey: ['public-profile', profile.suinsName] })
      }

      setStatus('success')
    } catch (err) {
      setStatus('error')
      setErrorMsg((err as Error).message || 'Upload failed.')
      if (objUrl) {
        URL.revokeObjectURL(objUrl)
      }
      setPreviewUrl(null)
    }
  }

  const avatarInitials = (
    profile.suinsName
      ? profile.suinsName.replace(/\.sui$/, '').slice(0, 2)
      : profile.suiAddress.replace(/^0x/, '').slice(0, 2)
  ).toUpperCase()

  return (
    <div>
      <p className="font-mono text-[11px] uppercase tracking-[0.18em] text-lh-text-mute mb-3">
        Profile avatar
      </p>

      <div className="flex items-center gap-4">
        {/* Preview circle */}
        <div className="w-16 h-16 rounded-full overflow-hidden border border-lh-line bg-lh-bg shrink-0 flex items-center justify-center">
          {displayUrl ? (
            <img
              src={displayUrl}
              alt="Current avatar"
              width={64}
              height={64}
              className="w-full h-full object-cover"
            />
          ) : (
            <span className="text-lh-text-mute text-xs font-mono">{avatarInitials}</span>
          )}
        </div>

        {/* Upload label */}
        <div className="flex flex-col gap-2">
          <label
            className={cnm(
              'inline-flex items-center gap-2 rounded-full px-4 py-2 cursor-pointer',
              'border border-lh-line text-lh-text-dim text-xs font-mono',
              'uppercase tracking-[0.12em]',
              'hover:text-lh-text hover:border-lh-accent/50 transition-colors',
              status === 'busy' && 'opacity-50 cursor-wait pointer-events-none',
            )}
          >
            <Upload size={12} strokeWidth={2} aria-hidden="true" />
            {status === 'busy' ? 'Uploading…' : 'Upload image'}
            <input
              ref={fileRef}
              type="file"
              accept="image/png,image/jpeg,image/webp"
              className="sr-only"
              onChange={(e) => {
                void handleFile(e)
              }}
              disabled={status === 'busy'}
              aria-label="Upload avatar image"
            />
          </label>
          <p className="text-[11px] text-lh-text-mute">
            PNG, JPEG, or WebP · max 256 KB · cropped to 256×256
          </p>
        </div>
      </div>

      {status === 'success' && (
        <div className="mt-3 flex items-center gap-1.5 text-emerald-400 text-xs font-mono">
          <CheckCircle size={12} strokeWidth={2} aria-hidden="true" />
          Avatar updated and stored on Walrus.
        </div>
      )}
      {status === 'error' && errorMsg && (
        <div className="mt-3 flex items-start gap-1.5 text-red-400 text-xs">
          <AlertCircle size={12} strokeWidth={2} className="mt-px shrink-0" aria-hidden="true" />
          <span>{errorMsg}</span>
        </div>
      )}
    </div>
  )
}

// ────────────────────────────────────────────────────────────────────────
// Bio editor section
// ────────────────────────────────────────────────────────────────────────

const MAX_BIO = 280

interface BioEditorProps {
  profile: ProfileMe
  currentBio?: string | null
}

export function BioEditorSection({ profile, currentBio }: BioEditorProps) {
  const [bio, setBio] = useState(currentBio ?? '')
  const [status, setStatus] = useState<Status>('idle')
  const [errorMsg, setErrorMsg] = useState<string | null>(null)
  const qc = useQueryClient()

  async function handleSave() {
    if (bio.length > MAX_BIO) return
    setStatus('busy')
    setErrorMsg(null)
    try {
      await apiFetch<BioSetResponse>('/profile/me/bio', {
        method: 'POST',
        body: { bio: bio.trim() } satisfies BioSetRequest,
      })

      await qc.invalidateQueries({ queryKey: ['auth', 'profile-me'] })
      if (profile.suinsName) {
        await qc.invalidateQueries({ queryKey: ['public-profile', profile.suinsName] })
      }

      setStatus('success')
    } catch (err) {
      setStatus('error')
      setErrorMsg((err as Error).message || 'Save failed.')
    }
  }

  const remaining = MAX_BIO - bio.length
  const overLimit = remaining < 0
  const unchanged = bio === (currentBio || '')

  return (
    <div>
      <p className="font-mono text-[11px] uppercase tracking-[0.18em] text-lh-text-mute mb-3">
        Bio
      </p>

      <textarea
        value={bio}
        onChange={(e) => {
          setBio(e.target.value)
          if (status !== 'idle') setStatus('idle')
        }}
        rows={3}
        placeholder="Short description shown on your public profile…"
        className={cnm(
          'w-full rounded-xl border px-4 py-3 text-sm',
          'bg-lh-bg text-lh-text placeholder:text-lh-text-mute',
          'resize-none focus:outline-none',
          'transition-colors',
          overLimit
            ? 'border-red-500/50 focus:border-red-500'
            : 'border-lh-line focus:border-lh-accent/50',
        )}
        aria-label="Profile bio"
        aria-describedby="bio-char-count"
      />

      <div className="flex items-center justify-between mt-2">
        <span
          id="bio-char-count"
          className={cnm('font-mono text-[11px]', overLimit ? 'text-red-400' : 'text-lh-text-mute')}
          aria-live="polite"
        >
          {remaining} chars remaining
        </span>

        <button
          type="button"
          onClick={() => {
            void handleSave()
          }}
          disabled={status === 'busy' || overLimit || unchanged}
          className={cnm(
            'inline-flex items-center gap-1.5 rounded-full px-4 py-1.5',
            'bg-lh-accent text-lh-bg font-semibold text-xs font-mono',
            'uppercase tracking-[0.12em]',
            'hover:bg-lh-accent/90 transition-colors',
            'disabled:opacity-40 disabled:cursor-not-allowed',
          )}
        >
          {status === 'busy' ? 'Saving…' : 'Save bio'}
        </button>
      </div>

      {status === 'success' && (
        <div className="mt-2 flex items-center gap-1.5 text-emerald-400 text-xs font-mono">
          <CheckCircle size={12} strokeWidth={2} aria-hidden="true" />
          Bio saved.
        </div>
      )}
      {status === 'error' && errorMsg && (
        <div className="mt-2 flex items-start gap-1.5 text-red-400 text-xs">
          <AlertCircle size={12} strokeWidth={2} className="mt-px shrink-0" aria-hidden="true" />
          <span>{errorMsg}</span>
        </div>
      )}
    </div>
  )
}

// ────────────────────────────────────────────────────────────────────────
// Composed card (mounted in /portfolio)
// ────────────────────────────────────────────────────────────────────────

interface ProfileEditorCardProps {
  profile: ProfileMe
  avatarBlobId?: string | null
  bio?: string | null
}

export function ProfileEditorCard({ profile, avatarBlobId, bio }: ProfileEditorCardProps) {
  return (
    <Card className="p-6 md:p-8">
      <h3 className="text-lg font-semibold mb-6">Edit public profile</h3>

      <div className="space-y-8">
        <AvatarUploadSection profile={profile} currentAvatarBlobId={avatarBlobId} />

        <div className="border-t border-lh-line pt-8">
          <BioEditorSection profile={profile} currentBio={bio} />
        </div>
      </div>

      {profile.suinsName && (
        <div className="mt-6 pt-6 border-t border-lh-line">
          <p className="text-xs text-lh-text-mute">
            Your public profile is at{' '}
            <a href={`/u/${profile.suinsName}`} className="text-lh-accent hover:underline font-mono">
              /u/{profile.suinsName}
            </a>
            .
          </p>
        </div>
      )}
    </Card>
  )
}
