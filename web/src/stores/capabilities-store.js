import { create } from 'zustand'
import { capabilitiesApi } from '../lib/api/capabilities.js'
import {
  SAFE_DESKTOP_CAPABILITIES,
  validateCapabilitiesManifest,
} from './capabilities-model.js'

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error)
}

function errorStatus(error) {
  const status = Number(error?.status)
  if (Number.isInteger(status)) return status
  const match = errorMessage(error).match(/^HTTP (\d{3})(?:\b|:)/)
  return match ? Number(match[1]) : null
}

function retryableStatus(status) {
  return (
    status == null ||
    status === 408 ||
    status === 429 ||
    (status >= 500 && status <= 599)
  )
}

const sleep = delayMs =>
  new Promise(resolve => {
    setTimeout(resolve, delayMs)
  })

export function createCapabilitiesStore(
  api = capabilitiesApi,
  { retryDelays = [300, 750, 1500], sleepFn = sleep } = {},
) {
  let loadPromise = null

  return create((set, get) => {
    const runLoad = (force = false) => {
      if (!force && (get().status === 'ready' || get().status === 'legacy')) {
        return Promise.resolve(get().manifest)
      }
      if (loadPromise) return loadPromise

      set({ status: 'loading', loaded: false, error: null })

      loadPromise = (async () => {
        for (let attempt = 0; ; attempt += 1) {
          let payload
          try {
            payload = await api.get()
          } catch (error) {
            const status = errorStatus(error)
            if (status === 404) {
              set({
                status: 'legacy',
                loaded: true,
                error: errorMessage(error),
                profile: SAFE_DESKTOP_CAPABILITIES.profile,
                manifest: SAFE_DESKTOP_CAPABILITIES,
              })
              return SAFE_DESKTOP_CAPABILITIES
            }
            if (retryableStatus(status) && attempt < retryDelays.length) {
              await sleepFn(retryDelays[attempt])
              continue
            }
            set({
              status: 'unavailable',
              loaded: false,
              error: errorMessage(error),
            })
            return null
          }

          try {
            const manifest = validateCapabilitiesManifest(payload)
            set({
              status: 'ready',
              loaded: true,
              error: null,
              profile: manifest.profile,
              manifest,
            })
            return manifest
          } catch (error) {
            // Invalid contracts are not transient and must never masquerade
            // as a desktop server.
            set({
              status: 'unavailable',
              loaded: false,
              error: errorMessage(error),
            })
            return null
          }
        }
      })().finally(() => {
        loadPromise = null
      })

      return loadPromise
    }

    return {
      status: 'idle',
      loaded: false,
      error: null,
      profile: SAFE_DESKTOP_CAPABILITIES.profile,
      manifest: SAFE_DESKTOP_CAPABILITIES,
      load: () => runLoad(false),
      reload: () => runLoad(true),
    }
  })
}

export const useCapabilitiesStore = createCapabilitiesStore()
