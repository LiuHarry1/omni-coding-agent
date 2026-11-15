import * as path from 'path'
import type { MarketplaceProviderConfig } from '../../core/types.js'
import { resolveSettings } from '../../utils/settings/manager.js'
import { DemeterProvider } from './demeter-provider.js'
import { MarketplaceError, validateProviderURL } from './http.js'
import { SkillsShProvider } from './skills-sh-provider.js'
import type { MarketplaceProvider } from './types.js'

const cache = new Map<
  string,
  { signature: string; provider: MarketplaceProvider }
>()

function createProvider(
  config: MarketplaceProviderConfig,
): MarketplaceProvider {
  validateProviderURL(config)
  if (config.type === 'demeter') return new DemeterProvider(config)
  if (config.type === 'skills-sh') return new SkillsShProvider(config)
  throw new MarketplaceError(
    `Unsupported marketplace provider type: ${String(config.type)}`,
    500,
  )
}

export function getMarketplaceProviders(cwd: string): MarketplaceProvider[] {
  const configs =
    resolveSettings(cwd).config.marketplaces?.providers.filter(
      config => config.enabled !== false,
    ) ?? []
  // Keyed per workspace so two workspaces that define the same provider id
  // with different settings do not keep evicting each other's instance.
  const scope = path.resolve(cwd)
  return configs.map(config => {
    const key = `${scope}\0${config.id}`
    const signature = JSON.stringify(config)
    const current = cache.get(key)
    if (current?.signature === signature) return current.provider
    const provider = createProvider(config)
    cache.set(key, { signature, provider })
    return provider
  })
}

export function getMarketplaceProvider(
  cwd: string,
  id: string,
): MarketplaceProvider {
  const provider = getMarketplaceProviders(cwd).find(
    candidate => candidate.config.id === id,
  )
  if (!provider) {
    throw new MarketplaceError(`Unknown marketplace provider '${id}'`, 404)
  }
  return provider
}

export function marketplaceProviderSummary(provider: MarketplaceProvider) {
  return {
    id: provider.config.id,
    type: provider.config.type,
    label: provider.config.label ?? provider.config.id,
    capabilities: provider.capabilities,
    auth:
      provider.config.auth ??
      (provider.config.type === 'demeter' ? 'cookie-proxy' : 'none'),
  }
}
