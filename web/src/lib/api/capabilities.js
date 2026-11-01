import { fetchJSON } from './_http.js'

export const capabilitiesApi = {
  get: () => fetchJSON('/capabilities'),
}
