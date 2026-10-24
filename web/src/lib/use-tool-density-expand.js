import { useStreamingExpanded } from './use-streaming-expanded.js'
import { resolveExpandArgs, resolveChevron } from './tool-density-policy.js'

/**
 * Hook: density-aware expand state for tool rows.
 *
 * @param {import('./tool-density-policy.js').DensityKind} kind
 * @param {import('./tool-density-policy.js').DensityContext} ctx
 * @returns {[boolean, () => void, { showChevron: boolean }]}
 */
export function useToolDensityExpand(kind, ctx = {}) {
  const { isRunning, expandOnceWhen } = resolveExpandArgs(kind, ctx)
  const [expanded, toggle, setExpanded] = useStreamingExpanded(isRunning, {
    expandOnceWhen,
  })
  const chevron = resolveChevron(kind, {
    ...ctx,
  })
  return [expanded, toggle, chevron, setExpanded]
}
