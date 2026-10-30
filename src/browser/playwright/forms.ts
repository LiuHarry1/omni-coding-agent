/**
 * Filling several controls in one call.
 *
 * One bad ref must not lose the fields that did land, so every field reports its
 * own status instead of throwing, and the settle/drain runs once for the batch
 * rather than once per field.
 */

import type { Page } from 'playwright-core'
import { ACTION_TIMEOUT_MS } from '../limits.js'
import type {
  BrowserBackend,
  FilledField,
  FormField,
  FormFieldKind,
  ResolvedElement,
} from '../types.js'
import {
  DATE_RANGE_CALENDAR_MSG,
  isTypedDateRange,
  valuesMatch,
  writeText,
} from './fields.js'
import {
  briefError,
  describeElement,
  editableLocator,
  targetLocator,
} from './locator.js'
import { pickValue } from './pick.js'
import { throwIfUnarmedDestructiveDialog } from './overlays.js'
import { withActionWait } from './settle.js'
import { getPageForTarget } from './connect.js'
import { withInputFocus } from './focus.js'

export async function fillForm(
  backend: BrowserBackend,
  targetId: string,
  fields: FormField[],
  signal?: AbortSignal,
): Promise<FilledField[]> {
  return withInputFocus(backend, targetId, async () => {
    const page = await getPageForTarget(backend, targetId)
    const results: FilledField[] = []
    await withActionWait(page, targetId, async () => {
      for (const field of fields) {
        throwIfFormAborted(signal)
        results.push(await fillOneField(page, field))
      }
    })
    throwIfFormAborted(signal)
    throwIfUnarmedDestructiveDialog(page)
    return results
  })
}

function throwIfFormAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return
  const reason = signal.reason
  throw reason instanceof Error ? reason : new Error('Form fill was cancelled')
}

function isTruthy(value: string): boolean {
  return ['true', '1', 'yes', 'on', 'checked'].includes(
    value.trim().toLowerCase(),
  )
}

function isNativeEditable(el: ResolvedElement): boolean {
  return (
    el.tag === 'input' ||
    el.tag === 'textarea' ||
    el.role === 'textbox' ||
    el.role === 'searchbox' ||
    el.role === 'combobox'
  )
}

function inferKind(el: ResolvedElement): FormFieldKind {
  if (el.role === 'checkbox' || el.role === 'switch') return 'checkbox'
  if (el.role === 'radio') return 'radio'
  if (el.tag === 'select' || el.role === 'combobox' || el.role === 'listbox') {
    return 'combobox'
  }
  return 'textbox'
}

async function fillOneField(
  page: Page,
  field: FormField,
): Promise<FilledField> {
  let base = {
    ref: field.ref,
    role: field.kind ?? 'unknown',
    name: '',
  }
  try {
    const loc = await targetLocator(page, { ref: field.ref })
    const el = await describeElement(loc, field.ref)
    base = { ref: field.ref, role: el.role, name: el.name }
    const kind = field.kind ?? inferKind(el)

    if (kind === 'checkbox' || kind === 'radio') {
      const on = isTruthy(field.value)
      await loc.setChecked(on, { timeout: ACTION_TIMEOUT_MS })
      return { ...base, value: String(on), status: 'filled' }
    }

    if (kind === 'combobox' && el.tag !== 'select') {
      return {
        ...base,
        value: el.value,
        status: 'skipped',
        reason:
          'custom combobox: click the option ref from a snapshot; fill_form only writes native <select> and textboxes',
      }
    }

    if (kind === 'combobox' && el.tag === 'select') {
      const { selected } = await pickValue(loc, [field.value])
      return { ...base, value: selected.join(', '), status: 'filled' }
    }

    if (isTypedDateRange(el.name, field.value)) {
      return {
        ...base,
        value: el.value,
        status: 'skipped',
        reason: DATE_RANGE_CALENDAR_MSG,
      }
    }

    if (el.readOnly || el.disabled) {
      const reason = el.disabled
        ? 'field is disabled'
        : el.field !== 'self'
          ? 'nested control is readonly (display or computed). Snapshot again and use the inner editable textbox, or this value is set by the calendar / itemizations.'
          : 'field is readonly'
      return { ...base, value: el.value, status: 'skipped', reason }
    }

    if (kind === 'textbox' && el.field === 'self' && !isNativeEditable(el)) {
      return {
        ...base,
        value: el.value,
        status: 'skipped',
        reason: `ref is not an editable field (got ${el.tag}${el.role ? ` role=${el.role}` : ''}). Snapshot and use the inner textbox / combobox ref.`,
      }
    }

    const got = await writeText(editableLocator(loc, el.field), field.value)
    return valuesMatch(field.value, got)
      ? { ...base, value: got, status: 'filled' }
      : {
          ...base,
          value: got,
          status: 'failed',
          reason: 'the field did not keep the value',
        }
  } catch (err) {
    return { ...base, status: 'failed', reason: briefError(err, field.ref) }
  }
}
