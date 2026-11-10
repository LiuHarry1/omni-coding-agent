import fs from 'node:fs'
import { tryLoadRuntimePackage } from './runtime-deps.mjs'

const fontkit = tryLoadRuntimePackage('fontkit')
const linebreak = tryLoadRuntimePackage('linebreak')
const skia = tryLoadRuntimePackage('skia-canvas')
const LineBreaker = linebreak?.LineBreaker
const Canvas = skia?.Canvas
const FontLibrary = skia?.FontLibrary

const canvas = Canvas ? new Canvas(16, 16) : null
const context = canvas?.getContext('2d')
const registeredFonts = new Map()

function pointToPixel(points) {
  return (points * 96) / 72
}

function normalizeText(textOrRuns) {
  if (Array.isArray(textOrRuns)) {
    return textOrRuns.map(run => String(run?.text ?? '')).join('')
  }
  return String(textOrRuns ?? '')
}

export function registerFont(family, filePath) {
  if (!family || !filePath) throw new Error('registerFont requires family and filePath')
  if (!fs.existsSync(filePath)) throw new Error(`Font file not found: ${filePath}`)
  if (!fontkit || !FontLibrary) {
    throw new Error('Font registration requires fontkit and skia-canvas in the Baix runtime')
  }
  const font = fontkit.openSync(filePath)
  FontLibrary.use(family, [filePath])
  registeredFonts.set(family, {
    path: filePath,
    postscriptName: font.postscriptName,
  })
  return registeredFonts.get(family)
}

export function measureTextWidth(text, fontFace, fontSize, options = {}) {
  if (!context) {
    const weighted = [...String(text ?? '')].reduce(
      (sum, character) =>
        sum +
        (/[\u2E80-\u9FFF\uF900-\uFAFF\u3040-\u30FF]/u.test(character)
          ? 1
          : 0.54),
      0,
    )
    return (weighted * fontSize * 0.62) / 72
  }
  const style = options.italic ? 'italic ' : ''
  const weight = options.bold ? '700 ' : ''
  context.font = `${style}${weight}${pointToPixel(fontSize)}px "${fontFace}"`
  return context.measureText(String(text ?? '')).width / 96
}

function breakOpportunities(value) {
  if (!LineBreaker) {
    return [...value].map((_, index) => index + 1)
  }
  const positions = []
  const breaker = new LineBreaker(value)
  let next
  while ((next = breaker.nextBreak())) positions.push(next.position)
  if (positions.at(-1) !== value.length) positions.push(value.length)
  return positions
}

function wrapParagraph(paragraph, width, fontFace, fontSize, options) {
  if (!paragraph) return ['']
  const positions = breakOpportunities(paragraph)
  const lines = []
  let start = 0
  let lastFit = start
  for (const position of positions) {
    const candidate = paragraph.slice(start, position).trimEnd()
    if (measureTextWidth(candidate, fontFace, fontSize, options) <= width) {
      lastFit = position
      continue
    }
    if (lastFit > start) {
      lines.push(paragraph.slice(start, lastFit).trim())
      start = lastFit
      lastFit = start
      if (measureTextWidth(paragraph.slice(start, position).trim(), fontFace, fontSize, options) <= width) {
        lastFit = position
        continue
      }
    }
    let end = start
    for (const character of paragraph.slice(start, position)) {
      const nextEnd = end + character.length
      if (
        end > start &&
        measureTextWidth(paragraph.slice(start, nextEnd), fontFace, fontSize, options) > width
      ) {
        lines.push(paragraph.slice(start, end).trim())
        start = end
      }
      end = nextEnd
    }
    lastFit = end
  }
  if (start < paragraph.length) lines.push(paragraph.slice(start).trim())
  return lines.length ? lines : ['']
}

export function measureTextBlock(textOrRuns, options) {
  const {
    width,
    fontFace = 'Arial',
    fontSize = 18,
    margin = 0,
    lineSpacing = 1.2,
  } = options
  if (!Number.isFinite(width) || width <= 0) throw new Error('Text width must be positive')
  const usableWidth = Math.max(0.05, width - margin * 2)
  const value = normalizeText(textOrRuns)
  const lines = value
    .split(/\r?\n/u)
    .flatMap(paragraph => wrapParagraph(paragraph, usableWidth, fontFace, fontSize, options))
  return {
    text: value,
    lines,
    lineCount: Math.max(1, lines.length),
    height: Math.max(1, lines.length) * (fontSize / 72) * lineSpacing + margin * 2,
    maxLineWidth: lines.reduce(
      (maximum, line) =>
        Math.max(maximum, measureTextWidth(line, fontFace, fontSize, options)),
      0,
    ),
  }
}

export function fitText(textOrRuns, options) {
  const {
    width,
    height,
    fontFace = 'Arial',
    maxFontSize = 20,
    minFontSize = 14,
    step = 0.5,
    safety = 0.96,
  } = options
  if (!Number.isFinite(height) || height <= 0) throw new Error('Text height must be positive')
  for (let size = maxFontSize; size >= minFontSize; size -= step) {
    const measured = measureTextBlock(textOrRuns, {
      ...options,
      width,
      fontFace,
      fontSize: size,
    })
    if (measured.height <= height * safety && measured.maxLineWidth <= width) {
      return { size, ...measured, overflow: false }
    }
  }
  const measured = measureTextBlock(textOrRuns, {
    ...options,
    width,
    fontFace,
    fontSize: minFontSize,
  })
  return { size: minFontSize, ...measured, overflow: true }
}
