import { describe, expect, it } from 'vitest'

globalThis.localStorage = {
  getItem: () => null,
  setItem: () => {},
  removeItem: () => {},
}

const { planApprovalActionLabels } = await import('./PlanApprovalCard.jsx')

describe('planApprovalActionLabels', () => {
  it('keeps Build unchanged while Keep planning is submitted', () => {
    expect(planApprovalActionLabels('keep-planning')).toEqual({
      keepPlanning: 'Keeping…',
      build: 'Build',
    })
  })

  it('only shows Building while Build is submitted', () => {
    expect(planApprovalActionLabels('build')).toEqual({
      keepPlanning: 'Keep planning',
      build: 'Building…',
    })
  })
})
