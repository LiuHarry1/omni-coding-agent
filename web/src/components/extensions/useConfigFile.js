import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { isMtimeConflict, userConfigApi } from '../../lib/api/user-config.js'

function filePayload(response, path, fallbackContent = '') {
  const file = response?.file || response || {}
  return {
    path: file.path || path,
    content: typeof file.content === 'string' ? file.content : fallbackContent,
    mtimeMs: file.mtimeMs ?? file.mtime ?? null,
    readOnly: Boolean(file.readOnly || file.readonly || file.managed),
    source: file.source || file.ownership?.source,
    mime: file.mime || file.contentType,
    isBinary: Boolean(file.isBinary),
    truncated: Boolean(file.truncated),
  }
}

export default function useConfigFile(
  path,
  { enabled = true, client = userConfigApi } = {},
) {
  const [file, setFile] = useState(null)
  const [content, setContent] = useState('')
  const [savedContent, setSavedContent] = useState('')
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState(null)
  const [conflict, setConflict] = useState(false)
  const draftRevision = useRef(0)
  const loadRevision = useRef(0)

  const updateContent = useCallback(value => {
    draftRevision.current += 1
    setContent(value)
  }, [])

  const load = useCallback(async () => {
    const request = ++loadRevision.current
    if (!enabled || !path) {
      setFile(null)
      setContent('')
      setSavedContent('')
      setError(null)
      setConflict(false)
      setLoading(false)
      return null
    }
    setLoading(true)
    setError(null)
    setConflict(false)
    try {
      const next = filePayload(await client.read(path), path)
      if (request !== loadRevision.current) return null
      draftRevision.current += 1
      setFile(next)
      setContent(next.content)
      setSavedContent(next.content)
      return next
    } catch (err) {
      if (request !== loadRevision.current) return null
      setError(err?.message || 'Could not read this file')
      return null
    } finally {
      if (request === loadRevision.current) setLoading(false)
    }
  }, [client, enabled, path])

  useEffect(() => {
    void load()
  }, [load])

  const save = useCallback(
    async nextContent => {
      if (
        !path ||
        !file ||
        file.readOnly ||
        file.isBinary ||
        file.truncated ||
        saving
      ) {
        return null
      }
      const value = nextContent ?? content
      const savedRevision = draftRevision.current
      const activeLoadRevision = loadRevision.current
      setSaving(true)
      setError(null)
      setConflict(false)
      try {
        const next = filePayload(
          await client.save(path, value, file.mtimeMs),
          path,
          value,
        )
        if (activeLoadRevision !== loadRevision.current) return null
        setFile(next)
        setSavedContent(next.content)
        if (draftRevision.current === savedRevision) {
          setContent(next.content)
        }
        return next
      } catch (err) {
        if (activeLoadRevision !== loadRevision.current) return null
        if (isMtimeConflict(err)) {
          setConflict(true)
          setError(
            'This file changed after you opened it. Reload the latest version before saving.',
          )
        } else {
          setError(err?.message || 'Could not save this file')
        }
        return null
      } finally {
        if (activeLoadRevision === loadRevision.current) setSaving(false)
      }
    },
    [client, content, file, path, saving],
  )

  return useMemo(
    () => ({
      file,
      content,
      setContent: updateContent,
      loading,
      saving,
      error,
      conflict,
      dirty: content !== savedContent,
      blockedReason: file?.isBinary
        ? 'Binary files cannot be edited as text.'
        : file?.truncated
          ? 'This preview is truncated; saving it would overwrite the complete file.'
          : file?.readOnly
            ? 'This resource is read-only.'
            : null,
      load,
      save,
    }),
    [
      conflict,
      content,
      error,
      file,
      load,
      loading,
      save,
      savedContent,
      saving,
      updateContent,
    ],
  )
}
