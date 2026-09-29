/*
Copyright (C) 2023-2026 QuantumNous

This program is free software: you can redistribute it and/or modify
it under the terms of the GNU Affero General Public License as
published by the Free Software Foundation, either version 3 of the
License, or (at your option) any later version.

This program is distributed in the hope that it will be useful,
but WITHOUT ANY WARRANTY; without even the implied warranty of
MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
GNU Affero General Public License for more details.

You should have received a copy of the GNU Affero General Public License
along with this program. If not, see <https://www.gnu.org/licenses/>.

For commercial licensing, please contact support@quantumnous.com
*/
// Reads a frozen step's parameter snapshot and turns it into something a
// first-time user can read. The backend stores steps as a JSON string of the
// capability's own parameter keys, so the naive rendering — `aspect_ratio=16:9`
// · `duration=5` — leaked both schema keys and opaque tokens onto the page.
//
// Everything here is pure and separately unit-tested; the page only renders.

import {
  humanParamLabel,
  humanParamValueText,
  hasReferenceImage,
  referenceCount,
} from '../terminology'

/** Keys worth showing in a summary, in the order a reader wants them. */
const SPEC_DISPLAY_KEYS = [
  'size',
  'aspect_ratio',
  'resolution',
  'duration',
  'seconds',
  'count',
  'n',
  'generate_audio',
  'enable_audio',
] as const

export type SpecChip = {
  key: string
  /** Readable label, e.g. 画面比例. */
  label: string
  /** Readable value, e.g. 16:9 or 5 秒. */
  value: string
}

export type SpecSummary = {
  /** Display-ready lines; empty when the step declared no notable settings. */
  chips: SpecChip[]
  /** Same content joined for single-line display. */
  summary: string
  inputMode: string
  /** How many reference images the step actually carries. */
  referenceCount: number
  prompt: string
}

function parseParameters(parametersRaw: string): Record<string, unknown> {
  if (!parametersRaw) return {}
  try {
    const parsed = JSON.parse(parametersRaw)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {}
  } catch {
    return {}
  }
}

function isEmptyValue(value: unknown): boolean {
  if (value === undefined || value === null || value === '') return true
  return Array.isArray(value) && value.length === 0
}

function chipFrom(key: string, value: unknown): SpecChip {
  return {
    key,
    label: humanParamLabel(key),
    value: humanParamValueText(key, value),
  }
}

/**
 * Summarizes a frozen step's parameters for the confirmation panel and the
 * run-status list. Unknown keys are ignored rather than dumped, so a plugin can
 * add a parameter without this function printing it raw.
 */
export function summarizeStepSpec(parametersRaw: string): SpecSummary {
  const parsed = parseParameters(parametersRaw)
  const chips: SpecChip[] = []

  for (const key of SPEC_DISPLAY_KEYS) {
    const value = parsed[key]
    if (isEmptyValue(value)) continue
    chips.push(chipFrom(key, value))
  }

  const prompt = typeof parsed.prompt === 'string' ? parsed.prompt : ''

  return {
    chips,
    summary: chips.map((chip) => `${chip.label} ${chip.value}`).join(' · '),
    inputMode: hasReferenceImage(parsed) ? '参考图驱动' : '纯文字生成',
    referenceCount: referenceCount(parsed),
    prompt,
  }
}

/**
 * "已用 2 / 最多 4 张" — makes the capability's own limit visible instead of
 * letting the user submit past it and get an upstream rejection.
 */
export function describeReferenceUsage(
  parametersRaw: string,
  limits?: Record<string, number>
): string {
  const used = referenceCount(parseParameters(parametersRaw))
  const max =
    typeof limits?.maxImages === 'number' && limits.maxImages > 0
      ? limits.maxImages
      : null
  if (max === null) return `已用 ${used} 张参考图`
  return `已用 ${used} / 最多 ${max} 张参考图`
}
