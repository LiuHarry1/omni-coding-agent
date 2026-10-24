/**
 * Tool action labels: { loading, completed, error }.
 * One card flips the verb — not two separate UI steps.
 */

const LABELS = {
  edit: { loading: 'Editing', completed: 'Edited', error: 'Edit' },
  create: { loading: 'Creating', completed: 'Created', error: 'Create' },
  write: { loading: 'Creating', completed: 'Created', error: 'Create' },
  shell: { loading: 'Running', completed: 'Ran', error: 'Run' },
  shellBackground: { loading: 'Running', completed: 'Shell', error: 'Run' },
  read: { loading: 'Reading', completed: 'Read', error: 'Read' },
  grep: { loading: 'Grepping', completed: 'Grepped', error: 'Grep' },
  // Glob: Searching files / Searched files / Search files
  glob: {
    loading: 'Searching files',
    completed: 'Searched files',
    error: 'Search files',
  },
  await: { loading: 'Waiting', completed: 'Waited', error: 'Wait' },
  stop: { loading: 'Stopping', completed: 'Stopped', error: 'Stop' },
  delete: { loading: 'Deleting', completed: 'Deleted', error: 'Delete' },
  webSearch: {
    loading: 'Searching web',
    completed: 'Searched web',
    error: 'Search web',
  },
  webFetch: {
    loading: 'Fetching page',
    completed: 'Fetched page',
    error: 'Fetch page',
  },
  toolSearch: {
    loading: 'Searching tools',
    completed: 'Found tools',
    error: 'Search tools',
  },
  skill: { loading: 'Running skill', completed: 'Skill', error: 'Skill' },
  explore: {
    loading: 'Exploring',
    completed: 'Explored',
    error: 'Explore',
  },
  browser: {
    loading: 'Running',
    completed: 'Ran',
    error: 'Run',
  },
  mcp: { loading: 'Running', completed: 'Ran', error: 'Run' },
}

/**
 * @param {string} toolCase
 * @param {{ loading?: boolean, hasError?: boolean, isNewFile?: boolean, backgrounded?: boolean }} opts
 */
export function toolActionLabel(toolCase, opts = {}) {
  const {
    loading = false,
    hasError = false,
    isNewFile = false,
    backgrounded = false,
  } = opts
  let key = toolCase
  if (toolCase === 'edit' && isNewFile) key = 'create'
  if (toolCase === 'shell' && backgrounded && !loading && !hasError) {
    key = 'shellBackground'
  }
  const map = LABELS[key] ||
    LABELS[toolCase] || {
      loading: 'Working',
      completed: 'Done',
      error: 'Failed',
    }
  if (loading) return map.loading
  if (hasError) return map.error
  return map.completed
}

/**
 * Error polish: keep path/description when useful,
 * otherwise details become "attempted".
 * @param {string | null | undefined} details
 * @param {boolean} hasError
 */
export function toolErrorDetails(details, hasError) {
  if (!hasError) return details || ''
  const d = typeof details === 'string' ? details.trim() : ''
  if (!d || /^((running|ran|run) )?command$/i.test(d)) return 'attempted'
  return d
}

export { LABELS as TOOL_ACTION_LABELS }
