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
// User-facing vocabulary for the AI design workbench.
//
// The backend contract (types.ts) stays in engineering terms on purpose: it
// mirrors /api/design/* and the design doc. This module is the single place
// that translates those terms into language a first-time user can act on, so
// the page never has to render a raw field name.

/**
 * Capability parameter keys whose values are opaque upstream tokens
 * (`1024x1024`, `2K`, `21:9`) and must never reach the user verbatim.
 * Maps the schema key to a readable label.
 */
const PARAM_LABELS: Record<string, string> = {
  prompt: '画面描述',
  negative_prompt: '不要出现的内容',
  size: '图片尺寸',
  aspect_ratio: '画面比例',
  resolution: '清晰度',
  quality: '生成质量',
  count: '生成数量',
  n: '生成数量',
  duration: '视频时长',
  seconds: '视频时长',
  model: '模型',
  background: '背景',
  style: '风格',
  seed: '随机种子',
  footnote: '水印文字',
  image: '参考图',
  reference_images: '参考图',
  first_frame_image: '首帧图片',
  last_frame_image: '尾帧图片',
  input_fidelity: '参考图还原度',
  revise: '自动优化描述',
  enable_audio: '生成声音',
  generate_audio: '生成声音',
}

/** Opaque enum values that need a readable form. */
const PARAM_VALUE_LABELS: Record<string, string> = {
  '1024x1024': '方形 1:1（1024×1024）',
  '1024x1536': '竖版 2:3（1024×1536）',
  '1536x1024': '横版 3:2（1536×1024）',
  '1K': '标准（1K）',
  '2K': '高清（2K）',
  '4K': '超清（4K）',
  low: '快速',
  medium: '标准',
  high: '精细',
  '480P': '标清 480P',
  '720P': '高清 720P',
  '1080P': '全高清 1080P',
  transparent: '透明背景',
  opaque: '纯色背景',
  '1:1': '方形 1:1',
  '3:4': '竖版 3:4',
  '4:3': '横版 4:3',
  '16:9': '宽屏 16:9',
  '9:16': '竖屏 9:16',
  '21:9': '超宽 21:9',
}

/** Values that mark the recommended pick in a select, so newcomers need not guess. */
const RECOMMENDED_VALUES = new Set(['medium', '2K', '1:1'])

/**
 * Translates a schema field name into a label the user can understand.
 *
 * Precedence: the schema's own `title` wins, because the plugin author writes
 * it for that specific model. The generic map is the fallback for schemas that
 * ship no title, and the de-underscored name is the last resort.
 */
export function humanParamLabel(name: string, title?: string): string {
  if (title && title.trim() !== '') return title
  const mapped = PARAM_LABELS[name]
  if (mapped) return mapped
  return name
}

/** Translates an opaque enum value. Unknown values pass through untouched. */
export function humanParamValue(value: string): string {
  return PARAM_VALUE_LABELS[value] ?? value
}

/** True when a value is the safe default worth pre-selecting. */
export function isRecommendedValue(value: string): boolean {
  return RECOMMENDED_VALUES.has(value)
}

/**
 * Parameters whose raw value is a bare number the user reads as a count, and
 * which therefore need a unit appended. A duration of `5` means nothing on its
 * own; "5 秒" does.
 */
const PARAM_VALUE_UNITS: Record<string, (value: string) => string> = {
  duration: (value) => `${value} 秒`,
  seconds: (value) => `${value} 秒`,
  count: (value) => `${value} 张`,
  n: (value) => `${value} 张`,
}

/**
 * Renders a parameter's value on its own, with a unit where one is needed and
 * opaque tokens (1024x1024, 2K) turned into words. Separated from
 * `humanParamLabel` so callers that lay out label and value separately do not
 * have to split a joined string.
 */
export function humanParamValueText(name: string, value: unknown): string {
  if (typeof value === 'boolean') return value ? '开启' : '关闭'
  const text = typeof value === 'string' ? value : String(value)
  const withUnit = PARAM_VALUE_UNITS[name]
  return withUnit ? withUnit(text) : humanParamValue(text)
}

/**
 * Renders one parameter for a read-only summary line, e.g.
 * `aspect_ratio=16:9` becomes `画面比例 16:9`. Boolean flags read as
 * "生成声音 开启" rather than "generate_audio=true".
 */
export function humanParamSummary(name: string, value: unknown): string {
  return `${humanParamLabel(name)} ${humanParamValueText(name, value)}`
}


/**
 * Parameter keys a newcomer rarely needs to touch. Everything else renders in
 * the main form; these collapse into an "advanced options" disclosure so the
 * first screen stays at three or four fields.
 */
const ADVANCED_PARAM_KEYS = new Set([
  'seed',
  'footnote',
  'input_fidelity',
  'revise',
  'enable_audio',
  'generate_audio',
  'background',
  'style',
  'quality',
])

export function isAdvancedParam(name: string): boolean {
  return ADVANCED_PARAM_KEYS.has(name)
}

/**
 * Project status, phrased as "where am I now" rather than as a state-machine
 * node name. Keys match the backend `status` field.
 */
export const PROJECT_STATUS_TEXT: Record<string, string> = {
  draft: '填写需求',
  awaiting_confirmation: '待确认',
  ready: '可生成',
  generating: '生成中',
  review: '待查看',
  completed: '已完成',
  partial: '部分完成',
}

/** One-line explanation of the current status, shown under the step bar. */
export const PROJECT_STATUS_HINT: Record<string, string> = {
  draft: '填好画面描述，选好模型就可以生成。',
  awaiting_confirmation: '核对产出和费用后即可开始生成。',
  ready: '已确认，随时可以开始生成。',
  generating: '正在生成，产出会逐件出现在画板中。',
  review: '生成完成，挑选满意的版本下载使用。',
  completed: '全部产出已完成。',
  partial: '部分产出失败，成功的部分仍可正常使用。',
}

/** Step status inside the run list. */
export const STEP_STATUS_TEXT: Record<string, string> = {
  pending: '排队中',
  submitted: '生成中',
  succeeded: '已完成',
  failed: '失败',
}

/**
 * Failure reasons rewritten as "what happened / what to do". The backend
 * `failure_class` values are engineering taxonomy; users need the remedy.
 */
export const FAILURE_TEXT: Record<string, { reason: string; action: string }> = {
  submission_rejected: {
    reason: '提交没有成功，未产生费用。',
    action: '可以直接重试。',
  },
  parameter_rejected: {
    reason: '模型不接受当前参数组合。',
    action: '调整参数后重试。',
  },
  upstream_failed: {
    reason: '生成服务执行失败。',
    action: '已产生任务，请稍后查看结果或联系管理员。',
  },
}

/** Delivery form, described by what the user gets back. */
export const KIND_TEXT: Record<'image' | 'video', { label: string; hint: string }> = {
  image: { label: '图片', hint: '生成海报、插画、封面等静态图片' },
  video: { label: '视频', hint: '生成短片、动态素材等视频' },
}

/**
 * Schema keys that carry a reference image. A non-empty value on any of them
 * switches the upstream tool into image-to-image mode — see
 * workbuddy-agent-kit/05-media-generation: "When an image parameter is
 * provided, it performs image-to-image transformation".
 */
export const REFERENCE_PARAM_KEYS = new Set([
  'image',
  'first_frame_image',
  'last_frame_image',
  'reference_images',
])

/**
 * The plugin's own append-hint for a field, e.g. image prompt's
 * "保持主体清晰、构图完整、光影自然统一". The backend never enforces these as
 * hard constraints, but they are the model's stated requirements, so hiding
 * them makes results worse in a way the user cannot debug.
 */
export function promptAppendHint(
  property: { 'x-append'?: unknown } | undefined
): string | null {
  const raw = property?.['x-append']
  if (typeof raw !== 'string') return null
  const trimmed = raw.trim()
  return trimmed === '' ? null : trimmed
}

/**
 * How many reference images the capability accepts. The plugin declares this as
 * `referenceLimits.maxImages`, and per-item `maxItems` is the fallback; the
 * upstream tools cap out at three.
 */
export function referenceLimit(
  limits: Record<string, number> | undefined,
  propertyMaxItems: number | undefined
): number {
  const fromLimits = limits?.maxImages
  if (typeof fromLimits === 'number' && fromLimits > 0) return fromLimits
  if (typeof propertyMaxItems === 'number' && propertyMaxItems > 0) {
    return propertyMaxItems
  }
  return 3
}

/**
 * True when the given parameters contain at least one reference image, which
 * is what makes a generation "image-to-image" rather than "text-to-image".
 */
export function hasReferenceImage(
  parameters: Record<string, unknown> | null | undefined
): boolean {
  if (!parameters) return false
  for (const key of REFERENCE_PARAM_KEYS) {
    const value = parameters[key]
    if (Array.isArray(value) && value.length > 0) return true
    if (typeof value === 'string' && value.trim() !== '') return true
    if (value != null && !(Array.isArray(value) || typeof value === 'string')) {
      return true
    }
  }
  return false
}

/** Count of reference images across all reference-shaped keys. */
export function referenceCount(
  parameters: Record<string, unknown> | null | undefined
): number {
  if (!parameters) return 0
  let total = 0
  for (const key of REFERENCE_PARAM_KEYS) {
    const value = parameters[key]
    if (Array.isArray(value)) {
      total += value.filter(
        (item) => typeof item === 'string' && item.trim() !== ''
      ).length
    } else if (typeof value === 'string' && value.trim() !== '') {
      total += 1
    }
  }
  return total
}

/**
 * Default semantic roles offered as one-tap choices, so the field is optional
 * in practice. Phase 1 is single-role; these cover the common cases.
 */
export const ROLE_PRESETS: { value: string; label: string }[] = [
  { value: '主视觉', label: '主视觉' },
  { value: '封面图', label: '封面图' },
  { value: '场景图', label: '场景图' },
  { value: '产品图', label: '产品图' },
  { value: '细节图', label: '细节图' },
]

/** Fields the user must fill before a project can be planned. */
export function missingRequiredFields(
  hasPrompt: boolean,
  capabilityId: string,
  tokenId: number
): string[] {
  const missing: string[] = []
  if (!hasPrompt) missing.push('画面描述')
  if (capabilityId === '') missing.push('模型')
  if (tokenId === 0) missing.push('扣费账户')
  return missing
}

/**
 * The single main line every design task follows. The backend state machine
 * (design doc §4.2) has more states than a user needs to reason about, so the
 * UI projects them onto these four steps and never shows the raw status.
 */
export const STEPS = [
  { key: 'entry', label: '选择类型' },
  { key: 'brief', label: '描述需求' },
  { key: 'preview', label: '确认生成' },
  { key: 'result', label: '查看结果' },
] as const

export type StepKey = (typeof STEPS)[number]['key']
