/**
 * Buffer-level image downscaling for tool results. `read-image.ts` covers the
 * file-read path; this covers images a tool produces in memory (screenshots,
 * canvas exports).
 *
 * sharp is imported dynamically so the agent still runs when the optional
 * native binary is unavailable — callers get the original buffer back if it
 * already fits the API limits, and an error only when it genuinely can't.
 */
import {
  API_IMAGE_MAX_BASE64_SIZE,
  IMAGE_MAX_HEIGHT,
  IMAGE_MAX_WIDTH,
  IMAGE_TARGET_RAW_SIZE,
} from '../../constants/api_limits.js'
import { createRequire } from 'node:module'
import * as path from 'node:path'
import type { ImageBlockParam, ImageMediaType } from '../../core/types.js'
import { buildImageBlock } from '../tool-result-content.js'

declare const __filename: string | undefined

/** Base64 chars per token, i.e. the `base64.length * 0.125` estimate. */
const TOKENS_PER_BASE64_CHAR = 0.125

const JPEG_QUALITY_LADDER = [75, 55, 35, 20] as const
/** Square bounding boxes. Width-only ladders leave tall receipts (水单) huge. */
const RESIZE_BOX_LADDER = [
  1600, 1280, 1024, 768, 512, 384, 256, 192, 128,
] as const
const LAST_RESORT_BOX = 128

export class ImageResizeError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ImageResizeError'
  }
}

export function isImageResizeError(err: unknown): err is ImageResizeError {
  return (
    err instanceof ImageResizeError ||
    (err instanceof Error && err.name === 'ImageResizeError')
  )
}

type SharpCtor = typeof import('sharp')

type PngSyncReader = {
  sync: {
    read: (buf: Buffer) => { data: Buffer; width: number; height: number }
  }
}

let cachedSharp: SharpCtor | null | undefined
let sharpLoadError = ''

function unwrapSharp(mod: unknown): SharpCtor | null {
  if (typeof mod === 'function') return mod as SharpCtor
  if (mod && typeof (mod as { default?: unknown }).default === 'function') {
    return (mod as { default: SharpCtor }).default
  }
  return null
}

function unwrapPng(mod: unknown): PngSyncReader | null {
  const rec = mod as { PNG?: PngSyncReader; default?: { PNG?: PngSyncReader } }
  return rec.PNG ?? rec.default?.PNG ?? null
}

function requireAnchors(): string[] {
  const out: string[] = []
  if (typeof __filename === 'string' && __filename.length > 1) {
    out.push(__filename)
  }
  if (process.env.AGENT_ROOT) {
    out.push(path.join(process.env.AGENT_ROOT, 'package.json'))
  }
  out.push(path.join(process.cwd(), 'package.json'))
  return [...new Set(out)]
}

function sharpModuleIds(): string[] {
  const ids = ['sharp']
  const roots: string[] = []
  if (process.env.AGENT_ROOT) roots.push(process.env.AGENT_ROOT)
  roots.push(process.cwd())
  if (typeof __filename === 'string') {
    const dir = path.dirname(__filename)
    roots.push(dir)
    roots.push(path.resolve(dir, '..'))
    roots.push(path.resolve(dir, '../..'))
  }
  for (const root of roots) {
    ids.push(path.join(root, 'node_modules', 'sharp'))
    ids.push(
      path.join(root, 'dist', 'agent', 'runtime', 'node_modules', 'sharp'),
    )
    ids.push(path.join(root, 'runtime', 'node_modules', 'sharp'))
  }
  return [...new Set(ids)]
}

/**
 * Electron `ELECTRON_RUN_AS_NODE` uses a different NODE_MODULE_VERSION than
 * the Node that compiled `sharp.node`. sharp itself then falls through to
 * `@img/sharp-wasm32` when that package is installed.
 */
async function loadSharp(): Promise<SharpCtor | null> {
  if (process.env.BAIZE_DISABLE_SHARP === '1') return null
  if (cachedSharp !== undefined) return cachedSharp
  const errors: string[] = []

  for (const id of sharpModuleIds()) {
    for (const anchor of requireAnchors()) {
      try {
        const impl = unwrapSharp(createRequire(anchor)(id))
        if (impl) {
          cachedSharp = impl
          return impl
        }
      } catch (err) {
        errors.push(
          err instanceof Error ? err.message.split('\n')[0]! : String(err),
        )
      }
    }
  }

  try {
    const impl = unwrapSharp(await import('sharp'))
    if (impl) {
      cachedSharp = impl
      return impl
    }
  } catch (err) {
    errors.push(
      err instanceof Error ? err.message.split('\n')[0]! : String(err),
    )
  }

  sharpLoadError = errors.find(Boolean) ?? 'sharp module not found'
  cachedSharp = null
  return null
}

function openImage(sharp: SharpCtor, buffer: Buffer) {
  // Phone / WeChat JPEGs are often truncated or EXIF-rotated.
  return sharp(buffer, { failOn: 'none' }).rotate()
}

function base64Length(byteLength: number): number {
  return Math.ceil(byteLength / 3) * 4
}

export function estimateImageTokens(base64: string): number {
  return Math.ceil(base64.length * TOKENS_PER_BASE64_CHAR)
}

async function compressToBytes(
  buffer: Buffer,
  maxBytes: number,
  mediaType: ImageMediaType,
  options?: { preferLossless?: boolean },
): Promise<{ buffer: Buffer; mediaType: ImageMediaType } | null> {
  const sharp = await loadSharp()
  if (!sharp) return jsCompressToJpeg(buffer, maxBytes)

  const metadata = await openImage(sharp, buffer).metadata()
  const sourceWidth = metadata.width || IMAGE_MAX_WIDTH
  const sourceHeight = metadata.height || IMAGE_MAX_HEIGHT
  const boxes = [
    { width: sourceWidth, height: sourceHeight },
    ...RESIZE_BOX_LADDER.filter(
      size => size < sourceWidth || size < sourceHeight,
    ).map(size => ({ width: size, height: size })),
  ]

  for (const box of boxes) {
    const pipeline = () => {
      const image = openImage(sharp, buffer)
      const needsResize = box.width < sourceWidth || box.height < sourceHeight
      return needsResize
        ? image.resize(box.width, box.height, {
            fit: 'inside',
            withoutEnlargement: true,
          })
        : image
    }

    // Charts and diagrams retain labels/lines better as palette PNG. Retry
    // after each downscale before falling back to lossy JPEG.
    if (mediaType === 'image/png' && options?.preferLossless) {
      const palette = await pipeline()
        .png({ palette: true, compressionLevel: 9 })
        .toBuffer()
      if (palette.length <= maxBytes) {
        return { buffer: palette, mediaType: 'image/png' }
      }
    }

    for (const quality of JPEG_QUALITY_LADDER) {
      const jpeg = await pipeline()
        .flatten({ background: '#ffffff' })
        .jpeg({ quality })
        .toBuffer()
      if (jpeg.length <= maxBytes) {
        return { buffer: jpeg, mediaType: 'image/jpeg' }
      }
    }
  }
  return null
}

function magicKind(buffer: Buffer): 'jpeg' | 'png' | null {
  if (
    buffer.length >= 3 &&
    buffer[0] === 0xff &&
    buffer[1] === 0xd8 &&
    buffer[2] === 0xff
  ) {
    return 'jpeg'
  }
  if (
    buffer.length >= 8 &&
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47
  ) {
    return 'png'
  }
  return null
}

function fitInside(
  sourceWidth: number,
  sourceHeight: number,
  box: number,
): { width: number; height: number } {
  if (sourceWidth <= box && sourceHeight <= box) {
    return { width: sourceWidth, height: sourceHeight }
  }
  const scale = Math.min(box / sourceWidth, box / sourceHeight)
  return {
    width: Math.max(1, Math.round(sourceWidth * scale)),
    height: Math.max(1, Math.round(sourceHeight * scale)),
  }
}

function resizeRgba(
  src: Buffer,
  sourceWidth: number,
  sourceHeight: number,
  destWidth: number,
  destHeight: number,
): Buffer {
  if (sourceWidth === destWidth && sourceHeight === destHeight) return src
  const out = Buffer.alloc(destWidth * destHeight * 4)
  for (let y = 0; y < destHeight; y++) {
    const sy = Math.min(
      sourceHeight - 1,
      Math.floor(((y + 0.5) * sourceHeight) / destHeight),
    )
    for (let x = 0; x < destWidth; x++) {
      const sx = Math.min(
        sourceWidth - 1,
        Math.floor(((x + 0.5) * sourceWidth) / destWidth),
      )
      const si = (sy * sourceWidth + sx) * 4
      const di = (y * destWidth + x) * 4
      out[di] = src[si]!
      out[di + 1] = src[si + 1]!
      out[di + 2] = src[si + 2]!
      out[di + 3] = src[si + 3]!
    }
  }
  return out
}

async function decodeRgba(
  buffer: Buffer,
): Promise<{ data: Buffer; width: number; height: number } | null> {
  const kind = magicKind(buffer)
  try {
    if (kind === 'jpeg' || kind === null) {
      const jpeg = await import('jpeg-js')
      try {
        const raw = jpeg.decode(buffer, {
          maxMemoryUsageInMB: 512,
          formatAsRGBA: true,
        })
        return { data: raw.data, width: raw.width, height: raw.height }
      } catch {
        if (kind === 'jpeg') return null
      }
    }
    if (kind === 'png' || kind === null) {
      // Static import so esbuild inlines pngjs into the packaged agent
      // (createRequire('pngjs') stays external and is missing from desktop).
      const PNG = unwrapPng(
        // @ts-expect-error pngjs 7 ships no types
        await import('pngjs'),
      )
      if (!PNG) return null
      const png = PNG.sync.read(buffer)
      return {
        data: png.data,
        width: png.width,
        height: png.height,
      }
    }
  } catch {
    return null
  }
  return null
}

/** Pure JS path used when sharp's native addon cannot load (Electron ABI). */
async function jsCompressToJpeg(
  buffer: Buffer,
  maxBytes: number,
): Promise<{ buffer: Buffer; mediaType: 'image/jpeg' } | null> {
  const decoded = await decodeRgba(buffer)
  if (!decoded) return null
  const jpeg = await import('jpeg-js')
  const scaled = (box: number) => {
    const { width, height } = fitInside(decoded.width, decoded.height, box)
    const data = resizeRgba(
      decoded.data,
      decoded.width,
      decoded.height,
      width,
      height,
    )
    return { data, width, height }
  }
  const boxes = [
    Math.max(decoded.width, decoded.height),
    ...RESIZE_BOX_LADDER,
    LAST_RESORT_BOX,
  ]
  const qualities = [...JPEG_QUALITY_LADDER, 10]
  // The smallest candidate first: when it does not fit, none will, and the
  // ladder costs seconds on a screenshot.
  if (jpeg.encode(scaled(LAST_RESORT_BOX), 10).data.length > maxBytes) {
    return null
  }
  for (const box of boxes) {
    const frame = scaled(box)
    for (const quality of qualities) {
      const encoded = jpeg.encode(frame, quality)
      if (encoded.data.length <= maxBytes) {
        return { buffer: encoded.data, mediaType: 'image/jpeg' }
      }
    }
  }
  return null
}

/** The smallest JPEG `compressToBytes` can reach with sharp; null without it. */
async function smallestSharpJpeg(buffer: Buffer): Promise<Buffer | null> {
  const sharp = await loadSharp()
  if (!sharp) return null
  return openImage(sharp, buffer)
    .resize(LAST_RESORT_BOX, LAST_RESORT_BOX, {
      fit: 'inside',
      withoutEnlargement: true,
    })
    .flatten({ background: '#ffffff' })
    .jpeg({ quality: 20 })
    .toBuffer()
}

/** Last-resort JPEG small enough for a token budget (tall 水单 / noisy scans). */
async function lastResortJpeg(
  buffer: Buffer,
  maxBytes: number,
): Promise<{ buffer: Buffer; mediaType: 'image/jpeg' } | null> {
  const jpeg = await smallestSharpJpeg(buffer)
  if (jpeg && jpeg.length <= maxBytes) {
    return { buffer: jpeg, mediaType: 'image/jpeg' }
  }
  return jsCompressToJpeg(buffer, maxBytes)
}

/** Last-ditch preview when the token-budget path still throws. */
export async function encodeTinyJpeg(buffer: Buffer): Promise<{
  buffer: Buffer
  mediaType: 'image/jpeg'
}> {
  const result = await lastResortJpeg(buffer, Number.POSITIVE_INFINITY)
  if (!result) {
    throw new ImageResizeError(
      'Unable to encode a tiny JPEG preview. Native image codec (sharp) is unavailable or the file is not a readable image.',
    )
  }
  return result
}

export function fitsApiImageLimit(buffer: Buffer): boolean {
  return (
    buffer.length > 0 &&
    base64Length(buffer.length) <= API_IMAGE_MAX_BASE64_SIZE
  )
}

/**
 * When compression fails, still give the model an image: tiny JPEG first,
 * then the original bytes if they fit the 5MB API cap.
 */
export async function fallbackImageForModel(
  buffer: Buffer,
  mediaType: ImageMediaType,
): Promise<{ buffer: Buffer; mediaType: ImageMediaType }> {
  try {
    return await encodeTinyJpeg(buffer)
  } catch {
    if (fitsApiImageLimit(buffer)) {
      return { buffer, mediaType }
    }
    throw new ImageResizeError(
      'Unable to compress image, and the original exceeds the 5MB API limit.',
    )
  }
}

/**
 * Bring a buffer under the API's 5MB base64 / 2000px limits. Returns the
 * input untouched when it already fits.
 */
export async function maybeResizeAndDownsampleImageBuffer(
  buffer: Buffer,
  mediaType: ImageMediaType,
  options?: { maxWidth?: number; maxHeight?: number },
): Promise<{ buffer: Buffer; mediaType: ImageMediaType }> {
  if (buffer.length === 0) {
    throw new ImageResizeError('Image is empty (0 bytes)')
  }

  const sharp = await loadSharp()
  if (!sharp) {
    const js = await jsCompressToJpeg(buffer, IMAGE_TARGET_RAW_SIZE)
    if (js) return js
    if (base64Length(buffer.length) <= API_IMAGE_MAX_BASE64_SIZE) {
      return { buffer, mediaType }
    }
    throw new ImageResizeError(
      `Image is ${(buffer.length / 1024 / 1024).toFixed(1)}MB and exceeds the ${
        API_IMAGE_MAX_BASE64_SIZE / 1024 / 1024
      }MB API limit. Native image codec (sharp) is unavailable.`,
    )
  }

  const metadata = await openImage(sharp, buffer).metadata()
  const withinBytes = buffer.length <= IMAGE_TARGET_RAW_SIZE
  const maxWidth = options?.maxWidth ?? IMAGE_MAX_WIDTH
  const maxHeight = options?.maxHeight ?? IMAGE_MAX_HEIGHT
  const withinDims =
    (metadata.width || 0) <= maxWidth && (metadata.height || 0) <= maxHeight
  if (withinBytes && withinDims) {
    return { buffer, mediaType }
  }

  let working = buffer
  const workingMediaType = mediaType

  if (!withinDims) {
    working = await openImage(sharp, buffer)
      .resize(maxWidth, maxHeight, {
        fit: 'inside',
        withoutEnlargement: true,
      })
      .toBuffer()
  }

  if (working.length <= IMAGE_TARGET_RAW_SIZE) {
    return { buffer: working, mediaType: workingMediaType }
  }

  const compressed = await compressToBytes(
    working,
    IMAGE_TARGET_RAW_SIZE,
    workingMediaType,
  )
  if (compressed) return compressed

  const shrunk = await lastResortJpeg(working, IMAGE_TARGET_RAW_SIZE)
  if (
    shrunk &&
    base64Length(shrunk.buffer.length) <= API_IMAGE_MAX_BASE64_SIZE
  ) {
    return shrunk
  }

  throw new ImageResizeError(
    `Unable to compress image below the ${
      API_IMAGE_MAX_BASE64_SIZE / 1024 / 1024
    }MB API limit. Produce a smaller image.`,
  )
}

/** Compress a buffer to a budget expressed in model tokens. */
export async function compressImageBufferWithTokenLimit(
  buffer: Buffer,
  maxTokens: number,
  mediaType: ImageMediaType,
  options?: { preferLossless?: boolean; strict?: boolean },
): Promise<{ buffer: Buffer; mediaType: ImageMediaType }> {
  if (!Number.isFinite(maxTokens) || maxTokens <= 0) {
    throw new ImageResizeError(`Invalid image token budget: ${maxTokens}`)
  }
  const maxBase64Chars = Math.floor(maxTokens / TOKENS_PER_BASE64_CHAR)
  const maxBytes = Math.floor(maxBase64Chars * 0.75)
  if (buffer.length <= maxBytes) return { buffer, mediaType }

  const compressed = await compressToBytes(buffer, maxBytes, mediaType, options)
  if (compressed) return compressed
  const fallback = await lastResortJpeg(buffer, maxBytes)
  if (fallback) return fallback
  if (!options?.strict) return { buffer, mediaType }
  const codecHint = (await loadSharp())
    ? ''
    : `; native image codec (sharp) is unavailable${
        sharpLoadError ? ` (${sharpLoadError.slice(0, 180)})` : ''
      }`
  throw new ImageResizeError(
    `Unable to compress image below ${maxTokens} estimated tokens (${maxBytes} bytes)${codecHint}`,
  )
}

/** Compress a buffer to at most `maxBytes`. Throws when it cannot. */
export async function compressImageBufferToBytes(
  buffer: Buffer,
  maxBytes: number,
  mediaType: ImageMediaType,
): Promise<{ buffer: Buffer; mediaType: ImageMediaType }> {
  if (buffer.length <= maxBytes) return { buffer, mediaType }
  const tooLarge = () =>
    new ImageResizeError(`Unable to compress image below ${maxBytes} bytes`)

  // When even the smallest JPEG is too large, walking the whole ladder costs
  // seconds per image for nothing.
  const smallest = await smallestSharpJpeg(buffer)
  if (smallest && smallest.length > maxBytes) throw tooLarge()

  const result = await compressToBytes(buffer, maxBytes, mediaType)
  if (result) return result
  if (smallest) return { buffer: smallest, mediaType: 'image/jpeg' }
  throw tooLarge()
}

/**
 * Convenience for tools that produce an image: resize, optionally fit a token
 * budget, and return the block to embed in `tool_result.content`.
 */
export async function toolResultImageBlockFromBuffer(
  buffer: Buffer,
  mediaType: ImageMediaType,
  options?: {
    maxTokens?: number
    maxWidth?: number
    maxHeight?: number
    preferLossless?: boolean
    strictBudget?: boolean
  },
): Promise<ImageBlockParam> {
  try {
    let result = await maybeResizeAndDownsampleImageBuffer(buffer, mediaType, {
      maxWidth: options?.maxWidth,
      maxHeight: options?.maxHeight,
    })
    if (options?.maxTokens !== undefined) {
      result = await compressImageBufferWithTokenLimit(
        result.buffer,
        options.maxTokens,
        result.mediaType,
        {
          preferLossless: options.preferLossless,
          strict: options.strictBudget,
        },
      )
    }
    return buildImageBlock(result.buffer.toString('base64'), result.mediaType)
  } catch (err) {
    if (!isImageResizeError(err)) throw err
    const fallback = await fallbackImageForModel(buffer, mediaType)
    return buildImageBlock(
      fallback.buffer.toString('base64'),
      fallback.mediaType,
    )
  }
}
