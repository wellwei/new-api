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
import { describe, expect, it } from 'vitest'

import {
  hasReferenceImage,
  humanParamLabel,
  humanParamValueText,
  promptAppendHint,
  referenceCount,
  referenceLimit,
} from '../../terminology'
import { describeReferenceUsage, summarizeStepSpec } from '../spec-summary'

describe('spec-summary: schema keys never reach the page', () => {
  it('renders a video step without leaking field names', () => {
    const spec = summarizeStepSpec(
      JSON.stringify({
        prompt: 'A quiet mountain lake at sunrise',
        aspect_ratio: '16:9',
        resolution: '768P',
        duration: 5,
        enable_audio: true,
      })
    )

    expect(spec.chips).toEqual([
      { key: 'aspect_ratio', label: '画面比例', value: '宽屏 16:9' },
      { key: 'resolution', label: '清晰度', value: '768P' },
      { key: 'duration', label: '视频时长', value: '5 秒' },
      { key: 'enable_audio', label: '生成声音', value: '开启' },
    ])
    // The old rendering was "aspect_ratio=16:9 · resolution=720P".
    expect(spec.summary).not.toContain('aspect_ratio')
    expect(spec.summary).not.toContain('=')
    expect(spec.inputMode).toBe('纯文字生成')
  })

  it('appends a unit to bare counts so a number is never shown alone', () => {
    const spec = summarizeStepSpec(JSON.stringify({ count: 3, duration: 10 }))
    expect(spec.chips).toEqual([
      { key: 'duration', label: '视频时长', value: '10 秒' },
      { key: 'count', label: '生成数量', value: '3 张' },
    ])
  })

  it('treats an empty array and empty string as absent, not as a value', () => {
    const spec = summarizeStepSpec(
      JSON.stringify({ aspect_ratio: '', count: [], duration: null })
    )
    expect(spec.chips).toEqual([])
    expect(spec.summary).toBe('')
  })

  it('detects reference-image mode from every reference-shaped key', () => {
    expect(
      summarizeStepSpec(JSON.stringify({ image: ['https://x/a.png'] })).inputMode
    ).toBe('参考图驱动')
    expect(
      summarizeStepSpec(JSON.stringify({ first_frame_image: 'https://x/a.png' }))
        .inputMode
    ).toBe('参考图驱动')
    // An empty array is not a reference; it stays text-to-image.
    expect(summarizeStepSpec(JSON.stringify({ image: [] })).inputMode).toBe(
      '纯文字生成'
    )
  })

  it('survives malformed JSON rather than throwing', () => {
    const spec = summarizeStepSpec('{not json')
    expect(spec.chips).toEqual([])
    expect(spec.inputMode).toBe('纯文字生成')
    expect(spec.prompt).toBe('')
  })

  it('ignores keys it has no label for instead of printing them raw', () => {
    const spec = summarizeStepSpec(
      JSON.stringify({ prompt: 'x', some_future_knob: 'zzz' })
    )
    expect(spec.summary).toBe('')
  })
})

describe('describeReferenceUsage', () => {
  it('states the capability limit so users do not overshoot it', () => {
    const raw = JSON.stringify({ image: ['a', 'b'] })
    expect(describeReferenceUsage(raw, { maxImages: 4 })).toBe(
      '已用 2 / 最多 4 张参考图'
    )
  })

  it('falls back to a plain count when no limit is declared', () => {
    expect(describeReferenceUsage(JSON.stringify({ image: ['a'] }))).toBe(
      '已用 1 张参考图'
    )
  })
})

describe('terminology: reference detection and hints', () => {
  it('counts only non-blank reference entries', () => {
    expect(referenceCount({ image: ['a', '', '  ', 'b'] })).toBe(2)
    expect(referenceCount({ image: [] })).toBe(0)
    expect(referenceCount(null)).toBe(0)
  })

  it('prefers the capability limit, then maxItems, then the tool cap', () => {
    expect(referenceLimit({ maxImages: 4 }, 2)).toBe(4)
    expect(referenceLimit(undefined, 3)).toBe(3)
    expect(referenceLimit(undefined, undefined)).toBe(3)
  })

  it("reads the plugin's x-append requirement and ignores an empty one", () => {
    expect(promptAppendHint({ 'x-append': '保持主体清晰' })).toBe('保持主体清晰')
    expect(promptAppendHint({ 'x-append': '   ' })).toBeNull()
    expect(promptAppendHint({})).toBeNull()
    expect(promptAppendHint(undefined)).toBeNull()
  })

  it('translates opaque values but leaves unknown ones alone', () => {
    expect(humanParamValueText('size', '1024x1024')).toBe('方形 1:1（1024×1024）')
    expect(humanParamValueText('size', '999x999')).toBe('999x999')
    expect(humanParamValueText('revise', true)).toBe('开启')
  })

  it("prefers the plugin's own title over the generic label", () => {
    expect(humanParamLabel('prompt', '镜头与运动描述')).toBe('镜头与运动描述')
    expect(humanParamLabel('prompt')).toBe('画面描述')
  })

  it('has a label for every reference-shaped key it detects', () => {
    for (const key of ['image', 'reference_images', 'first_frame_image', 'last_frame_image']) {
      expect(hasReferenceImage({ [key]: 'https://x/a.png' })).toBe(true)
    }
  })
})
