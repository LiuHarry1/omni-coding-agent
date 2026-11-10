const DEFAULT_PAGE = { width: 13.333, height: 7.5 }

function finiteBox(options = {}) {
  const values = ['x', 'y', 'w', 'h'].map(key => {
    const value = Number(options[key])
    return Math.abs(value) > 1000 ? value / 914400 : value
  })
  if (!values.every(Number.isFinite)) return null
  return { x: values[0], y: values[1], w: values[2], h: values[3] }
}

function objectName(object, index) {
  return object?.options?.objectName || `${object?._type || 'object'}-${index + 1}`
}

function objectKind(object) {
  if (object?._type === 'text' && object.text) return 'text'
  if (object?._type === 'text') return 'shape'
  return object?._type || 'shape'
}

function overlap(left, right) {
  const x = Math.min(left.x + left.w, right.x + right.w) - Math.max(left.x, right.x)
  const y = Math.min(left.y + left.h, right.y + right.h) - Math.max(left.y, right.y)
  return { x, y, area: Math.max(0, x) * Math.max(0, y) }
}

export function inspectSlideObjects(slide, options = {}) {
  const page = options.page ?? DEFAULT_PAGE
  const epsilon = options.epsilon ?? 0.01
  const objects = (slide?._slideObjects ?? [])
    .map((object, index) => ({
      index,
      name: objectName(object, index),
      kind: objectKind(object),
      box: finiteBox(object.options),
    }))
    .filter(object => object.box)
  const errors = []
  const warnings = []

  for (const object of objects) {
    const { x, y, w, h } = object.box
    if (w < 0 || h < 0) errors.push(`${object.name} has negative dimensions`)
    if (
      x < -epsilon ||
      y < -epsilon ||
      x + w > page.width + epsilon ||
      y + h > page.height + epsilon
    ) {
      errors.push(`${object.name} is outside the slide boundary`)
    }
  }

  const overlapKinds = new Set(['text', 'image', 'chart', 'table'])
  for (let leftIndex = 0; leftIndex < objects.length; leftIndex += 1) {
    const left = objects[leftIndex]
    if (!overlapKinds.has(left.kind)) continue
    if (left.box.w * left.box.h >= page.width * page.height * 0.85) continue
    for (let rightIndex = leftIndex + 1; rightIndex < objects.length; rightIndex += 1) {
      const right = objects[rightIndex]
      if (!overlapKinds.has(right.kind)) continue
      if (right.box.w * right.box.h >= page.width * page.height * 0.85) continue
      const intersection = overlap(left.box, right.box)
      const smallerArea = Math.min(left.box.w * left.box.h, right.box.w * right.box.h)
      if (
        intersection.x > epsilon &&
        intersection.y > epsilon &&
        smallerArea > 0 &&
        intersection.area / smallerArea > (options.overlapThreshold ?? 0.08)
      ) {
        warnings.push(`${left.name} overlaps ${right.name}`)
      }
    }
  }
  return { objects, errors, warnings }
}

export function appendSlideObjectQa(slide, context, options = {}) {
  const result = inspectSlideObjects(slide, options)
  context.errors.push(...result.errors)
  context.warnings.push(...result.warnings)
  context.actualObjectCount = result.objects.length
  return result
}

export function safeOuterShadow(options = {}) {
  const opacity = Math.min(1, Math.max(0, Number(options.opacity ?? 0.18)))
  return {
    type: 'outer',
    color: String(options.color ?? '000000').replace(/^#/u, ''),
    opacity,
    blur: Math.max(0, Number(options.blur ?? 1.5)),
    angle: Number(options.angle ?? 45),
    offset: Math.max(0, Number(options.offset ?? 1)),
  }
}
