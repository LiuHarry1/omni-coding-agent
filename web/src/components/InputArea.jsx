import { useRef, useCallback, useState, useEffect, useMemo } from 'react'
import { useChatStore } from '../stores/chat-store.js'
import ModePicker from './ModePicker.jsx'
import SchedulePicker from './SchedulePicker.jsx'
import { agentApi } from '../lib/api/agent.js'
import { workspaceApi } from '../lib/api/workspace.js'
import {
  extractCompletionToken,
  extractSearchToken,
  formatAtMentionReplacement,
  formatAgentMentionReplacement,
  applyFileSuggestion,
  toWorkspaceRelative,
  insertTextAtCursor,
} from '../lib/at-mention.js'
import {
  MAX_ATTACHMENTS,
  attachmentRejection,
  fileToAttachment,
  formatBytes,
  revokeAttachment,
  revokeAttachments,
  extractDroppedFiles,
  extractImages,
} from '../lib/composer-attachments.js'
import {
  INITIAL_VISIBLE,
  getSlashFilter,
  groupEntries,
  rowFromSectionRow,
  clearSlashToken,
  SlashMenuIcon,
} from '../lib/slash-menu.jsx'

const MODE_PLACEHOLDERS = {
  agent: 'Describe your task… @file or @agent',
  ask: 'Ask about your codebase…',
  plan: 'Plan your implementation…',
}

const KIND_LABEL = { image: 'IMG', pdf: 'PDF', text: 'TXT', binary: 'BIN' }

/** Attachment-only sends still need message text for the transcript. */
function describeAttachments(list) {
  if (list.length === 1) return `(attached ${list[0].name})`
  return `(attached ${list.length} files)`
}

export default function InputArea() {
  const sendMessage = useChatStore(s => s.sendMessage)
  const isStreaming = useChatStore(s => s.isStreaming)
  const sessionLoading = useChatStore(s => s.sessionLoading)
  const isAwaitingInteraction = useChatStore(s => s.isAwaitingInteraction)
  const stopStreaming = useChatStore(s => s.stopStreaming)
  const workspace = useChatStore(s => s.workspace)
  const agentMode = useChatStore(s => s.agentMode)
  const cycleAgentMode = useChatStore(s => s.cycleAgentMode)
  const textareaRef = useRef(null)
  const fileInputRef = useRef(null)
  const slashMenuRef = useRef(null)
  const atMenuRef = useRef(null)
  const slashActiveRef = useRef(null)
  const [attachments, setAttachments] = useState([])
  const [attachError, setAttachError] = useState(null)
  const [dragOver, setDragOver] = useState(false)
  const [lightbox, setLightbox] = useState(null)
  const [inputValue, setInputValue] = useState('')
  const [cursorPos, setCursorPos] = useState(0)
  const [slashEntries, setSlashEntries] = useState([])
  const [slashIndex, setSlashIndex] = useState(0)
  const [expandedSections, setExpandedSections] = useState(new Set())
  const [atSuggestions, setAtSuggestions] = useState([])
  const [atIndex, setAtIndex] = useState(0)
  const [subagentMentions, setSubagentMentions] = useState([])
  const [uploadingDrop, setUploadingDrop] = useState(false)
  const [slashMenuSuppressed, setSlashMenuSuppressed] = useState(false)
  const [atMenuSuppressed, setAtMenuSuppressed] = useState(false)
  const attachmentsRef = useRef(attachments)
  attachmentsRef.current = attachments

  useEffect(() => {
    return () => revokeAttachments(attachmentsRef.current)
  }, [])

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const data = await agentApi.getSlashCommands(workspace || undefined)
        if (!cancelled && Array.isArray(data.entries)) {
          setSlashEntries(data.entries)
        }
      } catch {
        if (!cancelled) setSlashEntries([])
      }
    })()
    return () => {
      cancelled = true
    }
  }, [workspace])

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const data = await agentApi.getAgents(workspace || undefined)
        if (cancelled) return
        const list = Array.isArray(data.agents) ? data.agents : []
        setSubagentMentions(
          list.filter(a => (a.mode ?? 'subagent') !== 'primary'),
        )
      } catch {
        if (!cancelled) setSubagentMentions([])
      }
    })()
    return () => {
      cancelled = true
    }
  }, [workspace])

  const syncCursor = useCallback(() => {
    const el = textareaRef.current
    if (el) setCursorPos(el.selectionStart ?? 0)
  }, [])

  const slashFilter = useMemo(() => getSlashFilter(inputValue), [inputValue])

  const slashMatches = useMemo(() => {
    if (slashFilter === null) return []
    return slashEntries.filter(e =>
      e.name.toLowerCase().startsWith(slashFilter),
    )
  }, [slashEntries, slashFilter])

  const showSlashMenu =
    !slashMenuSuppressed &&
    slashFilter !== null &&
    slashEntries.length > 0 &&
    slashMatches.length > 0

  const atToken = useMemo(() => {
    if (showSlashMenu) return null
    return extractCompletionToken(inputValue, cursorPos, true)
  }, [inputValue, cursorPos, showSlashMenu])

  const showAtMenu =
    !atMenuSuppressed &&
    atToken?.token.startsWith('@') &&
    atSuggestions.length > 0 &&
    !showSlashMenu

  const slashGroups = useMemo(() => groupEntries(slashMatches), [slashMatches])

  const { slashMenuSections, slashMenuRows } = useMemo(() => {
    let flatIdx = 0
    const sections = slashGroups.map(group => {
      const expanded = expandedSections.has(group.label)
      const shown = expanded
        ? group.items
        : group.items.slice(0, INITIAL_VISIBLE)
      const hiddenCount = group.items.length - shown.length
      const rows = []

      for (const entry of shown) {
        rows.push({ kind: 'item', flatIdx: flatIdx++, entry })
      }
      if (hiddenCount > 0) {
        rows.push({ kind: 'more', flatIdx: flatIdx++, count: hiddenCount })
      } else if (expanded && group.items.length > INITIAL_VISIBLE) {
        rows.push({ kind: 'less', flatIdx: flatIdx++ })
      }

      return { label: group.label, icon: group.icon, rows }
    })

    const rows = sections.flatMap(section =>
      section.rows.map(row => rowFromSectionRow(section, row)),
    )
    return { slashMenuSections: sections, slashMenuRows: rows }
  }, [slashGroups, expandedSections])

  const toggleSlashSection = useCallback((groupLabel, expand) => {
    setExpandedSections(prev => {
      const next = new Set(prev)
      if (expand) next.add(groupLabel)
      else next.delete(groupLabel)
      return next
    })
  }, [])

  useEffect(() => {
    setSlashMenuSuppressed(false)
    if (slashFilter === null) {
      setSlashIndex(0)
      setExpandedSections(new Set())
      return
    }
    setSlashIndex(0)
  }, [slashFilter])

  useEffect(() => {
    setAtMenuSuppressed(false)
  }, [atToken?.token])

  useEffect(() => {
    setSlashIndex(i => Math.min(i, Math.max(0, slashMenuRows.length - 1)))
  }, [slashMenuRows.length])

  useEffect(() => {
    slashActiveRef.current?.scrollIntoView({ block: 'nearest' })
  }, [slashIndex, slashMenuRows])

  useEffect(() => {
    setAtIndex(0)
  }, [atToken?.token, atSuggestions.length])

  // Clear stale suggestions when workspace changes.
  useEffect(() => {
    setAtSuggestions([])
  }, [workspace])

  // Debounced @ search: agents + files (files retained; agents superimposed)
  useEffect(() => {
    if (!atToken?.token.startsWith('@') || showSlashMenu || !workspace) {
      setAtSuggestions([])
      return undefined
    }
    const searchToken = extractSearchToken(atToken).toLowerCase()
    let cancelled = false
    const timer = setTimeout(async () => {
      const agentEntries = subagentMentions
        .filter(a => {
          const type = String(a.agentType || '').toLowerCase()
          const label = String(a.label || '').toLowerCase()
          if (!searchToken) return true
          return type.includes(searchToken) || label.includes(searchToken)
        })
        .slice(0, 8)
        .map(a => ({
          kind: 'agent',
          agentType: a.agentType,
          label: a.label || a.agentType,
          path: a.agentType,
        }))

      let fileEntries = []
      try {
        const data = await workspaceApi.searchFiles(searchToken, workspace)
        if (Array.isArray(data.entries)) {
          fileEntries = data.entries.map(e => ({ ...e, kind: 'file' }))
        }
      } catch {
        fileEntries = []
      }
      if (!cancelled) {
        setAtSuggestions([...agentEntries, ...fileEntries])
      }
    }, 120)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [atToken, showSlashMenu, workspace, subagentMentions])

  useEffect(() => {
    if (!showSlashMenu && !showAtMenu) return undefined

    const onDocMouseDown = e => {
      const target = e.target
      if (slashMenuRef.current?.contains(target)) return
      if (atMenuRef.current?.contains(target)) return
      if (textareaRef.current?.contains(target)) return
      if (showSlashMenu) setSlashMenuSuppressed(true)
      if (showAtMenu) setAtMenuSuppressed(true)
    }

    document.addEventListener('mousedown', onDocMouseDown)
    return () => document.removeEventListener('mousedown', onDocMouseDown)
  }, [showSlashMenu, showAtMenu])

  const addFiles = useCallback(files => {
    const rejections = []
    const accepted = []
    for (const file of files) {
      const reason = attachmentRejection(file)
      if (reason) rejections.push(reason)
      else accepted.push(file)
    }

    const remaining = MAX_ATTACHMENTS - attachmentsRef.current.length
    if (accepted.length > remaining) {
      rejections.push(`Only ${MAX_ATTACHMENTS} attachments per message`)
    }
    const next = accepted.slice(0, remaining).map(fileToAttachment)
    const updated = [...attachmentsRef.current, ...next]
    attachmentsRef.current = updated
    setAttachments(updated)
    setAttachError(rejections.length > 0 ? rejections.join(' · ') : null)
  }, [])

  const removeAttachment = useCallback(idx => {
    const doomed = attachmentsRef.current[idx]
    if (doomed) revokeAttachment(doomed)
    const updated = attachmentsRef.current.filter((_, i) => i !== idx)
    attachmentsRef.current = updated
    setAttachments(updated)
  }, [])

  const handleInput = useCallback(e => {
    setInputValue(e.target.value)
    setCursorPos(e.target.selectionStart ?? 0)
    const el = textareaRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = Math.min(el.scrollHeight, 150) + 'px'
  }, [])

  const applySlashSelection = useCallback(
    entry => {
      const el = textareaRef.current
      if (!el) return
      const hint = entry.argumentHint ? ` ${entry.argumentHint}` : ' '
      const next = `/${entry.name}${hint}`
      el.value = next
      setInputValue(next)
      el.focus()
      const pos = `/${entry.name} `.length
      el.setSelectionRange(pos, pos)
      setCursorPos(pos)
      handleInput({ target: el })
    },
    [handleInput],
  )

  const activateSlashRow = useCallback(
    row => {
      if (row.kind === 'item') {
        applySlashSelection(row.entry)
      } else if (row.kind === 'more') {
        toggleSlashSection(row.groupLabel, true)
      } else if (row.kind === 'less') {
        toggleSlashSection(row.groupLabel, false)
      }
    },
    [applySlashSelection, toggleSlashSection],
  )

  const dismissSlashMenu = useCallback(() => {
    const el = textareaRef.current
    if (!el) return
    const next = clearSlashToken(el.value)
    el.value = next
    setInputValue(next)
    el.focus()
    setCursorPos(el.selectionStart ?? 0)
    handleInput({ target: el })
  }, [handleInput])

  const applyAtSelection = useCallback(
    entry => {
      const el = textareaRef.current
      if (!el || !atToken) return
      let replacementValue
      if (entry.kind === 'agent') {
        replacementValue = formatAgentMentionReplacement(entry.agentType, {
          quoted: true,
        })
      } else {
        const hasAtPrefix = atToken.token.startsWith('@')
        const needsQuotes = entry.path.includes(' ')
        replacementValue = formatAtMentionReplacement(entry.path, {
          hasAtPrefix,
          needsQuotes,
          isQuoted: atToken.isQuoted,
          isDir: entry.isDir,
        })
      }
      const { newInput, newCursorPos } = applyFileSuggestion(
        replacementValue,
        inputValue,
        atToken.token,
        atToken.startPos,
      )
      el.value = newInput
      setInputValue(newInput)
      el.setSelectionRange(newCursorPos, newCursorPos)
      setCursorPos(newCursorPos)
      el.focus()
      if (entry.kind === 'agent' || !entry.isDir) setAtSuggestions([])
      handleInput({ target: el })
    },
    [atToken, inputValue, handleInput],
  )

  const insertAtMentions = useCallback(
    relativePaths => {
      const el = textareaRef.current
      if (!el || relativePaths.length === 0) return
      const mentions = relativePaths
        .filter(Boolean)
        .map(p => (p.includes(' ') ? `@"${p}" ` : `@${p} `))
        .join('')
      insertTextAtCursor(el, mentions, setInputValue)
      setCursorPos(el.selectionStart ?? 0)
      handleInput({ target: el })
    },
    [handleInput],
  )

  const handleSend = useCallback(() => {
    const el = textareaRef.current
    if (!el) return
    const text = el.value.trim()
    if ((!text && attachments.length === 0) || isStreaming || sessionLoading)
      return
    el.value = ''
    setInputValue('')
    setCursorPos(0)
    el.style.height = 'auto'
    const outgoing = attachments
    attachmentsRef.current = []
    setAttachments([])
    setAttachError(null)
    setAtSuggestions([])
    sendMessage(text || describeAttachments(outgoing), outgoing)
  }, [sendMessage, isStreaming, sessionLoading, attachments])

  const handleKeyDown = useCallback(
    e => {
      if (showSlashMenu && slashMenuRows.length > 0) {
        if (e.key === 'ArrowDown') {
          e.preventDefault()
          setSlashIndex(i => (i + 1) % slashMenuRows.length)
          return
        }
        if (e.key === 'ArrowUp') {
          e.preventDefault()
          setSlashIndex(
            i => (i - 1 + slashMenuRows.length) % slashMenuRows.length,
          )
          return
        }
        if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey)) {
          e.preventDefault()
          activateSlashRow(slashMenuRows[slashIndex])
          return
        }
        if (e.key === 'Escape') {
          e.preventDefault()
          dismissSlashMenu()
          return
        }
      }

      if (showAtMenu) {
        if (e.key === 'ArrowDown') {
          e.preventDefault()
          setAtIndex(i => (i + 1) % atSuggestions.length)
          return
        }
        if (e.key === 'ArrowUp') {
          e.preventDefault()
          setAtIndex(i => (i - 1 + atSuggestions.length) % atSuggestions.length)
          return
        }
        if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey)) {
          e.preventDefault()
          applyAtSelection(atSuggestions[atIndex])
          return
        }
        if (e.key === 'Escape') {
          e.preventDefault()
          setAtMenuSuppressed(true)
          return
        }
      }

      if (e.key === 'Tab' && e.shiftKey && !showSlashMenu && !showAtMenu) {
        e.preventDefault()
        cycleAgentMode()
        return
      }

      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault()
        handleSend()
      }
    },
    [
      showSlashMenu,
      slashMenuRows,
      slashIndex,
      activateSlashRow,
      dismissSlashMenu,
      showAtMenu,
      atSuggestions,
      atIndex,
      applyAtSelection,
      handleSend,
      cycleAgentMode,
    ],
  )

  const handlePaste = useCallback(
    e => {
      // Only images are intercepted: pasting a file from the OS file manager
      // also puts its text path on the clipboard, which users expect to land
      // in the textarea.
      const files = extractImages(e.clipboardData)
      if (files.length > 0) {
        e.preventDefault()
        addFiles(files)
      }
    },
    [addFiles],
  )

  const [dropToWorkspace, setDropToWorkspace] = useState(false)

  const handleDragOver = useCallback(e => {
    e.preventDefault()
    setDragOver(true)
    setDropToWorkspace(e.shiftKey)
  }, [])

  const handleDragLeave = useCallback(e => {
    e.preventDefault()
    setDragOver(false)
    setDropToWorkspace(false)
  }, [])

  const handleDrop = useCallback(
    async e => {
      e.preventDefault()
      setDragOver(false)
      const files = extractDroppedFiles(e.dataTransfer)
      if (files.length === 0) return

      // Plain drop attaches to this message; Shift+drop copies into the
      // workspace so the agent can edit the file later.
      if (!e.shiftKey || !workspace) {
        addFiles(files)
        return
      }

      setUploadingDrop(true)
      try {
        const result = await workspaceApi.uploadFiles(workspace, files)
        const paths = (result.uploaded ?? []).map(u =>
          toWorkspaceRelative(u.path, workspace),
        )
        insertAtMentions(paths)
      } catch (err) {
        console.error('Drop upload failed:', err)
        setAttachError(err?.message || 'Workspace upload failed')
      } finally {
        setUploadingDrop(false)
      }
    },
    [addFiles, workspace, insertAtMentions],
  )

  const handleFileChange = useCallback(
    e => {
      const files = [...e.target.files]
      if (files.length > 0) addFiles(files)
      e.target.value = ''
    },
    [addFiles],
  )

  return (
    <div
      className={`input-area ${dragOver ? 'input-area--dragover' : ''}`}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {showSlashMenu && (
        <div
          className='slash-menu'
          ref={slashMenuRef}
          role='listbox'
          aria-label='Slash commands'
        >
          {slashMenuSections.map(section =>
            section.rows.length === 0 ? null : (
              <div key={section.label} className='slash-menu__group'>
                <div className='slash-menu__section'>{section.label}</div>
                {section.rows.map(row => {
                  const active = row.flatIdx === slashIndex
                  if (row.kind === 'item') {
                    return (
                      <button
                        key={`${row.entry.kind}-${row.entry.name}`}
                        type='button'
                        role='option'
                        aria-selected={active}
                        ref={active ? slashActiveRef : undefined}
                        className={`slash-menu__item${active ? ' slash-menu__item--active' : ''}`}
                        onMouseDown={ev => {
                          ev.preventDefault()
                          applySlashSelection(row.entry)
                        }}
                        onMouseEnter={() => setSlashIndex(row.flatIdx)}
                      >
                        <SlashMenuIcon type={section.icon} />
                        <span className='slash-menu__label'>
                          {row.entry.name}
                        </span>
                      </button>
                    )
                  }
                  if (row.kind === 'more') {
                    return (
                      <button
                        key={`more-${section.label}`}
                        type='button'
                        role='option'
                        aria-selected={active}
                        ref={active ? slashActiveRef : undefined}
                        className={`slash-menu__show-more${active ? ' slash-menu__show-more--active' : ''}`}
                        onMouseDown={ev => {
                          ev.preventDefault()
                          toggleSlashSection(section.label, true)
                        }}
                        onMouseEnter={() => setSlashIndex(row.flatIdx)}
                      >
                        Show {row.count} more
                      </button>
                    )
                  }
                  return (
                    <button
                      key={`less-${section.label}`}
                      type='button'
                      role='option'
                      aria-selected={active}
                      ref={active ? slashActiveRef : undefined}
                      className={`slash-menu__show-more${active ? ' slash-menu__show-more--active' : ''}`}
                      onMouseDown={ev => {
                        ev.preventDefault()
                        toggleSlashSection(section.label, false)
                      }}
                      onMouseEnter={() => setSlashIndex(row.flatIdx)}
                    >
                      Show less
                    </button>
                  )
                })}
              </div>
            ),
          )}
        </div>
      )}
      {showAtMenu && (
        <div
          className='slash-menu at-menu'
          ref={atMenuRef}
          role='listbox'
          aria-label='Mention suggestions'
        >
          {atSuggestions.some(e => e.kind === 'agent') && (
            <div className='slash-menu__section'>Agents</div>
          )}
          {atSuggestions.map((entry, idx) =>
            entry.kind === 'agent' ? (
              <button
                key={`agent-${entry.agentType}`}
                type='button'
                role='option'
                aria-selected={idx === atIndex}
                className={`slash-menu__item${idx === atIndex ? ' slash-menu__item--active' : ''}`}
                onMouseDown={ev => {
                  ev.preventDefault()
                  applyAtSelection(entry)
                }}
                onMouseEnter={() => setAtIndex(idx)}
              >
                <div className='slash-menu__row-top'>
                  <span className='slash-menu__name'>
                    @{entry.agentType} (agent)
                  </span>
                  <span className='slash-menu__badge'>agent</span>
                </div>
              </button>
            ) : null,
          )}
          {atSuggestions.some(e => e.kind !== 'agent') && (
            <div className='slash-menu__section'>Files</div>
          )}
          {atSuggestions.map((entry, idx) =>
            entry.kind === 'agent' ? null : (
              <button
                key={entry.path}
                type='button'
                role='option'
                aria-selected={idx === atIndex}
                className={`slash-menu__item${idx === atIndex ? ' slash-menu__item--active' : ''}`}
                onMouseDown={ev => {
                  ev.preventDefault()
                  applyAtSelection(entry)
                }}
                onMouseEnter={() => setAtIndex(idx)}
              >
                <div className='slash-menu__row-top'>
                  <span className='slash-menu__name'>
                    @{entry.path}
                    {entry.isDir ? '/' : ''}
                  </span>
                  {entry.isDir && (
                    <span className='slash-menu__badge'>dir</span>
                  )}
                </div>
              </button>
            ),
          )}
        </div>
      )}
      <div
        className={`input-wrapper input-wrapper--${agentMode} ${attachments.length > 0 ? 'has-images' : ''}`}
      >
        {attachments.length > 0 && (
          <div className='image-preview-bar'>
            {attachments.map((att, i) =>
              att.kind === 'image' ? (
                <div key={att.id} className='image-preview-item'>
                  <img
                    src={att.previewUrl}
                    alt={att.name}
                    title={att.name}
                    onClick={() => setLightbox(att.previewUrl)}
                  />
                  <button
                    className='image-preview-remove'
                    onClick={() => removeAttachment(i)}
                    title='Remove'
                  >
                    &times;
                  </button>
                </div>
              ) : (
                <div
                  key={att.id}
                  className='file-chip'
                  title={`${att.name} · ${formatBytes(att.size)}`}
                >
                  <span
                    className={`file-chip__kind file-chip__kind--${att.kind}`}
                  >
                    {KIND_LABEL[att.kind] ?? 'FILE'}
                  </span>
                  <span className='file-chip__name'>{att.name}</span>
                  <span className='file-chip__size'>
                    {formatBytes(att.size)}
                  </span>
                  <button
                    className='file-chip__remove'
                    onClick={() => removeAttachment(i)}
                    title='Remove'
                  >
                    &times;
                  </button>
                </div>
              ),
            )}
          </div>
        )}
        {attachError && (
          <div className='attach-error' role='alert'>
            {attachError}
            <button
              className='attach-error__dismiss'
              onClick={() => setAttachError(null)}
              title='Dismiss'
            >
              &times;
            </button>
          </div>
        )}
        <div className='input-row'>
          <ModePicker />
          <button
            className='attach-btn'
            onClick={() => fileInputRef.current?.click()}
            title='Attach files (images, PDF, CSV, …)'
            type='button'
          >
            <svg
              width='16'
              height='16'
              viewBox='0 0 24 24'
              fill='none'
              stroke='currentColor'
              strokeWidth='2'
              strokeLinecap='round'
              strokeLinejoin='round'
            >
              <path d='M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48' />
            </svg>
          </button>
          <input
            ref={fileInputRef}
            type='file'
            multiple
            style={{ display: 'none' }}
            onChange={handleFileChange}
          />
          <SchedulePicker />
          <textarea
            ref={textareaRef}
            className='input-textarea'
            rows='1'
            placeholder={
              MODE_PLACEHOLDERS[agentMode] ?? MODE_PLACEHOLDERS.agent
            }
            title='Enter to send · Shift+Tab switch mode · Shift+Enter newline'
            value={inputValue}
            onChange={handleInput}
            onKeyDown={handleKeyDown}
            onKeyUp={syncCursor}
            onClick={syncCursor}
            onSelect={syncCursor}
            onPaste={handlePaste}
            autoFocus
          />
          {isAwaitingInteraction ? (
            <button
              className='composer-btn composer-btn--stop'
              onClick={stopStreaming}
              title='Cancel'
              aria-label='Cancel'
              type='button'
            >
              <svg
                width='14'
                height='14'
                viewBox='0 0 24 24'
                fill='none'
                stroke='currentColor'
                strokeWidth='2.5'
                strokeLinecap='round'
              >
                <line x1='6' y1='6' x2='18' y2='18' />
                <line x1='18' y1='6' x2='6' y2='18' />
              </svg>
            </button>
          ) : isStreaming ? (
            <button
              className='composer-btn composer-btn--stop'
              onClick={stopStreaming}
              title='Stop'
              aria-label='Stop'
              type='button'
            >
              <svg
                width='14'
                height='14'
                viewBox='0 0 24 24'
                fill='currentColor'
              >
                <rect x='6' y='6' width='12' height='12' rx='2' />
              </svg>
            </button>
          ) : (
            <button
              className='composer-btn composer-btn--send'
              onClick={handleSend}
              title={sessionLoading ? 'Loading conversation…' : 'Send (Enter)'}
              type='button'
              disabled={
                sessionLoading ||
                (!inputValue.trim() && attachments.length === 0)
              }
            >
              <svg
                width='16'
                height='16'
                viewBox='0 0 24 24'
                fill='none'
                stroke='currentColor'
                strokeWidth='2.5'
                strokeLinecap='round'
                strokeLinejoin='round'
              >
                <line x1='12' y1='19' x2='12' y2='5' />
                <polyline points='5 12 12 5 19 12' />
              </svg>
            </button>
          )}
        </div>
      </div>
      {dragOver && (
        <div className='drop-overlay'>
          {uploadingDrop
            ? 'Uploading…'
            : dropToWorkspace
              ? 'Drop to copy into the workspace as @path'
              : 'Drop to attach · hold Shift to copy into the workspace'}
        </div>
      )}
      {lightbox && (
        <div className='lightbox' onClick={() => setLightbox(null)}>
          <img src={lightbox} alt='Preview' />
        </div>
      )}
    </div>
  )
}
