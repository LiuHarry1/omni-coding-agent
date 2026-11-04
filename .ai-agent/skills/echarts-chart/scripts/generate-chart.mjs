#!/usr/bin/env node

import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const SKILL_ROOT = path.resolve(HERE, '..')
const MAX_HTML_BYTES = 5 * 1024 * 1024
const GOALS = new Set([
  'trend',
  'compare',
  'composition',
  'distribution',
  'ranking',
  'correlation',
])
const CHART_TYPES = new Set([
  'line',
  'bar',
  'stacked_bar',
  'area',
  'pie',
  'donut',
  'scatter',
  'histogram',
  'heatmap',
  'boxplot',
  'pareto',
  'table',
])
const DEFAULT_TYPE = {
  trend: 'line',
  compare: 'bar',
  composition: 'donut',
  distribution: 'histogram',
  ranking: 'bar',
  correlation: 'scatter',
}
const PALETTES = {
  // Studio: teal/amber/blue — crisp on white, avoids cream-editorial look
  default: ['#0F766E', '#EA580C', '#2563EB', '#DC2626', '#059669', '#CA8A04'],
  warm: ['#C2410C', '#EA580C', '#D97706', '#B45309', '#F59E0B', '#9A3412'],
  cool: ['#0E7490', '#0284C7', '#2563EB', '#0F766E', '#64748B', '#0369A1'],
  business: ['#0F172A', '#1E3A5F', '#334155', '#0F766E', '#B45309', '#475569'],
}

function fail(message) {
  throw new Error(`Chart validation failed: ${message}`)
}

function parseArgs(argv) {
  const out = { png: false }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--png') out.png = true
    else if (arg === '--input') out.input = argv[++i]
    else if (arg === '--output-dir') out.outputDir = argv[++i]
    else if (arg === '--slug') out.slug = argv[++i]
    else if (arg === '--help' || arg === '-h') out.help = true
    else fail(`unknown argument ${arg}`)
  }
  return out
}

function usage() {
  return [
    'Usage: node generate-chart.mjs --input input.json [--output-dir charts]',
    '       [--slug safe-name] [--png]',
  ].join('\n')
}

function text(value, name, required = false) {
  if (value == null && !required) return undefined
  if (typeof value !== 'string' || (required && !value.trim())) {
    fail(`${name} must be ${required ? 'a non-empty' : 'a'} string`)
  }
  return value.trim()
}

function fieldNames(value, name) {
  const values = Array.isArray(value) ? value : [value]
  if (!values.length || values.some(v => typeof v !== 'string' || !v.trim())) {
    fail(`${name} must be a field name or non-empty field-name array`)
  }
  return values.map(v => v.trim())
}

function isMissing(value) {
  return value == null || (typeof value === 'string' && value.trim() === '')
}

function finiteNumber(value, field, row) {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim() && Number.isFinite(Number(value))) {
    return Number(value)
  }
  fail(`row ${row + 1} field "${field}" must be a finite number`)
}

function fnv1a(value) {
  let hash = 0x811c9dc5
  for (const char of value) {
    hash ^= char.codePointAt(0)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(36)
}

function slugify(title) {
  const ascii = title
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64)
  // Non-Latin titles ("最近 7 天…") would otherwise collapse to a bare number.
  return /[a-z]/.test(ascii) ? ascii : `chart-${fnv1a(title).slice(0, 8)}`
}

function normalizeTimeRange(value) {
  if (value == null) return undefined
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail('timeRange must be an object')
  }
  const start = text(value.start, 'timeRange.start', true)
  const end = text(value.end, 'timeRange.end', true)
  const timezone = text(value.timezone, 'timeRange.timezone')
  const startMs = Date.parse(start)
  const endMs = Date.parse(end)
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) {
    fail('timeRange.start and end must be valid date-like values')
  }
  if (startMs > endMs) fail('timeRange.start must not exceed end')
  return { start, end, ...(timezone ? { timezone } : {}) }
}

function normalizeIncompletePeriod(value) {
  if (value == null || value === false) return false
  if (value === true) return { label: 'Incomplete period' }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail('incompletePeriod must be boolean or an object')
  }
  const label = text(value.label, 'incompletePeriod.label') || 'Incomplete period'
  const note = text(value.note, 'incompletePeriod.note')
  return { label, ...(note ? { note } : {}) }
}

function assertPrimitiveRecords(records) {
  records.forEach((record, index) => {
    if (!record || typeof record !== 'object' || Array.isArray(record)) {
      fail(`data row ${index + 1} must be an object`)
    }
    for (const [key, value] of Object.entries(record)) {
      if (
        value !== null &&
        !['string', 'number', 'boolean'].includes(typeof value)
      ) {
        fail(`row ${index + 1} field "${key}" must be scalar or null`)
      }
      if (typeof value === 'number' && !Number.isFinite(value)) {
        fail(`row ${index + 1} field "${key}" cannot be NaN or Infinity`)
      }
    }
  })
}

function normalizeInput(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    fail('input must be a JSON object')
  }
  const title = text(raw.title, 'title', true)
  if (!GOALS.has(raw.goal)) fail(`goal must be one of ${[...GOALS].join(', ')}`)
  if (!Array.isArray(raw.data) || raw.data.length === 0) {
    fail('data must be a non-empty array')
  }
  assertPrimitiveRecords(raw.data)
  if (!raw.fields || typeof raw.fields !== 'object' || Array.isArray(raw.fields)) {
    fail('fields must be an object')
  }

  const chartType = raw.chartType || DEFAULT_TYPE[raw.goal]
  if (!CHART_TYPES.has(chartType)) {
    fail(`chartType must be one of ${[...CHART_TYPES].join(', ')}`)
  }
  const x = text(raw.fields.x, 'fields.x', true)
  const y = fieldNames(raw.fields.y, 'fields.y')
  const value = text(raw.fields.value, 'fields.value')
  const requiredFields = new Set([x, ...y, ...(value ? [value] : [])])
  raw.data.forEach((record, index) => {
    for (const field of requiredFields) {
      if (!(field in record)) fail(`row ${index + 1} is missing field "${field}"`)
    }
  })

  if (['pie', 'donut', 'histogram', 'pareto'].includes(chartType) && y.length !== 1) {
    fail(`${chartType} requires exactly one fields.y value`)
  }
  if (chartType === 'stacked_bar' && y.length < 2) {
    fail('stacked_bar requires at least two fields.y values')
  }
  if (chartType === 'heatmap' && (!value || y.length !== 1)) {
    fail('heatmap requires one fields.y category and fields.value')
  }
  if (chartType === 'boxplot' && y.length !== 5) {
    fail('boxplot fields.y must be [min, q1, median, q3, max]')
  }

  const missingValuePolicy = raw.missingValuePolicy || 'error'
  if (!['error', 'zero', 'gap', 'drop'].includes(missingValuePolicy)) {
    fail('missingValuePolicy must be error, zero, gap, or drop')
  }
  const numericFields = new Set(chartType === 'heatmap' ? [value] : y)
  if (chartType === 'scatter') numericFields.add(x)

  const data = []
  raw.data.forEach((source, row) => {
    const record = { ...source }
    let drop = false
    for (const field of numericFields) {
      if (isMissing(record[field])) {
        if (missingValuePolicy === 'error') {
          fail(`row ${row + 1} field "${field}" is missing`)
        }
        if (missingValuePolicy === 'drop') drop = true
        else record[field] = missingValuePolicy === 'zero' ? 0 : null
      } else {
        record[field] = finiteNumber(record[field], field, row)
      }
    }
    if (!drop) data.push(record)
  })
  if (!data.length) fail('no records remain after missing-value handling')

  const sort =
    raw.sort || (raw.goal === 'ranking' || chartType === 'pareto' ? 'desc' : 'none')
  if (!['none', 'asc', 'desc', 'chronological'].includes(sort)) {
    fail('sort must be none, asc, desc, or chronological')
  }
  const indexed = data.map((record, index) => ({ record, index }))
  if (sort !== 'none') {
    indexed.sort((a, b) => {
      let av
      let bv
      if (sort === 'chronological') {
        av = Date.parse(String(a.record[x]))
        bv = Date.parse(String(b.record[x]))
        if (!Number.isFinite(av) || !Number.isFinite(bv)) {
          fail(`chronological sort requires date-like values in "${x}"`)
        }
      } else {
        av = a.record[y[0]]
        bv = b.record[y[0]]
      }
      const delta = av < bv ? -1 : av > bv ? 1 : 0
      return (sort === 'desc' ? -delta : delta) || a.index - b.index
    })
  }
  let normalizedData = indexed.map(item => item.record)

  let topN
  if (raw.topN != null) {
    topN = Number(raw.topN)
    if (!Number.isInteger(topN) || topN < 1 || topN > 100) {
      fail('topN must be an integer from 1 to 100')
    }
    if (['scatter', 'heatmap', 'boxplot', 'table'].includes(chartType)) {
      fail(`topN is not supported for ${chartType}`)
    }
    const ranked = normalizedData
      .map((record, index) => ({
        record,
        index,
        score: y.reduce((sum, field) => sum + Math.abs(record[field] ?? 0), 0),
      }))
      .sort((a, b) => b.score - a.score || a.index - b.index)
    const kept = ranked.slice(0, topN).map(item => item.record)
    const excluded = ranked.slice(topN).map(item => item.record)
    if (excluded.length && raw.includeOther !== false) {
      const other = { [x]: 'Other' }
      for (const field of y) {
        other[field] = excluded.reduce((sum, record) => sum + (record[field] ?? 0), 0)
      }
      kept.push(other)
    }
    normalizedData = kept
  }

  if (['pie', 'donut'].includes(chartType) && normalizedData.length > 6) {
    fail('pie/donut supports at most 6 slices; set topN or use bar')
  }
  if (
    chartType === 'pareto' &&
    normalizedData.some(record => record[y[0]] == null || record[y[0]] < 0)
  ) {
    fail('pareto requires non-negative values without gaps')
  }
  if (chartType === 'boxplot') {
    normalizedData.forEach((record, row) => {
      const values = y.map(field => record[field])
      if (values.some(value => value == null) || values.some((v, i) => i && v < values[i - 1])) {
        fail(`boxplot row ${row + 1} must satisfy min <= q1 <= median <= q3 <= max`)
      }
    })
  }

  const annotations = raw.annotations == null ? [] : raw.annotations
  if (!Array.isArray(annotations)) fail('annotations must be an array')
  const cleanAnnotations = annotations.map((item, index) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      fail(`annotation ${index + 1} must be an object`)
    }
    return {
      x: text(String(item.x ?? ''), `annotations[${index}].x`, true),
      label: text(item.label, `annotations[${index}].label`, true),
    }
  })

  // Compact defaults so the full chart fits typical laptop viewports.
  const width = raw.width == null ? 960 : Number(raw.width)
  const height = raw.height == null ? 480 : Number(raw.height)
  if (!Number.isInteger(width) || width < 480 || width > 1600) {
    fail('width must be an integer from 480 to 1600')
  }
  if (!Number.isInteger(height) || height < 280 || height > 1200) {
    fail('height must be an integer from 280 to 1200')
  }
  const source = raw.source == null
    ? []
    : (Array.isArray(raw.source) ? raw.source : [raw.source]).map((item, index) =>
        text(item, `source[${index}]`, true),
      )
  const unit =
    typeof raw.unit === 'string'
      ? text(raw.unit, 'unit')
      : raw.unit && typeof raw.unit === 'object' && !Array.isArray(raw.unit)
        ? Object.fromEntries(
            Object.entries(raw.unit).map(([key, val]) => [
              key,
              text(val, `unit.${key}`, true),
            ]),
          )
        : undefined
  if (raw.unit != null && unit === undefined) {
    fail('unit must be a string or object keyed by series')
  }
  if (raw.theme != null && raw.theme !== 'light' && raw.theme !== 'dark') {
    fail('theme must be light or dark')
  }

  return {
    title,
    goal: raw.goal,
    chartType,
    description: text(raw.description, 'description'),
    source,
    unit,
    timeRange: normalizeTimeRange(raw.timeRange),
    missingValuePolicy,
    incompletePeriod: normalizeIncompletePeriod(raw.incompletePeriod),
    sort,
    topN,
    includeOther: raw.includeOther !== false,
    annotations: cleanAnnotations,
    theme: raw.theme === 'dark' ? 'dark' : 'light',
    fields: { x, y: Array.isArray(raw.fields.y) ? y : y[0], ...(value ? { value } : {}) },
    width,
    height,
    data: normalizedData,
  }
}

function safeJson(value, pretty = false) {
  return JSON.stringify(value, null, pretty ? 2 : 0)
    .replace(/</g, '\\u003c')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029')
}

function chromeCandidates() {
  const names = process.platform === 'win32'
    ? [
        process.env.CHROME_PATH,
        `${process.env.PROGRAMFILES || ''}\\Google\\Chrome\\Application\\chrome.exe`,
        `${process.env['PROGRAMFILES(X86)'] || ''}\\Google\\Chrome\\Application\\chrome.exe`,
        `${process.env.LOCALAPPDATA || ''}\\Google\\Chrome\\Application\\chrome.exe`,
        'chrome.exe',
      ]
    : process.platform === 'darwin'
      ? [
          process.env.CHROME_PATH,
          '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
          `${process.env.HOME || ''}/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`,
          '/Applications/Chromium.app/Contents/MacOS/Chromium',
          '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
          'google-chrome',
          'chromium',
        ]
      : [
          process.env.CHROME_PATH,
          'google-chrome',
          'google-chrome-stable',
          'chromium',
          'chromium-browser',
        ]
  return names.filter(Boolean)
}

function renderPng(htmlPath, pngPath) {
  // #static hides the interactive controls so the PNG shows only the chart.
  const target = `${pathToFileURL(htmlPath).href}#static`
  const args = [
    '--headless=new',
    '--disable-gpu',
    '--no-sandbox',
    '--hide-scrollbars',
    '--force-device-scale-factor=1',
    '--window-size=1280,860',
    '--virtual-time-budget=3000',
    `--screenshot=${pngPath}`,
    target,
  ]
  const failures = []
  for (const executable of chromeCandidates()) {
    const result = spawnSync(executable, args, { encoding: 'utf8' })
    if (result.status === 0 && fs.existsSync(pngPath)) return
    failures.push(`${executable}: ${result.error?.message || result.stderr || `exit ${result.status}`}`)
  }
  throw new Error(`PNG requested but headless Chrome failed:\n${failures.join('\n')}`)
}

function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.help) {
    console.log(usage())
    return
  }
  if (!args.input) fail('--input is required')
  const inputPath = path.resolve(args.input)
  const outputDir = path.resolve(args.outputDir || 'charts')
  const normalized = normalizeInput(JSON.parse(fs.readFileSync(inputPath, 'utf8')))
  const slug = args.slug || slugify(normalized.title)
  if (!/^[a-z0-9][a-z0-9-]{0,79}$/.test(slug)) {
    fail('slug must match ^[a-z0-9][a-z0-9-]{0,79}$')
  }

  fs.mkdirSync(outputDir, { recursive: true })
  const paths = {
    spec: path.join(outputDir, `${slug}.spec.json`),
    data: path.join(outputDir, `${slug}.data.json`),
    html: path.join(outputDir, `${slug}.html`),
    ...(args.png ? { png: path.join(outputDir, `${slug}.png`) } : {}),
  }
  const dataArtifact = {
    title: normalized.title,
    fields: normalized.fields,
    unit: normalized.unit,
    records: normalized.data,
  }
  const specArtifact = {
    ...normalized,
    data: undefined,
    recordCount: normalized.data.length,
    dataFile: path.basename(paths.data),
    generator: { name: 'echarts-chart', schemaVersion: 1, echartsVersion: '5.5.1' },
  }
  fs.writeFileSync(paths.spec, `${safeJson(specArtifact, true)}\n`)
  fs.writeFileSync(paths.data, `${safeJson(dataArtifact, true)}\n`)

  const template = fs.readFileSync(
    path.join(SKILL_ROOT, 'references', 'chart-template.html'),
    'utf8',
  )
  const runtime = fs.readFileSync(
    path.join(SKILL_ROOT, 'references', 'echarts.min.js'),
    'utf8',
  )
  const payload = {
    ...normalized,
    palettes: PALETTES,
    downloadName: path.basename(paths.data),
  }
  const html = template
    .replace('/*__ECHARTS_RUNTIME__*/', runtime)
    .replace('/*__CHART_PAYLOAD__*/null', safeJson(payload))
  if (Buffer.byteLength(html) > MAX_HTML_BYTES) {
    fail(`generated HTML exceeds ${MAX_HTML_BYTES} bytes`)
  }
  fs.writeFileSync(paths.html, html)
  if (args.png) renderPng(paths.html, paths.png)

  console.log(safeJson({ ok: true, slug, recordCount: normalized.data.length, paths }, true))
}

try {
  main()
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
}
