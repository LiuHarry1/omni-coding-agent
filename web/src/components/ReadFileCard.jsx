import { useEffect, useMemo, useState } from 'react'
import ToolChrome from './ToolChrome.jsx'
import { fileName } from '../lib/utils.js'
import { toolActionLabel, toolErrorDetails } from '../lib/tool-action-labels.js'
import { useToolDensityExpand } from '../lib/use-tool-density-expand.js'
import { useWorkspaceIdeStore } from '../stores/workspace-ide-store.js'
import {
  fetchAuthenticatedBlobUrl,
  fetchAuthenticatedResourceBlobUrl,
} from '../lib/api/workspace.js'

/**
 * Read row — default-chat density:
 * success text reads are header-only ("Read package.json L1–76").
 * Click opens the file in the workspace IDE; no in-chat file dump.
 * Errors / images still expand inline.
 */

function formatBytes(n) {
  if (typeof n !== 'number' || !Number.isFinite(n) || n < 0) return null
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10 * 1024 ? 1 : 0)} KB`
  return `${(n / (1024 * 1024)).toFixed(1)} MB`
}

function fromToolUseResult(tur) {
  if (!tur || typeof tur !== 'object' || typeof tur.type !== 'string') {
    return null
  }
  if (tur.type === 'file_unchanged') {
    return {
      kind: 'unchanged',
      label: 'Unchanged since last read',
    }
  }
  if (tur.type === 'text' && tur.file) {
    return {
      kind: 'text',
      start: tur.file.startLine,
      end: tur.file.startLine + (tur.file.numLines || 1) - 1,
      total: tur.file.totalLines,
      content: tur.file.content,
    }
  }
  if (tur.type === 'image') {
    const file = tur.file || {}
    const mediaType = file.mediaType || 'image/png'
    const base64 = typeof file.base64 === 'string' ? file.base64 : ''
    const src = base64.length > 0 ? `data:${mediaType};base64,${base64}` : null
    return {
      kind: 'image',
      label: `[Image: ${file.filePath || ''}, ${mediaType}]`,
      src,
      filePath: file.filePath || null,
      previewUrl: file.previewUrl || null,
      mediaType,
      sizeLabel: formatBytes(file.originalSize),
    }
  }
  if (tur.type === 'pdf' || tur.type === 'pdf_pages' || tur.type === 'parts') {
    return {
      kind: 'pdf',
      label:
        tur.type === 'pdf_pages'
          ? tur.file?.text || '[PDF pages]'
          : tur.type === 'parts'
            ? `PDF pages extracted: ${tur.file?.count ?? '?'} page(s)`
            : `[PDF: ${tur.file?.filePath}]`,
    }
  }
  if (tur.type === 'notebook') {
    return {
      kind: 'notebook',
      label: `${tur.file?.filePath} (${tur.file?.cells?.length ?? 0} cells)`,
      content: JSON.stringify(tur.file?.cells, null, 2),
    }
  }
  return null
}

/**
 * Wire `tool_use_result` strips image base64 so SSE/JSONL stay small.
 * Prefer an inline data URL when present (legacy sessions); otherwise
 * fetch the workspace file the same way the IDE binary preview does.
 */
function useReadImageSrc(previewUrl, filePath, inlineSrc) {
  const [src, setSrc] = useState(inlineSrc || null)
  const [error, setError] = useState(null)

  useEffect(() => {
    if (!previewUrl && inlineSrc) {
      setSrc(inlineSrc)
      setError(null)
      return
    }
    if (!previewUrl && !filePath) {
      setSrc(null)
      setError(null)
      return
    }
    let revoked = false
    let objectUrl = null
    setSrc(null)
    setError(null)
    const load = async () => {
      if (previewUrl) {
        try {
          return await fetchAuthenticatedResourceBlobUrl(previewUrl)
        } catch (previewError) {
          if (!filePath) throw previewError
        }
      }
      return fetchAuthenticatedBlobUrl(filePath)
    }
    load()
      .then(url => {
        if (revoked) {
          URL.revokeObjectURL(url)
          return
        }
        objectUrl = url
        setSrc(url)
      })
      .catch(err => {
        if (!revoked) setError(err.message || 'Failed to load image')
      })
    return () => {
      revoked = true
      if (objectUrl) URL.revokeObjectURL(objectUrl)
    }
  }, [previewUrl, filePath, inlineSrc])

  return { src, error }
}

export default function ReadFileCard({ part, nested = false }) {
  const [lightbox, setLightbox] = useState(null)
  const openFile = useWorkspaceIdeStore(s => s.openFile)
  const args = part.args || {}
  const result = part.result
  const isDone = part.status === 'done'
  const isError =
    isDone &&
    (part.isError === true ||
      (typeof result === 'string' && result.startsWith('Error:')))
  const filePath = args.file_path || args.path || null
  const fName = fileName(filePath) || filePath || (isDone ? '(unknown)' : null)

  const header = useMemo(
    () => fromToolUseResult(part.toolUseResult),
    [part.toolUseResult],
  )
  const imagePath =
    header?.kind === 'image' ? filePath || header.filePath || null : null
  const { src: imageSrc, error: imageLoadError } = useReadImageSrc(
    header?.kind === 'image' ? header.previewUrl : null,
    imagePath,
    header?.kind === 'image' ? header.src : null,
  )
  const isImageKind = header?.kind === 'image'
  const hasImage = Boolean(isImageKind && imageSrc)
  const imageLoading = Boolean(
    isDone && !isError && isImageKind && !imageSrc && !imageLoadError,
  )
  // Success text/unchanged: header-only. Body only for error / image / misc.
  const headerOnly =
    isDone &&
    !isError &&
    (header?.kind === 'text' || header?.kind === 'unchanged' || !header)

  let rangeLabel = ''
  if (header?.kind === 'text') {
    if (header.total === 0) {
      rangeLabel = 'empty'
    } else if (!header.content) {
      rangeLabel = `offset ${header.start} > ${header.total} lines`
    } else {
      rangeLabel = `L${header.start}-${header.end}`
      if (header.total && header.end - header.start + 1 < header.total) {
        rangeLabel += ` of ${header.total}`
      }
    }
  } else if (header?.kind === 'image') {
    rangeLabel = header.sizeLabel ? `image · ${header.sizeLabel}` : 'image'
  } else if (header?.kind === 'unchanged') {
    rangeLabel = 'unchanged'
  } else if (header?.kind === 'pdf') {
    rangeLabel = 'pdf'
  } else if (header?.kind === 'notebook') {
    rangeLabel = 'notebook'
  } else if (args.offset || args.limit) {
    const start = args.offset && args.offset > 0 ? args.offset : 1
    const end = args.limit ? start + args.limit - 1 : '?'
    rangeLabel = `L${start}-${end}`
  }

  const summaryBody =
    isDone &&
    !isError &&
    header &&
    header.kind !== 'text' &&
    header.kind !== 'image'
      ? header.content || header.label || ''
      : ''
  const imageFallbackLabel =
    isDone && !isError && isImageKind && !imageSrc && !imageLoading
      ? imageLoadError || header.label
      : ''

  const action = toolActionLabel('read', {
    loading: !isDone,
    hasError: isError,
  })
  const title = isError ? toolErrorDetails(fName, true) : fName

  const hasBody =
    !headerOnly &&
    (Boolean(summaryBody) ||
      Boolean(imageFallbackLabel) ||
      hasImage ||
      imageLoading ||
      isError)

  const [expanded, toggleExpanded, chevron] = useToolDensityExpand('read', {
    isDone,
    isError,
    nested,
    hasBody,
    headerOnly,
    forceExpandOnce: isDone && !isError && isImageKind,
  })

  const handleOpen = () => {
    if (!filePath || typeof openFile !== 'function') return
    void openFile(filePath)
  }

  const onToggle = headerOnly
    ? filePath
      ? handleOpen
      : undefined
    : hasBody
      ? toggleExpanded
      : filePath
        ? handleOpen
        : undefined

  return (
    <ToolChrome
      variant='read-file-card'
      nested={nested}
      isError={isError}
      isDone={isDone}
      expanded={headerOnly ? false : expanded}
      onToggle={onToggle}
      hasBody={headerOnly ? Boolean(filePath) : hasBody}
      showChevron={chevron.showChevron}
      label={action}
      title={title}
      titleTooltip={filePath || ''}
      titlePlain
      subtitle={rangeLabel || null}
      duration={undefined}
      showSuccess={false}
    >
      {isDone && !isError && summaryBody && (
        <pre className='tool-row-body'>{summaryBody}</pre>
      )}
      {isDone && !isError && imageLoading && (
        <div className='read-file-shot read-file-shot--loading'>
          Loading preview…
        </div>
      )}
      {isDone && !isError && hasImage && (
        <div className='read-file-shot'>
          <img
            src={imageSrc}
            alt={fName}
            onClick={() => setLightbox(imageSrc)}
          />
        </div>
      )}
      {isDone && !isError && imageFallbackLabel && (
        <pre className='tool-row-body'>{imageFallbackLabel}</pre>
      )}
      {isError && (
        <div className='tool-row-body tool-row-body--error'>{result}</div>
      )}
      {lightbox && (
        <div className='lightbox' onClick={() => setLightbox(null)}>
          <img src={lightbox} alt={fName} />
        </div>
      )}
    </ToolChrome>
  )
}
