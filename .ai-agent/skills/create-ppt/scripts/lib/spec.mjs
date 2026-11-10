const TYPES = new Set([
  'content',
  'two_column',
  'cards',
  'process',
  'metrics',
  'chart',
  'table',
  'quote',
  'image',
  'section',
  'summary',
])

const ROOT_FIELDS = new Set([
  'title',
  'subtitle',
  'author',
  'language',
  'audience',
  'objective',
  'narrative',
  'slides',
])

const COMMON_SLIDE_FIELDS = new Set([
  'type',
  'title',
  'takeaway',
  'source',
  'speaker_notes',
  'visual_intent',
])

const TYPE_FIELDS = {
  content: ['bullets', 'callout'],
  two_column: ['left', 'right'],
  cards: ['cards'],
  process: ['steps'],
  metrics: ['metrics'],
  chart: ['chart_kind', 'categories', 'series', 'unit'],
  table: ['columns', 'rows'],
  quote: ['quote', 'attribution'],
  image: ['source_path', 'caption', 'fit'],
  section: ['subtitle'],
  summary: ['bullets', 'closing'],
}

function fail(path, message) {
  throw new Error(`${path}: ${message}`)
}

function object(value, path) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail(path, 'must be an object')
  }
  return value
}

function unknownFields(value, allowed, path) {
  const unknown = Object.keys(value).filter(key => !allowed.has(key))
  if (unknown.length) fail(path, `unknown field(s): ${unknown.join(', ')}`)
}

function string(value, path, { required = false, max = 180 } = {}) {
  if (value == null) {
    if (required) fail(path, 'is required')
    return ''
  }
  if (typeof value !== 'string') fail(path, 'must be a string')
  const result = value.trim()
  if (required && !result) fail(path, 'is required')
  if (result.length > max) fail(path, `must be at most ${max} characters`)
  return result
}

function list(value, path, { min = 0, max = 5, itemMax = 180 } = {}) {
  if (!Array.isArray(value) || value.length < min || value.length > max) {
    fail(path, `must contain ${min} to ${max} items`)
  }
  return value.map((entry, index) =>
    string(entry, `${path}[${index}]`, { required: true, max: itemMax }),
  )
}

function namedItems(
  value,
  path,
  {
    min,
    max,
    first = 'heading',
    second = 'body',
    firstMax = 70,
    secondMax = 160,
  },
) {
  if (!Array.isArray(value) || value.length < min || value.length > max) {
    fail(path, `must contain ${min} to ${max} items`)
  }
  return value.map((raw, index) => {
    const itemPath = `${path}[${index}]`
    const item = object(raw, itemPath)
    unknownFields(item, new Set([first, second]), itemPath)
    return {
      [first]: string(item[first], `${itemPath}.${first}`, {
        required: true,
        max: firstMax,
      }),
      [second]: string(item[second], `${itemPath}.${second}`, {
        max: secondMax,
      }),
    }
  })
}

function column(value, path) {
  const item = object(value, path)
  unknownFields(item, new Set(['heading', 'bullets']), path)
  return {
    heading: string(item.heading, `${path}.heading`, {
      required: true,
      max: 60,
    }),
    bullets: list(item.bullets, `${path}.bullets`, {
      min: 1,
      max: 5,
      itemMax: 160,
    }),
  }
}

function normalizeSlide(raw, index) {
  const path = `slides[${index}]`
  const slide = object(raw, path)
  const type = string(slide.type, `${path}.type`, {
    required: true,
    max: 32,
  })
  if (!TYPES.has(type)) fail(`${path}.type`, `unsupported type '${type}'`)
  unknownFields(
    slide,
    new Set([...COMMON_SLIDE_FIELDS, ...TYPE_FIELDS[type]]),
    path,
  )
  const normalized = {
    type,
    title: string(slide.title, `${path}.title`, {
      required: true,
      max: 100,
    }),
    takeaway: string(slide.takeaway, `${path}.takeaway`, {
      required: true,
      max: 180,
    }),
    source: string(slide.source, `${path}.source`, { max: 180 }),
    speaker_notes: string(slide.speaker_notes, `${path}.speaker_notes`, {
      max: 2000,
    }),
    visual_intent: string(slide.visual_intent, `${path}.visual_intent`, {
      max: 240,
    }),
  }

  if (type === 'content' || type === 'summary') {
    normalized.bullets = list(slide.bullets, `${path}.bullets`, {
      min: 1,
      max: 5,
    })
  }
  if (type === 'content') {
    normalized.callout = string(slide.callout, `${path}.callout`, { max: 80 })
  }
  if (type === 'summary') {
    normalized.closing = string(slide.closing, `${path}.closing`, { max: 80 })
  }
  if (type === 'two_column') {
    normalized.left = column(slide.left, `${path}.left`)
    normalized.right = column(slide.right, `${path}.right`)
  }
  if (type === 'cards') {
    normalized.cards = namedItems(slide.cards, `${path}.cards`, {
      min: 2,
      max: 4,
    })
  }
  if (type === 'process') {
    normalized.steps = namedItems(slide.steps, `${path}.steps`, {
      min: 3,
      max: 5,
      first: 'title',
      second: 'detail',
    })
  }
  if (type === 'metrics') {
    if (!Array.isArray(slide.metrics) || slide.metrics.length < 2 || slide.metrics.length > 4) {
      fail(`${path}.metrics`, 'must contain 2 to 4 items')
    }
    normalized.metrics = slide.metrics.map((rawMetric, metricIndex) => {
      const metricPath = `${path}.metrics[${metricIndex}]`
      const metric = object(rawMetric, metricPath)
      unknownFields(metric, new Set(['value', 'label', 'detail']), metricPath)
      return {
        value: string(metric.value, `${metricPath}.value`, {
          required: true,
          max: 30,
        }),
        label: string(metric.label, `${metricPath}.label`, {
          required: true,
          max: 80,
        }),
        detail: string(metric.detail, `${metricPath}.detail`, { max: 100 }),
      }
    })
  }
  if (type === 'chart') {
    const kind = string(slide.chart_kind, `${path}.chart_kind`, {
      required: true,
      max: 16,
    })
    if (!['bar', 'column', 'line', 'pie'].includes(kind)) {
      fail(`${path}.chart_kind`, 'must be bar, column, line, or pie')
    }
    const categories = list(slide.categories, `${path}.categories`, {
      min: 2,
      max: 10,
      itemMax: 50,
    })
    if (!Array.isArray(slide.series) || slide.series.length < 1 || slide.series.length > 4) {
      fail(`${path}.series`, 'must contain 1 to 4 series')
    }
    const series = slide.series.map((rawSeries, seriesIndex) => {
      const seriesPath = `${path}.series[${seriesIndex}]`
      const entry = object(rawSeries, seriesPath)
      unknownFields(entry, new Set(['name', 'values']), seriesPath)
      if (!Array.isArray(entry.values) || entry.values.length !== categories.length) {
        fail(`${seriesPath}.values`, 'must match the category count')
      }
      const values = entry.values.map((value, valueIndex) => {
        if (typeof value !== 'number' || !Number.isFinite(value)) {
          fail(`${seriesPath}.values[${valueIndex}]`, 'must be a finite number')
        }
        return value
      })
      return {
        name: string(entry.name, `${seriesPath}.name`, {
          required: true,
          max: 50,
        }),
        values,
      }
    })
    if (kind === 'pie' && series.length !== 1) {
      fail(`${path}.series`, 'pie charts require exactly one series')
    }
    Object.assign(normalized, {
      chart_kind: kind,
      categories,
      series,
      unit: string(slide.unit, `${path}.unit`, { max: 30 }),
    })
  }
  if (type === 'table') {
    const columns = list(slide.columns, `${path}.columns`, {
      min: 2,
      max: 6,
      itemMax: 60,
    })
    if (!Array.isArray(slide.rows) || slide.rows.length < 1 || slide.rows.length > 8) {
      fail(`${path}.rows`, 'must contain 1 to 8 rows')
    }
    const rows = slide.rows.map((row, rowIndex) => {
      if (!Array.isArray(row) || row.length !== columns.length) {
        fail(`${path}.rows[${rowIndex}]`, `must contain ${columns.length} cells`)
      }
      return row.map((cell, cellIndex) =>
        string(cell, `${path}.rows[${rowIndex}][${cellIndex}]`, { max: 100 }),
      )
    })
    Object.assign(normalized, { columns, rows })
  }
  if (type === 'quote') {
    normalized.quote = string(slide.quote, `${path}.quote`, {
      required: true,
      max: 320,
    })
    normalized.attribution = string(
      slide.attribution,
      `${path}.attribution`,
      { required: true, max: 100 },
    )
  }
  if (type === 'image') {
    normalized.source_path = string(slide.source_path, `${path}.source_path`, {
      required: true,
      max: 500,
    })
    normalized.caption = string(slide.caption, `${path}.caption`, { max: 180 })
    normalized.fit = string(slide.fit, `${path}.fit`, { max: 16 }) || 'contain'
    if (!['contain', 'crop'].includes(normalized.fit)) {
      fail(`${path}.fit`, 'must be contain or crop')
    }
  }
  if (type === 'section') {
    normalized.subtitle = string(slide.subtitle, `${path}.subtitle`, { max: 160 })
  }
  return normalized
}

export function normalizeSpec(raw) {
  const spec = object(raw, 'presentation')
  unknownFields(spec, ROOT_FIELDS, 'presentation')
  if (!Array.isArray(spec.slides) || spec.slides.length < 1 || spec.slides.length > 24) {
    fail('slides', 'must contain 1 to 24 slides')
  }
  return {
    title: string(spec.title, 'title', { required: true, max: 100 }),
    subtitle: string(spec.subtitle, 'subtitle', { max: 160 }),
    author: string(spec.author, 'author', { max: 80 }),
    language: string(spec.language, 'language', { max: 20 }) || 'en',
    audience: string(spec.audience, 'audience', { required: true, max: 160 }),
    objective: string(spec.objective, 'objective', { required: true, max: 200 }),
    narrative: string(spec.narrative, 'narrative', { max: 300 }),
    slides: spec.slides.map(normalizeSlide),
  }
}

export { TYPES }
