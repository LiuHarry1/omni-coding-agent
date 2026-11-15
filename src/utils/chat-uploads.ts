/**
 * Chat attachments — OpenClaw-style claim-check.
 *
 * Bytes live under `{agentHome}/.ai-agent/uploads/{sessionId}/`; transcript + UI
 * keep short `/sessions/{id}/uploads/{file}` refs (never multi-MB base64 /
 * Buffer arrays). Older sessions may still have files under
 * `projects/<key>/<sessionId>/uploads/` — readers fall back there.
 *
 * Images keep their own narrow helpers because `buildUserMessage` and the
 * image hydrate path must never be handed a PDF or a CSV by accident.
 */

import { randomUUID } from 'crypto'
import * as fs from 'fs'
import * as fsp from 'fs/promises'
import * as path from 'path'
import { fileURLToPath } from 'url'
import {
  assertAttachmentSize,
  attachmentMediaType,
  classifyAttachment,
  normalizeExt,
  type AttachmentKind,
} from '../constants/attachment-types.js'
import {
  getChatUploadsSessionDir,
  getSessionDataDir,
  requireSessionLocation,
} from '../session/paths.js'
import type { ImageMediaType } from '../core/types.js'

export const CHAT_UPLOAD_MAX_BYTES = 10 * 1024 * 1024
export const CHAT_UPLOAD_MAX_COUNT = 5

const MIME_TO_EXT: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpeg',
  'image/jpg': 'jpeg',
  'image/gif': 'gif',
  'image/webp': 'webp',
}

const EXT_TO_MIME: Record<string, ImageMediaType> = {
  png: 'image/png',
  jpeg: 'image/jpeg',
  jpg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
}

/** Image-only filename allowlist (ImagePart refs, `hydrateImageBytes`). */
export const CHAT_UPLOAD_FILE_RE = /^[A-Za-z0-9_-]+\.(png|jpe?g|gif|webp)$/

/**
 * Filename allowlist for GET /sessions/:id/uploads/:file and non-image
 * attachments. Saved names are `{uuid}-{sanitized-base}.{ext}`, so the
 * character class doubles as path-traversal defence (no dots, no separators
 * in the stem).
 */
export const CHAT_UPLOAD_ANY_FILE_RE =
  /^[A-Za-z0-9_-]{1,120}\.[A-Za-z0-9]{1,12}$/

export function normalizeImageMediaType(raw: string): ImageMediaType {
  const mime = raw.toLowerCase().split(';')[0]!.trim()
  if (mime === 'image/jpg') return 'image/jpeg'
  if (
    mime === 'image/png' ||
    mime === 'image/jpeg' ||
    mime === 'image/gif' ||
    mime === 'image/webp'
  ) {
    return mime
  }
  throw new Error(`Unsupported image type: ${raw}`)
}

export function extForMediaType(mediaType: string): string {
  const mime = normalizeImageMediaType(mediaType)
  return MIME_TO_EXT[mime] ?? 'png'
}

export function mediaTypeForExt(ext: string): ImageMediaType {
  const e = ext.replace(/^\./, '').toLowerCase()
  const mime = EXT_TO_MIME[e]
  if (!mime) throw new Error(`Unsupported image extension: ${ext}`)
  return mime
}

/** Canonical on-disk extension for an image (`jpg` → `jpeg`). */
export function canonicalImageExt(fileNameOrExt: string): string {
  try {
    return extForMediaType(mediaTypeForExt(fileNameOrExt))
  } catch {
    return extForMediaType(fileNameOrExt)
  }
}

export function chatUploadUrl(sessionId: string, fileName: string): string {
  return `/sessions/${encodeURIComponent(sessionId)}/uploads/${fileName}`
}

export function getChatUploadsDir(sessionId: string): string {
  const { agentHome } = requireSessionLocation(sessionId)
  return getChatUploadsSessionDir(sessionId, agentHome)
}

function legacyChatUploadsDir(sessionId: string): string {
  return path.join(getSessionDataDir(sessionId), 'uploads')
}

function joinUnderDir(root: string, fileName: string): string | null {
  const resolvedRoot = path.resolve(root)
  const abs = path.resolve(resolvedRoot, fileName)
  if (abs === resolvedRoot || !abs.startsWith(resolvedRoot + path.sep)) {
    return null
  }
  return abs
}

/**
 * On-disk path for an upload filename. New writes live under
 * `{agentHome}/.ai-agent/uploads/{sessionId}/`; readers also accept the
 * pre-move `projects/<key>/<sessionId>/uploads/` location.
 */
export function resolveChatUploadFileAbs(
  sessionId: string,
  fileName: string,
): string | null {
  const primary = joinUnderDir(getChatUploadsDir(sessionId), fileName)
  if (!primary) return null
  if (fs.existsSync(primary)) return primary
  try {
    const legacy = joinUnderDir(legacyChatUploadsDir(sessionId), fileName)
    if (legacy && fs.existsSync(legacy)) return legacy
  } catch {
    /* session location missing or legacy dir unreachable */
  }
  return primary
}

/** Match `/sessions/{id}/uploads/{file}` (encoded or plain id). */
export function parseChatUploadUrl(
  ref: string,
): { sessionId: string; fileName: string } | null {
  const m = ref.match(/^\/sessions\/([^/]+)\/uploads\/([^/]+)$/)
  if (!m) return null
  const sessionId = decodeURIComponent(m[1]!)
  const fileName = decodeURIComponent(m[2]!)
  if (!CHAT_UPLOAD_FILE_RE.test(fileName)) return null
  return { sessionId, fileName }
}

/** Match `/sessions/{id}/uploads/{file}` for attachments of any kind. */
export function parseChatUploadRef(
  ref: string,
): { sessionId: string; fileName: string } | null {
  const m = ref.match(/^\/sessions\/([^/]+)\/uploads\/([^/]+)$/)
  if (!m) return null
  const sessionId = decodeURIComponent(m[1]!)
  const fileName = decodeURIComponent(m[2]!)
  if (!CHAT_UPLOAD_ANY_FILE_RE.test(fileName)) return null
  return { sessionId, fileName }
}

export function parseDataUrl(dataUrl: string): {
  buffer: Buffer
  mediaType: ImageMediaType
} {
  const match = dataUrl.match(/^data:([^;]+);base64,(.+)$/s)
  if (!match) throw new Error('Invalid data URL')
  const mediaType = normalizeImageMediaType(match[1]!)
  const buffer = Buffer.from(match[2]!, 'base64')
  return { buffer, mediaType }
}

export function assertChatUploadSize(bytes: number): void {
  if (bytes <= 0) throw new Error('Empty image')
  if (bytes > CHAT_UPLOAD_MAX_BYTES) {
    throw new Error(
      `Image too large (${bytes} bytes; max ${CHAT_UPLOAD_MAX_BYTES})`,
    )
  }
}

export type SavedChatUpload = {
  fileName: string
  url: string
  absPath: string
  mediaType: ImageMediaType
  sizeBytes: number
}

export async function saveChatUpload(
  sessionId: string,
  buffer: Buffer,
  mediaType: string,
): Promise<SavedChatUpload> {
  assertChatUploadSize(buffer.byteLength)
  const mime = normalizeImageMediaType(mediaType)
  const ext = extForMediaType(mime)
  const dir = getChatUploadsDir(sessionId)
  await fsp.mkdir(dir, { recursive: true })
  const fileName = `${randomUUID().replace(/-/g, '')}.${ext}`
  const absPath = path.join(dir, fileName)
  await fsp.writeFile(absPath, buffer)
  return {
    fileName,
    url: chatUploadUrl(sessionId, fileName),
    absPath,
    mediaType: mime,
    sizeBytes: buffer.byteLength,
  }
}

export type SavedChatAttachment = {
  fileName: string
  url: string
  absPath: string
  /** Name the user picked, for prompts and UI chips. */
  originalName: string
  mediaType: string
  kind: AttachmentKind
  sizeBytes: number
}

/**
 * Keep the user's basename recognisable in the saved name — the model sees
 * it in attachment prompts and Bash commands — while forcing it into the
 * `CHAT_UPLOAD_ANY_FILE_RE` character class.
 */
function sanitizeUploadStem(originalName: string): string {
  const base = path.basename(originalName)
  const dot = base.lastIndexOf('.')
  const stem = dot > 0 ? base.slice(0, dot) : base
  const safe = stem.replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '')
  return safe.slice(0, 60) || 'file'
}

/**
 * Extension an image must be stored under. `buildUserMessage` reads the media
 * type back off the saved name, so guessing here would send the model bytes
 * labelled as a format they are not. A name with no usable extension (pasted
 * clipboard images) falls back to the browser's media type.
 */
function imageUploadExt(ext: string, mediaType: string): string {
  for (const candidate of [ext, mediaType]) {
    if (!candidate) continue
    try {
      return canonicalImageExt(candidate)
    } catch {
      continue
    }
  }
  throw new Error(`Unsupported image type: ${mediaType || ext || 'unknown'}`)
}

/** Persist any composer attachment under the session uploads dir. */
export async function saveChatAttachment(
  sessionId: string,
  buffer: Buffer,
  meta: { originalName: string; mediaType?: string },
): Promise<SavedChatAttachment> {
  const originalName = path.basename(meta.originalName) || 'file'
  const kind = classifyAttachment(originalName, meta.mediaType)
  assertAttachmentSize(kind, buffer.byteLength)

  const mediaType = attachmentMediaType(originalName, meta.mediaType)
  // Images must land on a CHAT_UPLOAD_FILE_RE name (`jpg` → `jpeg`) so
  // buildUserMessage / hydrateImageBytes accept the claim-check URL.
  let ext = normalizeExt(originalName)
    .replace(/[^a-z0-9]/g, '')
    .slice(0, 12)
  if (kind === 'image') ext = imageUploadExt(ext, mediaType)
  const fileName = `${randomUUID().replace(/-/g, '').slice(0, 12)}-${sanitizeUploadStem(originalName)}.${ext || 'bin'}`

  const dir = getChatUploadsDir(sessionId)
  await fsp.mkdir(dir, { recursive: true })
  const absPath = path.join(dir, fileName)
  await fsp.writeFile(absPath, buffer)

  return {
    fileName,
    url: chatUploadUrl(sessionId, fileName),
    absPath,
    originalName,
    mediaType,
    kind,
    sizeBytes: buffer.byteLength,
  }
}

/**
 * Absolute path for an upload ref belonging to `sessionId`.
 *
 * The session id inside the ref is never trusted: a client could otherwise
 * name another user's session and read its uploads. Returns null for a
 * foreign session, a bad filename, or a path escaping the uploads dir.
 */
export function resolveChatAttachmentAbsPath(
  ref: string,
  sessionId: string,
): string | null {
  const parsed = parseChatUploadRef(ref)
  if (!parsed || parsed.sessionId !== sessionId) return null
  return resolveChatUploadFileAbs(sessionId, parsed.fileName)
}

/**
 * Turn inbound chat `images[]` (data URLs or existing upload URLs) into durable
 * session upload URLs. Idempotent for refs already under this session.
 */
export async function offloadChatImageRefs(
  sessionId: string,
  images: string[] | undefined,
): Promise<string[]> {
  if (!images?.length) return []
  if (images.length > CHAT_UPLOAD_MAX_COUNT) {
    throw new Error(`Too many images (max ${CHAT_UPLOAD_MAX_COUNT})`)
  }

  const out: string[] = []
  for (const raw of images) {
    if (typeof raw !== 'string' || !raw) {
      throw new Error('Invalid image attachment')
    }
    const existing = parseChatUploadUrl(raw)
    if (existing) {
      if (existing.sessionId !== sessionId) {
        throw new Error('Image upload belongs to another session')
      }
      const abs = resolveChatUploadFileAbs(sessionId, existing.fileName)
      if (!abs || !fs.existsSync(abs)) {
        throw new Error(`Missing upload file: ${existing.fileName}`)
      }
      out.push(chatUploadUrl(sessionId, existing.fileName))
      continue
    }
    if (raw.startsWith('data:')) {
      const { buffer, mediaType } = parseDataUrl(raw)
      const saved = await saveChatUpload(sessionId, buffer, mediaType)
      out.push(saved.url)
      continue
    }
    throw new Error(
      'Unsupported image ref (expected data URL or /sessions/.../uploads/...)',
    )
  }
  return out
}

/** Absolute path for a chat upload URL, or null if not a valid upload ref. */
export function resolveChatUploadAbsPath(ref: string): string | null {
  const parsed = parseChatUploadUrl(ref)
  if (!parsed) return null
  const abs = resolveChatUploadFileAbs(parsed.sessionId, parsed.fileName)
  if (!abs) return null
  return abs
}

/**
 * Load bytes for an ImagePart.image value (upload URL, file://, data URL, or Buffer).
 * Used when projecting history to the model API.
 */
export function hydrateImageBytes(
  image: string | Buffer | Uint8Array,
  mediaType?: string,
): { buffer: Buffer; mediaType: ImageMediaType } {
  if (Buffer.isBuffer(image)) {
    return {
      buffer: image,
      mediaType: mediaType ? normalizeImageMediaType(mediaType) : 'image/png',
    }
  }
  if (image instanceof Uint8Array) {
    return {
      buffer: Buffer.from(image),
      mediaType: mediaType ? normalizeImageMediaType(mediaType) : 'image/png',
    }
  }
  if (typeof image === 'string') {
    if (image.startsWith('data:')) {
      return parseDataUrl(image)
    }
    if (image.startsWith('file:')) {
      const abs = fileURLToPath(image)
      if (!fs.existsSync(abs)) {
        throw new Error(`Missing file image: ${abs}`)
      }
      const ext = path.extname(abs).slice(1)
      return {
        buffer: fs.readFileSync(abs),
        mediaType: mediaType
          ? normalizeImageMediaType(mediaType)
          : mediaTypeForExt(ext || 'png'),
      }
    }
    const abs = resolveChatUploadAbsPath(image)
    if (abs && fs.existsSync(abs)) {
      const ext = path.extname(abs).slice(1)
      return {
        buffer: fs.readFileSync(abs),
        mediaType: mediaType
          ? normalizeImageMediaType(mediaType)
          : mediaTypeForExt(ext),
      }
    }
  }
  throw new Error('Unable to hydrate image attachment')
}

export function mimeFromUploadFileName(fileName: string): string {
  return attachmentMediaType(fileName)
}
