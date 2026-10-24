import { defineScriptSuite } from '../lib/script-suite.js'

defineScriptSuite('session', [
  'test-session-live.ts',
  'test-turn-abort.ts',
  'test-work-fold.ts',
  'test-turn-timing.ts',
  'test-dump-prompts.ts',
  'test-invoked-skills-compact.ts',
  'test-workspace-preview.ts',
])
