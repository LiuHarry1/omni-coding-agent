import fs from 'node:fs/promises'
import { loadRuntimePackage } from './runtime-deps.mjs'

const sharp = loadRuntimePackage('sharp')

function decodeDataUri(value) {
  const match = /^data:([^;,]+)?(?:;base64)?,(.*)$/su.exec(value)
  if (!match) return null
  return match[0].includes(';base64,')
    ? Buffer.from(match[2], 'base64')
    : Buffer.from(decodeURIComponent(match[2]))
}

async function imageInput(source) {
  if (Buffer.isBuffer(source)) return source
  if (typeof source !== 'string') throw new Error('Image source must be a path, Buffer, or data URI')
  const decoded = decodeDataUri(source)
  if (decoded) return decoded
  await fs.access(source)
  return source
}

export async function getImageDimensions(source) {
  const input = await imageInput(source)
  const metadata = await sharp(input, { animated: true }).metadata()
  if (!metadata.width || !metadata.height) {
    throw new Error(`Cannot determine image dimensions: ${String(source).slice(0, 120)}`)
  }
  return {
    width: metadata.width,
    height: metadata.height,
    format: metadata.format ?? 'unknown',
    aspectRatio: metadata.width / metadata.height,
    pages: metadata.pages ?? 1,
  }
}

export async function imageSizingContain(source, box) {
  await getImageDimensions(source)
  return { ...box, sizing: { type: 'contain', w: box.w, h: box.h } }
}

export async function imageSizingCrop(source, box) {
  await getImageDimensions(source)
  return { ...box, sizing: { type: 'cover', w: box.w, h: box.h } }
}

export async function imageSizing(source, box, fit = 'contain') {
  if (!['contain', 'crop'].includes(fit)) throw new Error(`Unsupported image fit: ${fit}`)
  return fit === 'crop'
    ? imageSizingCrop(source, box)
    : imageSizingContain(source, box)
}

export function svgToDataUri(svg) {
  const value = String(svg ?? '').trim()
  if (!value.startsWith('<svg')) throw new Error('svgToDataUri requires an <svg> document')
  return `data:image/svg+xml;base64,${Buffer.from(value).toString('base64')}`
}
