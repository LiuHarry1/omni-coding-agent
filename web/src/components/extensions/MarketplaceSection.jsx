import { useMemo } from 'react'
import MarketplaceCatalog from './MarketplaceCatalog.jsx'
import { resolveMarketplaceTarget } from './extensions-capabilities.js'

export default function MarketplaceSection({
  scope = 'user',
  workspaceHandle,
  capability,
  onResourcesChanged,
}) {
  const resolution = useMemo(
    () => resolveMarketplaceTarget(capability, scope, workspaceHandle),
    [capability, scope, workspaceHandle],
  )
  const targetLabel = scope === 'workspace' ? 'Workspace' : 'User'

  return (
    <div className='extensions-section extensions-marketplace'>
      <div className='extensions-section__toolbar'>
        <div>
          <h2>Marketplace</h2>
          <p>
            Discover trusted skills, specialist agents, and extension bundles
            for the {targetLabel} target.
          </p>
        </div>
      </div>
      {!resolution.enabled ? (
        <div className='extensions-blank-state'>
          <span className='extensions-blank-state__mark'>◇</span>
          <h3>{targetLabel} Marketplace target unavailable</h3>
          <p title={resolution.reason}>{resolution.reason}</p>
        </div>
      ) : (
        <MarketplaceCatalog
          key={`${resolution.target.scope}:${resolution.target.environmentId || ''}:${resolution.target.cwd || ''}`}
          target={resolution.target}
          targetLabel={targetLabel}
          onInstalled={onResourcesChanged}
        />
      )}
    </div>
  )
}
