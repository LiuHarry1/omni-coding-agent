import { describe, expect, it } from 'vitest'

globalThis.localStorage = {
  getItem: () => null,
  setItem: () => {},
  removeItem: () => {},
}

const { panelTitle, taskRowText } = await import('./BackgroundTerminals.jsx')

const shell = {
  id: 'b1',
  type: 'local_bash',
  description: 'dev server',
  command: 'npm run dev',
}
const agent = {
  id: 'a1',
  type: 'local_agent',
  description: 'Audit the routes',
  agentType: 'Explore',
  activity: 'Read src/server/router.ts',
  toolUses: 3,
}

describe('background task panel', () => {
  it('counts terminals while only shells are running', () => {
    expect(panelTitle([shell])).toBe('1 background terminal')
    expect(panelTitle([shell, shell])).toBe('2 background terminals')
  })

  it('counts tasks once an agent is among them', () => {
    expect(panelTitle([agent])).toBe('1 background task')
    expect(panelTitle([shell, agent])).toBe('2 background tasks')
  })

  it('shows a shell by its command', () => {
    expect(taskRowText(shell)).toMatchObject({
      icon: '>_',
      label: 'dev server',
      detail: 'npm run dev',
    })
  })

  it('shows an agent by what it is doing', () => {
    expect(taskRowText(agent)).toMatchObject({
      label: 'Audit the routes',
      detail: 'Read src/server/router.ts',
      hint: 'Explore · 3 tool calls',
    })
    expect(
      taskRowText({ ...agent, activity: undefined, toolUses: 0 }),
    ).toMatchObject({ detail: 'Audit the routes', hint: 'Explore' })
  })
})
