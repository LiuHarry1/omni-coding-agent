export const metadata = {
  title: 'Professional runtime verification',
  subtitle: 'Editable native PowerPoint objects',
  author: 'Baix',
  language: 'en',
  audience: 'Engineering',
  objective: 'Verify the professional authoring path',
}

export default async function build(api) {
  api.cover({ notes: 'Open with the purpose of the runtime test.' })
  api.text(
    'cover-title',
    metadata.title,
    { x: 0.78, y: 2.1, w: 5.8, h: 1.4 },
    {
      fontSize: 30,
      bold: true,
      color: api.colors.magenta,
      valign: 'mid',
    },
  )
  api.text(
    'cover-subtitle',
    metadata.subtitle,
    { x: 0.8, y: 4.05, w: 5.5, h: 0.5 },
    { fontSize: 14, color: api.colors.charcoal },
  )

  api.newSlide({
    title: 'Measured text and native objects share one runtime',
    takeaway: 'The API keeps every important object editable.',
    source: 'Baix runtime test',
  })
  api.shape(
    'insight-card',
    api.shapeType.roundRect,
    { x: 0.9, y: 1.75, w: 4.2, h: 3.9 },
    {
      fill: { color: api.colors.pale },
      line: { color: api.colors.teal, width: 1.2 },
      shadow: api.safeOuterShadow(),
    },
  )
  const fitted = api.fitText(
    'Text measurement uses the selected font and Unicode line-break opportunities.',
    {
      width: 3.55,
      height: 2,
      fontFace: api.fontFace,
      maxFontSize: 22,
      minFontSize: 14,
    },
  )
  api.text(
    'measured-copy',
    'Text measurement uses the selected font and Unicode line-break opportunities.',
    { x: 1.25, y: 2.55, w: 3.55, h: 2 },
    { fontSize: fitted.size, color: api.colors.charcoal, valign: 'mid' },
  )
  await api.image(
    'editable-svg',
    api.svgToDataUri(
      '<svg xmlns="http://www.w3.org/2000/svg" width="640" height="360"><rect width="640" height="360" rx="28" fill="#005777"/><circle cx="190" cy="180" r="80" fill="#FF7E00"/><path d="M290 180h210" stroke="#fff" stroke-width="20"/><path d="m470 130 60 50-60 50" fill="none" stroke="#fff" stroke-width="20"/></svg>',
    ),
    { x: 6.1, y: 1.9, w: 5.7, h: 3.35 },
    { fit: 'contain' },
  )

  api.newSlide({
    title: 'Native charts remain editable after delivery',
    takeaway: 'Professional mode does not rasterize business data.',
    notes: 'Close by confirming the chart can be edited in PowerPoint.',
  })
  api.chart(
    'adoption-chart',
    api.chartType.bar,
    [{ name: 'Active users', labels: ['W1', 'W2', 'W3'], values: [12, 28, 45] }],
    { x: 1.0, y: 1.65, w: 11.2, h: 4.8 },
    {
      catAxisLabelFontFace: api.fontFace,
      valAxisLabelFontFace: api.fontFace,
      chartColors: [api.colors.teal],
      showLegend: false,
      showTitle: false,
      showValue: true,
      showBorder: false,
      valGridLine: { color: api.colors.line, width: 1 },
    },
  )
}
