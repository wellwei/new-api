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
import { parseTags } from '@/features/pricing/lib/filters'
import type { PricingModel } from '@/features/pricing/types'

export type AspectRatioId = '1:1' | '16:9' | '9:16' | '4:3' | '3:4'

export interface AspectRatioOption {
  id: AspectRatioId
  labelKey: string
  ratioLabel: string
  size: string
  widthClass: string
  heightClass: string
}

export const ASPECT_RATIOS: readonly AspectRatioOption[] = [
  {
    id: '1:1',
    labelKey: 'Square',
    ratioLabel: '1:1',
    size: '1024x1024',
    widthClass: 'w-4',
    heightClass: 'h-4',
  },
  {
    id: '16:9',
    labelKey: 'Landscape',
    ratioLabel: '16:9',
    size: '1792x1024',
    widthClass: 'w-5',
    heightClass: 'h-3',
  },
  {
    id: '9:16',
    labelKey: 'Portrait',
    ratioLabel: '9:16',
    size: '1024x1792',
    widthClass: 'w-3',
    heightClass: 'h-5',
  },
  {
    id: '4:3',
    labelKey: 'Standard 4:3',
    ratioLabel: '4:3',
    size: '1024x768',
    widthClass: 'w-4.5',
    heightClass: 'h-3.5',
  },
  {
    id: '3:4',
    labelKey: 'Vertical 3:4',
    ratioLabel: '3:4',
    size: '768x1024',
    widthClass: 'w-3.5',
    heightClass: 'h-4.5',
  },
] as const

export type StylePresetId =
  | 'none'
  | 'photorealistic'
  | 'illustration'
  | 'anime'
  | '3d-render'
  | 'watercolor'
  | 'minimalist'

export interface StylePresetOption {
  id: StylePresetId
  labelKey: string
  promptHint: string
}

export const STYLE_PRESETS: readonly StylePresetOption[] = [
  {
    id: 'none',
    labelKey: 'Default Style',
    promptHint: '',
  },
  {
    id: 'photorealistic',
    labelKey: 'Photorealistic',
    promptHint:
      'Photorealistic photography, natural lighting, crisp focus, rich surface detail',
  },
  {
    id: 'illustration',
    labelKey: 'Digital Illustration',
    promptHint:
      'Modern digital illustration, vibrant palette, balanced composition',
  },
  {
    id: 'anime',
    labelKey: 'Anime Style',
    promptHint:
      'Anime key visual illustration, cinematic lighting, refined linework',
  },
  {
    id: '3d-render',
    labelKey: '3D Render',
    promptHint:
      '3D octane render, studio lighting, physically based materials, soft shadows',
  },
  {
    id: 'watercolor',
    labelKey: 'Watercolor',
    promptHint:
      'Delicate watercolor painting, expressive brushwork, textured art paper',
  },
  {
    id: 'minimalist',
    labelKey: 'Minimalist Flat',
    promptHint:
      'Minimalist flat vector art, clean geometric shapes, harmonious colors',
  },
] as const

const IMAGE_MODEL_NAME_REGEX =
  /(image|imagen|dall-e|flux|midjourney|recraft|ideogram|sdxl|stable-diffusion|seedream|kolors|cogview|wanx)/i

const IMAGE_MODEL_TAGS = new Set([
  'image',
  'image-generation',
  'drawing',
  '生图',
  '图像生成',
  '图片生成',
  '绘图',
  'ai绘图',
  '文生图',
])

/**
 * Determine whether a model in the catalogue is an image generation model.
 */
export function isImageGenerationModel(model: PricingModel): boolean {
  if (model.supported_endpoint_types?.includes('image-generation')) {
    return true
  }
  const tags = parseTags(model.tags)
  if (tags.some((tag) => IMAGE_MODEL_TAGS.has(tag.toLowerCase()))) {
    return true
  }
  return IMAGE_MODEL_NAME_REGEX.test(model.model_name || '')
}

/**
 * Filter available image generation models from pricing data, falling back to
 * user model names when pricing metadata has not populated them.
 */
export function getAvailableImageModels(
  pricingModels: PricingModel[],
  fallbackModelNames: string[] = []
): PricingModel[] {
  const matched = pricingModels.filter(isImageGenerationModel)
  const seen = new Set(matched.map((m) => m.model_name))

  for (const name of fallbackModelNames) {
    if (!seen.has(name) && IMAGE_MODEL_NAME_REGEX.test(name)) {
      seen.add(name)
      matched.push({
        id: 0,
        model_name: name,
        quota_type: 0,
        model_ratio: 0,
        model_price: 0,
        completion_ratio: 1,
        enable_groups: [],
        supported_endpoint_types: ['openai'],
      })
    }
  }

  return matched
}

export type ImageInvocationProtocol = 'chat' | 'images'

/**
 * Decide whether a model should be invoked via `/v1/images/generations` or
 * `/v1/chat/completions` (used by multimodal image models such as
 * `gemini-3.1-flash-image`).
 */
export function resolveImageProtocol(
  model: PricingModel | null | undefined
): ImageInvocationProtocol {
  if (!model) return 'chat'
  const endpoints = model.supported_endpoint_types ?? []
  const hasImageGenerationEndpoint = endpoints.includes('image-generation')
  const hasChatEndpoint = endpoints.includes('openai')

  if (
    hasImageGenerationEndpoint &&
    !hasChatEndpoint &&
    !/gemini.*image/i.test(model.model_name)
  ) {
    return 'images'
  }
  return 'chat'
}

export interface ComposePromptArgs {
  prompt: string
  aspectRatio: AspectRatioId
  style: StylePresetId
  negativePrompt?: string
}

/**
 * Compose the prompt text sent to the image generation model.
 */
export function composeImagePrompt(args: ComposePromptArgs): string {
  const base = args.prompt.trim()
  const styleOption = STYLE_PRESETS.find((item) => item.id === args.style)
  const negative = args.negativePrompt?.trim()

  const details: string[] = []
  if (styleOption?.promptHint) {
    details.push(`Style: ${styleOption.promptHint}`)
  }
  if (args.aspectRatio) {
    details.push(`Aspect ratio: ${args.aspectRatio}`)
  }
  if (negative) {
    details.push(`Avoid: ${negative}`)
  }

  if (details.length === 0) {
    return `Please generate an image: ${base}`
  }

  return `Please generate an image: ${base}\n\n${details.join('\n')}`
}

export interface GeneratedImageItem {
  url: string
  revisedPrompt?: string
}

export interface ParsedImageGenerationResult {
  images: GeneratedImageItem[]
  text: string
  usage?: {
    promptTokens: number
    completionTokens: number
    totalTokens: number
  }
}

function normalizeImageCandidate(raw: string | undefined | null): string | null {
  if (!raw || typeof raw !== 'string') return null
  const trimmed = raw.trim()
  if (!trimmed) return null
  if (
    trimmed.startsWith('data:image/') ||
    trimmed.startsWith('https://') ||
    trimmed.startsWith('http://')
  ) {
    return trimmed
  }
  // Bare base64 payload
  return `data:image/png;base64,${trimmed}`
}

/**
 * Extract generated image URLs (data URLs or remote URLs) and any accompanying
 * text or token usage from either `/v1/chat/completions` or
 * `/v1/images/generations` responses.
 */
export function extractGeneratedImages(
  body: unknown
): ParsedImageGenerationResult {
  const images: GeneratedImageItem[] = []
  const seenUrls = new Set<string>()
  let text = ''

  const pushImage = (
    rawUrl: string | undefined | null,
    revisedPrompt?: string
  ) => {
    const normalized = normalizeImageCandidate(rawUrl)
    if (!normalized || seenUrls.has(normalized)) return
    seenUrls.add(normalized)
    images.push({ url: normalized, revisedPrompt })
  }

  if (!body || typeof body !== 'object') {
    return { images, text }
  }

  const record = body as Record<string, unknown>

  // 1. Standard OpenAI `/v1/images/generations` response (`data[]`)
  if (Array.isArray(record.data)) {
    for (const item of record.data) {
      if (!item || typeof item !== 'object') continue
      const entry = item as Record<string, unknown>
      const revisedPrompt =
        typeof entry.revised_prompt === 'string'
          ? entry.revised_prompt
          : undefined
      if (typeof entry.url === 'string') {
        pushImage(entry.url, revisedPrompt)
      } else if (typeof entry.b64_json === 'string') {
        pushImage(entry.b64_json, revisedPrompt)
      }
    }
  }

  // 2. Chat Completions response (`choices[0].message`)
  if (Array.isArray(record.choices) && record.choices.length > 0) {
    const firstChoice = record.choices[0] as Record<string, unknown> | undefined
    const message = firstChoice?.message as Record<string, unknown> | undefined

    if (message) {
      // 2a. `message.images[]` (used by gemini-3.1-flash-image on CPA / OpenRouter)
      if (Array.isArray(message.images)) {
        for (const img of message.images) {
          if (typeof img === 'string') {
            pushImage(img)
            continue
          }
          if (!img || typeof img !== 'object') continue
          const imgObj = img as Record<string, unknown>
          const imageUrlField = imgObj.image_url
          if (typeof imageUrlField === 'string') {
            pushImage(imageUrlField)
          } else if (imageUrlField && typeof imageUrlField === 'object') {
            const nestedUrl = (imageUrlField as Record<string, unknown>).url
            if (typeof nestedUrl === 'string') {
              pushImage(nestedUrl)
            }
          }
          if (typeof imgObj.url === 'string') {
            pushImage(imgObj.url)
          }
          if (typeof imgObj.b64_json === 'string') {
            pushImage(imgObj.b64_json)
          }
        }
      }

      // 2b. `message.content` (string with markdown images or array of parts)
      const content = message.content
      if (typeof content === 'string') {
        const markdownImgRegex = /!\[[^\]]*\]\(([^)\s]+)\)/g
        let match: RegExpExecArray | null
        while ((match = markdownImgRegex.exec(content)) !== null) {
          pushImage(match[1])
        }
        const stripped = content
          .replaceAll(/!\[[^\]]*\]\(([^)\s]+)\)/g, '')
          .trim()
        if (stripped.startsWith('data:image/')) {
          pushImage(stripped)
        } else {
          text = stripped
        }
      } else if (Array.isArray(content)) {
        const textParts: string[] = []
        for (const part of content) {
          if (!part || typeof part !== 'object') continue
          const partObj = part as Record<string, unknown>
          if (typeof partObj.text === 'string') {
            textParts.push(partObj.text)
          }
          const partImageUrl = partObj.image_url
          if (typeof partImageUrl === 'string') {
            pushImage(partImageUrl)
          } else if (partImageUrl && typeof partImageUrl === 'object') {
            const nestedUrl = (partImageUrl as Record<string, unknown>).url
            if (typeof nestedUrl === 'string') {
              pushImage(nestedUrl)
            }
          }
        }
        text = textParts.join('\n').trim()
      }
    }
  }

  // 3. Usage metadata
  let usage: ParsedImageGenerationResult['usage']
  if (record.usage && typeof record.usage === 'object') {
    const u = record.usage as Record<string, unknown>
    const promptTokens = Number(u.prompt_tokens ?? u.input_tokens ?? 0)
    const completionTokens = Number(u.completion_tokens ?? u.output_tokens ?? 0)
    const totalTokens = Number(
      u.total_tokens ?? promptTokens + completionTokens
    )
    if (totalTokens > 0) {
      usage = {
        promptTokens,
        completionTokens,
        totalTokens,
      }
    }
  }

  return { images, text, usage }
}
