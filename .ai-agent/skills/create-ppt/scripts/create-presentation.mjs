#!/usr/bin/env node

import fs from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import {
  configureAdvantestPresentation,
  loadAdvantestAssets,
} from './lib/brand.mjs'
import { normalizeSpec } from './lib/spec.mjs'
import { loadRuntimePackage } from './lib/runtime-deps.mjs'
import { appendSlideObjectQa } from './lib/slide-qa.mjs'
import {
  ACCENTS,
  COLORS,
  GRID,
  PAGE,
  addNotes,
  addSlideTitle,
  addSource,
  addTrackedShape,
  addTrackedText,
  checkCollisions,
  createQa,
  fitFontSize,
  fontFor,
  imageSizing,
  recordBox,
  slideContext,
  textRunsForBullets,
} from './lib/design.mjs'

const pptxgen = loadRuntimePackage('pptxgenjs')

function usage() {
  throw new Error(
    'Usage: node create-presentation.mjs <spec.json> <output.pptx> [--qa <manifest.json>]',
  )
}

function parseArgs(argv) {
  if (argv.length < 2) usage()
  const qaIndex = argv.indexOf('--qa')
  return {
    specPath: path.resolve(argv[0]),
    outputPath: path.resolve(argv[1]),
    qaPath:
      qaIndex >= 0 && argv[qaIndex + 1]
        ? path.resolve(argv[qaIndex + 1])
        : path.resolve(`${argv[1]}.qa.json`),
  }
}

function addBackground(slide, context, pptx, color = COLORS.white) {
  addTrackedShape(
    slide,
    context,
    'background',
    pptx.ShapeType.rect,
    { x: 0, y: 0, w: PAGE.width, h: PAGE.height },
    { fill: { color }, line: { color, transparency: 100 }, qa: { role: 'background' } },
  )
}

function addContentRule(slide, context, pptx) {
  addTrackedShape(
    slide,
    context,
    'title-rule',
    pptx.ShapeType.line,
    { x: GRID.left, y: 1.29, w: 11.9, h: 0 },
    { line: { color: COLORS.line, width: 1 }, qa: { role: 'decoration' } },
  )
}

function addFooter(slide, context, spec, item, fontFace) {
  addSource(slide, context, item.source, fontFace)
  addTrackedText(
    slide,
    context,
    'deck-footer',
    spec.title,
    { x: 9.4, y: 7.14, w: 3.2, h: 0.18 },
    {
      fontFace,
      fontSize: 7.5,
      color: COLORS.muted,
      align: 'right',
      valign: 'top',
      qa: { role: 'footer' },
    },
  )
}

function addWordmark(slide, context, pptx, fontFace, options = {}) {
  const location = options.location ?? 'footer'
  const box =
    location === 'top'
      ? { x: 0.72, y: 0.42, w: 1.5, h: 0.28 }
      : { x: 0.28, y: 7.14, w: 1.25, h: 0.18 }
  addTrackedText(slide, context, `wordmark-${location}`, 'ADVANTEST.', box, {
    fontFace,
    fontSize: location === 'top' ? 10.5 : 7.5,
    bold: true,
    italic: true,
    color: COLORS.magenta,
    valign: 'top',
    qa: { role: 'decoration' },
  })
  if (location === 'footer') {
    addTrackedShape(
      slide,
      context,
      'brand-baseline',
      pptx.ShapeType.line,
      { x: 0, y: 7.44, w: PAGE.width, h: 0 },
      {
        line: { color: COLORS.magenta, width: 1.4 },
        qa: { role: 'decoration' },
      },
    )
  }
}

function contentSlide(pptx, spec, item, qa, fontFace) {
  const slide = pptx.addSlide('ADVANTEST_CONTENT')
  const context = slideContext(qa, item.type, item.title)
  addBackground(slide, context, pptx)
  addWordmark(slide, context, pptx, fontFace)
  addSlideTitle(slide, context, item.title, fontFace)
  addContentRule(slide, context, pptx)
  addFooter(slide, context, spec, item, fontFace)
  addNotes(slide, item)
  return { slide, context }
}

function coverSlide(pptx, spec, qa, fontFace, brand) {
  const slide = pptx.addSlide()
  const context = slideContext(qa, 'cover', spec.title)
  slide.addImage({
    data: brand.coverBackground,
    x: 0,
    y: 0,
    w: PAGE.width,
    h: PAGE.height,
  })
  recordBox(
    context,
    'cover-background',
    { x: 0, y: 0, w: PAGE.width, h: PAGE.height },
    { role: 'background' },
  )
  addWordmark(slide, context, pptx, fontFace, { location: 'top' })
  addTrackedText(
    slide,
    context,
    'cover-kicker',
    spec.audience.toUpperCase(),
    { x: 0.75, y: 1.72, w: 3.8, h: 0.35 },
    {
      fontFace,
      fontSize: 10,
      bold: true,
      color: COLORS.teal,
      charSpacing: 1.4,
    },
  )
  const titleBox = { x: 0.75, y: 2.18, w: 5.65, h: 1.78 }
  const fitted = fitFontSize(spec.title, titleBox.w, titleBox.h, {
    max: 36,
    min: 28,
  })
  addTrackedText(slide, context, 'cover-title', spec.title, titleBox, {
    fontFace,
    fontSize: fitted.size,
    bold: true,
    color: COLORS.magenta,
    valign: 'mid',
  })
  if (fitted.overflow) context.warnings.push('cover title may overflow')
  if (spec.subtitle) {
    addTrackedText(
      slide,
      context,
      'cover-subtitle',
      spec.subtitle,
      { x: 0.78, y: 4.2, w: 5.35, h: 0.72 },
      { fontFace, fontSize: 14, color: COLORS.charcoal, valign: 'top' },
    )
  }
  const byline = [spec.author, spec.objective].filter(Boolean).join(' · ')
  if (byline) {
    addTrackedText(
      slide,
      context,
      'cover-byline',
      byline,
      { x: 0.78, y: 6.45, w: 5.4, h: 0.42 },
      { fontFace, fontSize: 10.5, color: COLORS.muted, valign: 'top' },
    )
  }
  checkCollisions(context)
}

function renderContent(pptx, spec, item, qa, fontFace) {
  const { slide, context } = contentSlide(pptx, spec, item, qa, fontFace)
  const bulletBox = { x: 0.82, y: 1.72, w: 7.35, h: 4.7 }
  const bulletText = item.bullets.join('\n')
  const fitted = fitFontSize(bulletText, bulletBox.w, bulletBox.h, {
    max: 18,
    min: 14,
  })
  slide.addText(textRunsForBullets(item.bullets, { fontFace, fontSize: fitted.size }), {
    ...bulletBox,
    margin: 0.08,
    valign: 'top',
  })
  recordBox(context, 'bullets', bulletBox, {
    role: 'flow',
    collisionGroup: 'main',
  })
  if (fitted.overflow) context.errors.push('content bullets exceed text capacity')
  const calloutBox = { x: 8.55, y: 1.72, w: 3.78, h: 4.7 }
  addTrackedShape(slide, context, 'callout-panel', pptx.ShapeType.roundRect, calloutBox, {
    rectRadius: 0.08,
    fill: { color: COLORS.pale },
    line: { color: COLORS.teal, width: 1.2 },
    qa: { role: 'flow', collisionGroup: 'main' },
  })
  addTrackedText(
    slide,
    context,
    'callout-label',
    item.callout || 'KEY TAKEAWAY',
    { x: 8.88, y: 2.05, w: 3.1, h: 0.35 },
    { fontFace, fontSize: 9.5, bold: true, color: COLORS.orange },
  )
  const takeawayFit = fitFontSize(item.takeaway, 3.1, 2.4, {
    max: 23,
    min: 16,
  })
  addTrackedText(
    slide,
    context,
    'takeaway',
    item.takeaway,
    { x: 8.88, y: 2.55, w: 3.1, h: 2.4 },
    {
      fontFace,
      fontSize: takeawayFit.size,
      bold: true,
      color: COLORS.charcoal,
      valign: 'mid',
    },
  )
  if (takeawayFit.overflow) context.errors.push('takeaway exceeds callout capacity')
  checkCollisions(context)
}

function renderTwoColumn(pptx, spec, item, qa, fontFace) {
  const { slide, context } = contentSlide(pptx, spec, item, qa, fontFace)
  const columns = [
    { data: item.left, x: 0.82, color: COLORS.teal },
    { data: item.right, x: 6.85, color: COLORS.orange },
  ]
  for (const [index, column] of columns.entries()) {
    const box = { x: column.x, y: 1.7, w: 5.65, h: 4.76 }
    addTrackedShape(slide, context, `column-${index + 1}`, pptx.ShapeType.roundRect, box, {
      rectRadius: 0.06,
      fill: { color: COLORS.pale },
      line: { color: column.color, width: 1.3 },
      qa: { role: 'flow', collisionGroup: 'columns' },
    })
    addTrackedText(
      slide,
      context,
      `column-heading-${index + 1}`,
      column.data.heading,
      { x: box.x + 0.3, y: box.y + 0.3, w: box.w - 0.6, h: 0.55 },
      { fontFace, fontSize: 20, bold: true, color: column.color },
    )
    const bulletBox = {
      x: box.x + 0.3,
      y: box.y + 1.05,
      w: box.w - 0.6,
      h: box.h - 1.38,
    }
    const fitted = fitFontSize(column.data.bullets.join('\n'), bulletBox.w, bulletBox.h, {
      max: 17,
      min: 14,
    })
    slide.addText(
      textRunsForBullets(column.data.bullets, {
        fontFace,
        fontSize: fitted.size,
      }),
      { ...bulletBox, margin: 0.06, valign: 'top' },
    )
    recordBox(context, `column-bullets-${index + 1}`, bulletBox)
    if (fitted.overflow) context.errors.push(`column ${index + 1} exceeds text capacity`)
  }
  checkCollisions(context)
}

function renderCards(pptx, spec, item, qa, fontFace) {
  const { slide, context } = contentSlide(pptx, spec, item, qa, fontFace)
  const count = item.cards.length
  const cols = count === 4 ? 2 : count
  const rows = count === 4 ? 2 : 1
  const gap = 0.28
  const area = { x: 0.82, y: 1.62, w: 11.7, h: 4.92 }
  const width = (area.w - gap * (cols - 1)) / cols
  const height = (area.h - gap * (rows - 1)) / rows
  item.cards.forEach((card, index) => {
    const row = Math.floor(index / cols)
    const col = index % cols
    const box = {
      x: area.x + col * (width + gap),
      y: area.y + row * (height + gap),
      w: width,
      h: height,
    }
    const color = ACCENTS[index]
    addTrackedShape(slide, context, `card-${index + 1}`, pptx.ShapeType.roundRect, box, {
      rectRadius: 0.06,
      fill: { color: COLORS.offWhite },
      line: { color: COLORS.line, width: 0.8 },
      shadow: { type: 'outer', color: 'B8C1C5', opacity: 0.16, blur: 1.2, angle: 45, offset: 1 },
      qa: { role: 'flow', collisionGroup: 'cards' },
    })
    addTrackedText(
      slide,
      context,
      `card-number-${index + 1}`,
      String(index + 1).padStart(2, '0'),
      { x: box.x + 0.25, y: box.y + 0.22, w: 0.55, h: 0.35 },
      { fontFace, fontSize: 10, bold: true, color },
    )
    addTrackedText(
      slide,
      context,
      `card-heading-${index + 1}`,
      card.heading,
      { x: box.x + 0.25, y: box.y + 0.68, w: box.w - 0.5, h: 0.58 },
      {
        fontFace,
        fontSize: rows === 1 ? 19 : 16,
        bold: true,
        color: COLORS.charcoal,
      },
    )
    const bodyBox = {
      x: box.x + 0.25,
      y: box.y + 1.38,
      w: box.w - 0.5,
      h: box.h - 1.62,
    }
    const fitted = fitFontSize(card.body, bodyBox.w, bodyBox.h, {
      max: rows === 1 ? 15 : 13,
      min: 11,
    })
    addTrackedText(slide, context, `card-body-${index + 1}`, card.body, bodyBox, {
      fontFace,
      fontSize: fitted.size,
      color: COLORS.muted,
      valign: 'top',
    })
    if (fitted.overflow) context.errors.push(`card ${index + 1} exceeds text capacity`)
  })
  checkCollisions(context)
}

function renderProcess(pptx, spec, item, qa, fontFace) {
  const { slide, context } = contentSlide(pptx, spec, item, qa, fontFace)
  const count = item.steps.length
  const startX = 1.15
  const endX = 12.15
  const centerY = 3.32
  const spacing = (endX - startX) / Math.max(1, count - 1)
  addTrackedShape(
    slide,
    context,
    'process-line',
    pptx.ShapeType.line,
    { x: startX, y: centerY, w: endX - startX, h: 0 },
    { line: { color: COLORS.line, width: 2 }, qa: { role: 'decoration' } },
  )
  item.steps.forEach((step, index) => {
    const centerX = startX + index * spacing
    const color = ACCENTS[index]
    addTrackedShape(
      slide,
      context,
      `step-dot-${index + 1}`,
      pptx.ShapeType.ellipse,
      { x: centerX - 0.33, y: centerY - 0.33, w: 0.66, h: 0.66 },
      {
        fill: { color },
        line: { color, transparency: 100 },
        qa: { role: 'decoration' },
      },
    )
    addTrackedText(
      slide,
      context,
      `step-number-${index + 1}`,
      String(index + 1),
      { x: centerX - 0.33, y: centerY - 0.33, w: 0.66, h: 0.66 },
      { fontFace, fontSize: 14, bold: true, color: COLORS.white, align: 'center' },
    )
    const itemWidth = Math.min(2.15, spacing * 0.82)
    const x = centerX - itemWidth / 2
    addTrackedText(
      slide,
      context,
      `step-title-${index + 1}`,
      step.title,
      { x, y: 2.0, w: itemWidth, h: 0.62 },
      {
        fontFace,
        fontSize: 14,
        bold: true,
        color: COLORS.charcoal,
        align: 'center',
      },
    )
    const detailFit = fitFontSize(step.detail, itemWidth, 1.15, {
      max: 12,
      min: 10,
    })
    addTrackedText(
      slide,
      context,
      `step-detail-${index + 1}`,
      step.detail,
      { x, y: 4.0, w: itemWidth, h: 1.15 },
      {
        fontFace,
        fontSize: detailFit.size,
        color: COLORS.muted,
        align: 'center',
        valign: 'top',
      },
    )
    if (detailFit.overflow) context.errors.push(`step ${index + 1} exceeds text capacity`)
  })
  checkCollisions(context)
}

function renderMetrics(pptx, spec, item, qa, fontFace) {
  const { slide, context } = contentSlide(pptx, spec, item, qa, fontFace)
  const gap = 0.24
  const width = (11.7 - gap * (item.metrics.length - 1)) / item.metrics.length
  item.metrics.forEach((metric, index) => {
    const box = { x: 0.82 + index * (width + gap), y: 1.75, w: width, h: 4.55 }
    const color = ACCENTS[index]
    addTrackedShape(slide, context, `metric-${index + 1}`, pptx.ShapeType.roundRect, box, {
      rectRadius: 0.05,
      fill: { color: COLORS.pale },
      line: { color, width: 1.2 },
      qa: { role: 'flow', collisionGroup: 'metrics' },
    })
    addTrackedText(
      slide,
      context,
      `metric-value-${index + 1}`,
      metric.value,
      { x: box.x + 0.2, y: 2.1, w: box.w - 0.4, h: 0.95 },
      { fontFace, fontSize: 31, bold: true, color, align: 'center' },
    )
    addTrackedText(
      slide,
      context,
      `metric-label-${index + 1}`,
      metric.label,
      { x: box.x + 0.25, y: 3.28, w: box.w - 0.5, h: 0.95 },
      {
        fontFace,
        fontSize: 16,
        bold: true,
        color: COLORS.charcoal,
        align: 'center',
      },
    )
    addTrackedText(
      slide,
      context,
      `metric-detail-${index + 1}`,
      metric.detail,
      { x: box.x + 0.25, y: 4.65, w: box.w - 0.5, h: 0.65 },
      { fontFace, fontSize: 11, color: COLORS.muted, align: 'center' },
    )
  })
  checkCollisions(context)
}

function renderChart(pptx, spec, item, qa, fontFace) {
  const { slide, context } = contentSlide(pptx, spec, item, qa, fontFace)
  const chartBox = { x: 0.88, y: 1.55, w: 11.35, h: 4.95 }
  const type = item.chart_kind === 'line' ? pptx.ChartType.line : item.chart_kind === 'pie' ? pptx.ChartType.pie : pptx.ChartType.bar
  const data = item.series.map(series => ({
    name: series.name,
    labels: item.categories,
    values: series.values,
  }))
  slide.addChart(type, data, {
    ...chartBox,
    catAxisLabelFontFace: fontFace,
    catAxisLabelFontSize: 10,
    valAxisLabelFontFace: fontFace,
    valAxisLabelFontSize: 9,
    chartColors: ACCENTS,
    showLegend: item.series.length > 1 || item.chart_kind === 'pie',
    legendPos: 'b',
    showTitle: false,
    showCatName: item.chart_kind === 'pie',
    showPercent: item.chart_kind === 'pie',
    showLeaderLines: item.chart_kind === 'pie',
    showBorder: false,
    showValAxisTitle: Boolean(item.unit),
    valAxisTitle: item.unit,
    valGridLine: { color: COLORS.line, width: 1 },
    catGridLine: { color: COLORS.white, transparency: 100 },
    showValue: item.chart_kind !== 'line' && item.categories.length <= 6,
    ...(item.chart_kind === 'bar' || item.chart_kind === 'column'
      ? { dataLabelPosition: 'outEnd' }
      : {}),
    ...(item.chart_kind === 'bar' ? { barDir: 'bar' } : {}),
    ...(item.chart_kind === 'column' ? { barDir: 'col' } : {}),
  })
  recordBox(context, 'chart', chartBox, { role: 'flow', collisionGroup: 'main' })
  checkCollisions(context)
}

function renderTable(pptx, spec, item, qa, fontFace) {
  const { slide, context } = contentSlide(pptx, spec, item, qa, fontFace)
  const rows = [
    item.columns.map(text => ({
      text,
      options: { bold: true, color: COLORS.white, fill: COLORS.teal },
    })),
    ...item.rows.map((row, index) =>
      row.map(text => ({
        text,
        options: {
          color: COLORS.charcoal,
          fill: index % 2 === 0 ? COLORS.pale : COLORS.white,
        },
      })),
    ),
  ]
  const box = { x: 0.78, y: 1.58, w: 11.78, h: 4.95 }
  slide.addTable(rows, {
    ...box,
    border: { type: 'solid', color: COLORS.line, width: 0.7 },
    fontFace,
    fontSize: item.rows.length > 6 ? 10.5 : 12,
    color: COLORS.charcoal,
    margin: 0.08,
    valign: 'mid',
    rowH: Math.min(0.65, box.h / rows.length),
    autoFit: false,
  })
  recordBox(context, 'table', box, { role: 'flow', collisionGroup: 'main' })
  checkCollisions(context)
}

function renderQuote(pptx, spec, item, qa, fontFace) {
  const { slide, context } = contentSlide(pptx, spec, item, qa, fontFace)
  addTrackedShape(
    slide,
    context,
    'quote-mark',
    pptx.ShapeType.ellipse,
    { x: 0.9, y: 1.75, w: 1.05, h: 1.05 },
    {
      fill: { color: COLORS.magenta },
      line: { color: COLORS.magenta, transparency: 100 },
      qa: { role: 'decoration' },
    },
  )
  addTrackedText(
    slide,
    context,
    'quote-symbol',
    '“',
    { x: 0.9, y: 1.72, w: 1.05, h: 1.05 },
    { fontFace: 'Georgia', fontSize: 34, bold: true, color: COLORS.white, align: 'center' },
  )
  const quoteBox = { x: 2.35, y: 1.82, w: 9.35, h: 3.25 }
  const fitted = fitFontSize(item.quote, quoteBox.w, quoteBox.h, {
    max: 27,
    min: 18,
  })
  addTrackedText(slide, context, 'quote', item.quote, quoteBox, {
    fontFace,
    fontSize: fitted.size,
    bold: true,
    italic: true,
    color: COLORS.charcoal,
    valign: 'mid',
  })
  addTrackedText(
    slide,
    context,
    'attribution',
    `— ${item.attribution}`,
    { x: 6.7, y: 5.3, w: 5.0, h: 0.5 },
    { fontFace, fontSize: 13, bold: true, color: COLORS.teal, align: 'right' },
  )
  if (fitted.overflow) context.errors.push('quote exceeds text capacity')
  checkCollisions(context)
}

async function renderImage(pptx, spec, item, qa, fontFace, specDir) {
  const { slide, context } = contentSlide(pptx, spec, item, qa, fontFace)
  const sourcePath = path.isAbsolute(item.source_path)
    ? item.source_path
    : path.resolve(specDir, item.source_path)
  const box = { x: 1.0, y: 1.55, w: 11.3, h: 4.9 }
  const sizing = await imageSizing(sourcePath, box, item.fit)
  slide.addImage({ path: sourcePath, ...sizing })
  recordBox(context, 'image', box, { role: 'flow', collisionGroup: 'main' })
  if (item.caption) {
    addTrackedText(
      slide,
      context,
      'caption',
      item.caption,
      { x: 1.0, y: 6.5, w: 11.3, h: 0.26 },
      { fontFace, fontSize: 9, color: COLORS.muted, align: 'center', valign: 'top' },
    )
  }
  checkCollisions(context)
}

function renderSection(pptx, spec, item, qa, fontFace, brand) {
  const slide = pptx.addSlide()
  const context = slideContext(qa, item.type, item.title)
  slide.addImage({
    data: brand.sectionBackground,
    x: 0,
    y: 0,
    w: PAGE.width,
    h: PAGE.height,
  })
  recordBox(
    context,
    'section-background',
    { x: 0, y: 0, w: PAGE.width, h: PAGE.height },
    { role: 'background' },
  )
  addTrackedText(
    slide,
    context,
    'section-kicker',
    'SECTION',
    { x: 0.82, y: 3.55, w: 2.0, h: 0.34 },
    { fontFace, fontSize: 10, bold: true, color: COLORS.teal, charSpacing: 1.5 },
  )
  const fitted = fitFontSize(item.title, 10.8, 1.7, { max: 34, min: 26 })
  addTrackedText(
    slide,
    context,
    'section-title',
    item.title,
    { x: 0.82, y: 4.0, w: 9.8, h: 1.35 },
    { fontFace, fontSize: fitted.size, bold: true, color: COLORS.magenta },
  )
  if (item.subtitle) {
    addTrackedText(
      slide,
      context,
      'section-subtitle',
      item.subtitle,
      { x: 0.84, y: 5.45, w: 8.8, h: 0.62 },
      { fontFace, fontSize: 16, color: COLORS.charcoal },
    )
  }
  addTrackedText(
    slide,
    context,
    'section-wordmark',
    'ADVANTEST.',
    { x: 10.65, y: 6.85, w: 1.65, h: 0.3 },
    {
      fontFace,
      fontSize: 10,
      bold: true,
      italic: true,
      color: COLORS.magenta,
      align: 'right',
      qa: { role: 'decoration' },
    },
  )
  addNotes(slide, item)
  if (fitted.overflow) context.errors.push('section title exceeds text capacity')
  checkCollisions(context)
}

function renderSummary(pptx, spec, item, qa, fontFace) {
  const { slide, context } = contentSlide(pptx, spec, item, qa, fontFace)
  const bulletBox = { x: 0.92, y: 1.72, w: 7.25, h: 4.5 }
  const fitted = fitFontSize(item.bullets.join('\n'), bulletBox.w, bulletBox.h, {
    max: 18,
    min: 14,
  })
  slide.addText(textRunsForBullets(item.bullets, { fontFace, fontSize: fitted.size }), {
    ...bulletBox,
    margin: 0.08,
    valign: 'top',
  })
  recordBox(context, 'next-steps', bulletBox, {
    role: 'flow',
    collisionGroup: 'summary',
  })
  const decisionBox = { x: 8.55, y: 1.72, w: 3.75, h: 4.5 }
  addTrackedShape(slide, context, 'decision-panel', pptx.ShapeType.roundRect, decisionBox, {
    fill: { color: COLORS.teal },
    line: { color: COLORS.teal, transparency: 100 },
    qa: { role: 'flow', collisionGroup: 'summary' },
  })
  addTrackedText(
    slide,
    context,
    'decision-label',
    item.closing || 'NEXT DECISION',
    { x: 8.9, y: 2.1, w: 3.05, h: 0.45 },
    { fontFace, fontSize: 10, bold: true, color: COLORS.orange, align: 'center' },
  )
  const takeawayFit = fitFontSize(item.takeaway, 3.0, 2.35, {
    max: 22,
    min: 16,
  })
  addTrackedText(
    slide,
    context,
    'summary-takeaway',
    item.takeaway,
    { x: 8.92, y: 2.75, w: 3.0, h: 2.35 },
    {
      fontFace,
      fontSize: takeawayFit.size,
      bold: true,
      color: COLORS.white,
      align: 'center',
    },
  )
  if (fitted.overflow) context.errors.push('summary bullets exceed text capacity')
  if (takeawayFit.overflow) context.errors.push('summary takeaway exceeds text capacity')
  checkCollisions(context)
}

async function renderSlide(pptx, spec, item, qa, fontFace, specDir, brand) {
  switch (item.type) {
    case 'content':
      return renderContent(pptx, spec, item, qa, fontFace)
    case 'two_column':
      return renderTwoColumn(pptx, spec, item, qa, fontFace)
    case 'cards':
      return renderCards(pptx, spec, item, qa, fontFace)
    case 'process':
      return renderProcess(pptx, spec, item, qa, fontFace)
    case 'metrics':
      return renderMetrics(pptx, spec, item, qa, fontFace)
    case 'chart':
      return renderChart(pptx, spec, item, qa, fontFace)
    case 'table':
      return renderTable(pptx, spec, item, qa, fontFace)
    case 'quote':
      return renderQuote(pptx, spec, item, qa, fontFace)
    case 'image':
      return renderImage(pptx, spec, item, qa, fontFace, specDir)
    case 'section':
      return renderSection(pptx, spec, item, qa, fontFace, brand)
    case 'summary':
      return renderSummary(pptx, spec, item, qa, fontFace)
    default:
      throw new Error(`Unsupported slide type: ${item.type}`)
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const raw = JSON.parse(await fs.readFile(args.specPath, 'utf8'))
  const spec = normalizeSpec(raw)
  const fontFace = fontFor(spec.language)
  const qa = createQa(spec)
  const brand = await loadAdvantestAssets()
  const pptx = new pptxgen()
  configureAdvantestPresentation(pptx, spec)

  coverSlide(pptx, spec, qa, fontFace, brand)
  appendSlideObjectQa(pptx._slides.at(-1), qa.slides.at(-1), { page: PAGE })
  for (const item of spec.slides) {
    await renderSlide(
      pptx,
      spec,
      item,
      qa,
      fontFace,
      path.dirname(args.specPath),
      brand,
    )
    appendSlideObjectQa(pptx._slides.at(-1), qa.slides.at(-1), { page: PAGE })
  }

  for (const slide of qa.slides) {
    qa.warnings.push(...slide.warnings.map(message => `slide ${slide.index}: ${message}`))
    qa.errors.push(...slide.errors.map(message => `slide ${slide.index}: ${message}`))
  }
  if (qa.errors.length) {
    await fs.mkdir(path.dirname(args.qaPath), { recursive: true })
    await fs.writeFile(args.qaPath, `${JSON.stringify(qa, null, 2)}\n`)
    throw new Error(`Layout QA failed:\n- ${qa.errors.join('\n- ')}`)
  }

  await fs.mkdir(path.dirname(args.outputPath), { recursive: true })
  await pptx.writeFile({ fileName: args.outputPath, compression: true })
  await fs.writeFile(args.qaPath, `${JSON.stringify(qa, null, 2)}\n`)
  console.log(
    JSON.stringify({
      success: true,
      file: args.outputPath,
      qa: args.qaPath,
      slides: qa.slides.length,
      warnings: qa.warnings.length,
    }),
  )
}

main().catch(error => {
  console.error(error.stack || error.message)
  process.exitCode = 1
})
