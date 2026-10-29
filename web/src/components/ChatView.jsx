import {
  useRef,
  useEffect,
  useLayoutEffect,
  useState,
  useCallback,
  useMemo,
} from 'react'
import { useChatStore } from '../stores/chat-store.js'
import { buildFlatElements } from '../lib/bubbles/flat-elements.js'
import WelcomeScreen from './WelcomeScreen.jsx'
import TranscriptRow from './transcript/TranscriptRow.jsx'

/** Distance from bottom that still counts as "following" the stream. */
const PIN_THRESHOLD_PX = 80
/** While streaming, tolerate larger layout jitter before unpinning. */
const PIN_THRESHOLD_STREAMING_PX = 160
const SHOW_BUTTON_PX = 100
/** Already this close → skip writing scrollTop (avoids thrash). */
const ALREADY_BOTTOM_PX = 4
/** Mount at most this many recent bubbles; older ones load on demand. */
const INITIAL_VISIBLE = 40
const LOAD_MORE_STEP = 40
/**
 * Skip content-visibility on the newest N. Keep this high during streaming so
 * growing text/tool rows are never replaced by contain-intrinsic placeholders
 * (those inflate scrollHeight and break stick-to-bottom).
 */
const LIVE_TAIL = 8
const LIVE_TAIL_STREAMING = 16
/**
 * Air below the live edge (composer is outside this pane, so
 * overlayHeight / inputAreaGap stay 0). 20% of the chat column, 80–240px.
 */
const BOTTOM_INSET_RATIO = 0.2
const BOTTOM_INSET_MIN_PX = 80
const BOTTOM_INSET_MAX_PX = 240

function distanceFromBottom(el) {
  return el.scrollHeight - el.scrollTop - el.clientHeight
}

function computeBottomInsetPx(paneHeight) {
  if (!paneHeight || paneHeight < 80) return BOTTOM_INSET_MIN_PX
  return Math.min(
    BOTTOM_INSET_MAX_PX,
    Math.max(BOTTOM_INSET_MIN_PX, Math.round(paneHeight * BOTTOM_INSET_RATIO)),
  )
}

/** distanceFromBottom − overscroll. The air gap still counts as "at bottom". */
function logicalDistanceFromBottom(dist, insetPx) {
  return Math.max(0, dist - insetPx)
}

function bubbleFollowSig(b) {
  if (!b) return ''
  if (b.kind === 'assistant_text') {
    return `t:${b.content?.length ?? 0}:${b.streaming ? 1 : 0}`
  }
  if (b.kind === 'tool') {
    return `k:${b.status}:${b.liveLabel || ''}:${b.liveTask || ''}:${b.isError ? 1 : 0}:${String(b.result ?? '').length}`
  }
  if (b.kind === 'reasoning') {
    return `r:${b.content?.length ?? 0}`
  }
  return b.kind || ''
}

export default function ChatView() {
  // Zustand v5 dropped equalityFn on useStore; returning a fresh array from the
  // selector alone would trip React's useSyncExternalStore infinite-loop guard
  // (minified error #185). Select stable slices, then memo the view model.
  const bubbleOrder = useChatStore(s => s.bubbleOrder)
  const bubblesById = useChatStore(s => s.bubblesById)
  const currentSessionId = useChatStore(s => s.currentSessionId)
  const sessionLoading = useChatStore(s => s.sessionLoading)
  const isStreaming = useChatStore(s => s.isStreaming)
  const activeTurnId = useChatStore(s => s.activeTurnId)

  // sawLiveWork: sticky for this session view after we watch a generate.
  const sawLiveSessionRef = useRef(null)
  const sawLiveWorkRef = useRef(false)
  if (sawLiveSessionRef.current !== currentSessionId) {
    sawLiveSessionRef.current = currentSessionId
    sawLiveWorkRef.current = false
  }
  if (isStreaming) sawLiveWorkRef.current = true
  const unfoldLatestTurn = sawLiveWorkRef.current

  const flatElements = useMemo(
    () =>
      buildFlatElements(bubbleOrder, bubblesById, {
        isStreaming,
        activeTurnId,
        unfoldLatestTurn,
      }),
    [bubbleOrder, bubblesById, isStreaming, activeTurnId, unfoldLatestTurn],
  )

  const scrollRef = useRef(null)
  const messagesRef = useRef(null)
  const pinToBottomRef = useRef(true)
  const userUnpinnedRef = useRef(false)
  /** True once an unpin has actually left the near-bottom zone. */
  const leftBottomRef = useRef(false)
  const programmaticScrollRef = useRef(false)
  const userPointerRef = useRef(false)
  const stickRafRef = useRef(0)
  const stickDirtyRef = useRef(false)
  const [showScrollBtn, setShowScrollBtn] = useState(false)
  const [visibleCount, setVisibleCount] = useState(INITIAL_VISIBLE)
  const [bottomInsetPx, setBottomInsetPx] = useState(160)
  const hasMessages = flatElements.length > 0
  const liveTail = isStreaming ? LIVE_TAIL_STREAMING : LIVE_TAIL

  // Structural signature: new rows / groups.
  const flatStructureKey = useMemo(
    () =>
      flatElements
        .map(el => {
          if (el.type === 'work_group') {
            return `${el.id}:${el.state}:${el.defaultOpen ? 1 : 0}:${el.durationMs ?? ''}:${(el.memberIds || []).join(',')}`
          }
          if (el.type === 'tool_group') {
            return `${el.id}:${el.groupKind}:${(el.memberIds || []).join(',')}`
          }
          return el.id
        })
        .join('|'),
    [flatElements],
  )

  // Content signature for the live tail — text deltas / tool status must
  // re-trigger follow even when flatElements shape is unchanged.
  const streamFollowKey = useMemo(() => {
    if (!isStreaming) return ''
    const tail = flatElements.slice(-LIVE_TAIL_STREAMING)
    return tail
      .map(el => {
        if (el.type === 'work_group' || el.type === 'tool_group') {
          const ids = el.memberIds || []
          return `${el.id}:${ids.map(id => bubbleFollowSig(bubblesById[id])).join(',')}`
        }
        return `${el.id}:${bubbleFollowSig(bubblesById[el.bubbleId])}`
      })
      .join('|')
  }, [isStreaming, flatElements, bubblesById])

  useEffect(() => {
    setVisibleCount(INITIAL_VISIBLE)
  }, [currentSessionId])

  // Size the bottom spacer from the chat pane, not window vh — otherwise the
  // inset collapses in Electron side panels and stick lands flush on the input.
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const update = () => {
      setBottomInsetPx(computeBottomInsetPx(el.clientHeight))
    }
    update()
    const ro = new ResizeObserver(update)
    ro.observe(el)
    return () => ro.disconnect()
  }, [hasMessages, currentSessionId])

  const startIndex = Math.max(0, flatElements.length - visibleCount)
  const visibleElements = useMemo(
    () => flatElements.slice(startIndex),
    [flatElements, startIndex],
  )
  const hiddenCount = startIndex

  /**
   * Follow: coalesce to animation frames, but keep a dirty bit so
   * growth that lands after this frame's stick still gets a trailing follow.
   */
  const scheduleStickToBottom = useCallback(() => {
    if (!pinToBottomRef.current) return
    stickDirtyRef.current = true
    if (stickRafRef.current) return

    const run = () => {
      stickRafRef.current = 0
      if (!stickDirtyRef.current || !pinToBottomRef.current) return
      stickDirtyRef.current = false

      const el = scrollRef.current
      if (!el) return
      const dist = distanceFromBottom(el)
      if (dist > ALREADY_BOTTOM_PX) {
        programmaticScrollRef.current = true
        el.scrollTop = el.scrollHeight
      }
      stickRafRef.current = requestAnimationFrame(() => {
        stickRafRef.current = 0
        programmaticScrollRef.current = false
        if (!pinToBottomRef.current) return
        const el2 = scrollRef.current
        if (!el2) return
        if (
          distanceFromBottom(el2) > ALREADY_BOTTOM_PX ||
          stickDirtyRef.current
        ) {
          stickDirtyRef.current = false
          programmaticScrollRef.current = true
          el2.scrollTop = el2.scrollHeight
          requestAnimationFrame(() => {
            programmaticScrollRef.current = false
            if (stickDirtyRef.current) scheduleStickToBottom()
          })
        }
      })
    }

    stickRafRef.current = requestAnimationFrame(run)
  }, [])

  useEffect(() => {
    return () => {
      if (stickRafRef.current) cancelAnimationFrame(stickRafRef.current)
    }
  }, [])

  useLayoutEffect(() => {
    pinToBottomRef.current = true
    userUnpinnedRef.current = false
    leftBottomRef.current = false
    setShowScrollBtn(false)
    const el = scrollRef.current
    if (el) {
      programmaticScrollRef.current = true
      el.scrollTop = el.scrollHeight
      requestAnimationFrame(() => {
        programmaticScrollRef.current = false
      })
    }
  }, [currentSessionId])

  // New turn streaming: re-pin so a prior scroll-away does not hide the reply.
  useEffect(() => {
    if (!isStreaming) return
    pinToBottomRef.current = true
    userUnpinnedRef.current = false
    leftBottomRef.current = false
    scheduleStickToBottom()
  }, [isStreaming, activeTurnId, scheduleStickToBottom])

  useLayoutEffect(() => {
    scheduleStickToBottom()
  }, [
    flatStructureKey,
    streamFollowKey,
    visibleCount,
    bottomInsetPx,
    scheduleStickToBottom,
  ])

  // Resize of the transcript (and live slots) → follow. Re-bind when the
  // structure changes so newly mounted live slots are observed.
  useEffect(() => {
    const inner = messagesRef.current
    if (!inner || !hasMessages) return
    const ro = new ResizeObserver(() => {
      scheduleStickToBottom()
    })
    ro.observe(inner)
    inner.querySelectorAll('.msg-slot--live').forEach(node => ro.observe(node))
    return () => ro.disconnect()
  }, [
    currentSessionId,
    hasMessages,
    flatStructureKey,
    isStreaming,
    scheduleStickToBottom,
  ])

  const handleScroll = useCallback(() => {
    const el = scrollRef.current
    if (!el) return
    const dist = distanceFromBottom(el)
    const logicalDist = logicalDistanceFromBottom(dist, bottomInsetPx)
    setShowScrollBtn(logicalDist > SHOW_BUTTON_PX)
    if (programmaticScrollRef.current) return

    const threshold = isStreaming
      ? PIN_THRESHOLD_STREAMING_PX
      : PIN_THRESHOLD_PX

    if (userUnpinnedRef.current) {
      // logicalDist stays 0 for the whole spacer. Re-pinning on that trapped
      // the wheel: unpin → still "at bottom" → pin → stick → jitter.
      if (logicalDist > threshold) leftBottomRef.current = true
      else if (leftBottomRef.current) {
        pinToBottomRef.current = true
        userUnpinnedRef.current = false
        leftBottomRef.current = false
      }
      return
    }

    if (dist > threshold) {
      if (userPointerRef.current) {
        userUnpinnedRef.current = true
        pinToBottomRef.current = false
        return
      }
      // Layout/content-visibility jitter must not kill follow. Stick uses the
      // physical bottom (spacer fully in view), not the logical air-gap floor.
      if (pinToBottomRef.current) scheduleStickToBottom()
    }
  }, [isStreaming, bottomInsetPx, scheduleStickToBottom])

  const handleWheel = useCallback(e => {
    programmaticScrollRef.current = false
    if (e.deltaY < 0) {
      userUnpinnedRef.current = true
      pinToBottomRef.current = false
    }
  }, [])

  const handlePointerDown = useCallback(() => {
    programmaticScrollRef.current = false
    userPointerRef.current = true
  }, [])

  const handlePointerUp = useCallback(() => {
    userPointerRef.current = false
  }, [])

  const scrollToBottomSmooth = useCallback(() => {
    const el = scrollRef.current
    if (!el) return
    pinToBottomRef.current = true
    userUnpinnedRef.current = false
    leftBottomRef.current = false
    programmaticScrollRef.current = true
    el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' })
    window.setTimeout(() => {
      programmaticScrollRef.current = false
      pinToBottomRef.current = true
      userUnpinnedRef.current = false
      leftBottomRef.current = false
      setShowScrollBtn(false)
    }, 400)
  }, [])

  const loadEarlier = useCallback(() => {
    const el = scrollRef.current
    const prevHeight = el?.scrollHeight ?? 0
    const prevTop = el?.scrollTop ?? 0
    pinToBottomRef.current = false
    userUnpinnedRef.current = true
    setVisibleCount(c => Math.min(flatElements.length, c + LOAD_MORE_STEP))
    requestAnimationFrame(() => {
      if (!el) return
      const delta = el.scrollHeight - prevHeight
      programmaticScrollRef.current = true
      el.scrollTop = prevTop + delta
      requestAnimationFrame(() => {
        programmaticScrollRef.current = false
      })
    })
  }, [flatElements.length])

  return (
    <div className='chat-view-wrap'>
      <div
        className={isStreaming ? 'chat-view chat-view--streaming' : 'chat-view'}
        ref={scrollRef}
        onScroll={handleScroll}
        onWheel={handleWheel}
        onPointerDown={handlePointerDown}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerUp}
      >
        {sessionLoading ? (
          <div
            className='messages session-loading-state'
            ref={messagesRef}
            role='status'
            aria-live='polite'
            aria-busy='true'
          >
            <span className='session-loading-spinner' aria-hidden='true' />
            <span>Loading conversation…</span>
          </div>
        ) : !hasMessages ? (
          <WelcomeScreen />
        ) : (
          <div className='messages' ref={messagesRef}>
            {hiddenCount > 0 && (
              <button
                type='button'
                className='load-earlier-msgs'
                onClick={loadEarlier}
              >
                Show {Math.min(LOAD_MORE_STEP, hiddenCount)} earlier
                {hiddenCount > LOAD_MORE_STEP ? ` (${hiddenCount} hidden)` : ''}
              </button>
            )}
            {visibleElements.map((el, i) => {
              const absIndex = startIndex + i
              const fromEnd = flatElements.length - 1 - absIndex
              const skipContain = fromEnd < liveTail
              return (
                <div
                  key={el.id}
                  className={
                    skipContain
                      ? 'msg-slot msg-slot--live'
                      : 'msg-slot msg-slot--contain'
                  }
                >
                  <TranscriptRow
                    element={el}
                    streamingTail={isStreaming && fromEnd === 0}
                  />
                </div>
              )
            })}
            {/*
              Bottom inset air: stick-to-bottom lands on this spacer so the live
              edge sits mid-lower, not flush on the input.
            */}
            <div
              className='messages-scroll-spacer'
              style={{ height: bottomInsetPx }}
              aria-hidden='true'
            />
          </div>
        )}
      </div>
      {showScrollBtn && (
        <button
          className='scroll-to-bottom'
          onClick={scrollToBottomSmooth}
          title='Scroll to bottom'
          aria-label='Scroll to bottom'
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
            <polyline points='6 9 12 15 18 9' />
          </svg>
        </button>
      )}
    </div>
  )
}
