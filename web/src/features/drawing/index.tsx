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
import { useMutation, useQuery } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import {
  Download,
  Image as ImageIcon,
  KeyRound,
  Loader2,
  Maximize2,
  Palette,
  Sparkles,
  TriangleAlert,
  Wand2,
} from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { CopyButton } from '@/components/copy-button'
import { SectionPageLayout } from '@/components/layout'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { fetchTokenKey, getApiKeys } from '@/features/keys/api'
import type { ApiKey } from '@/features/keys/types'
import { usePricingData } from '@/features/pricing/hooks/use-pricing-data'
import { useStatus } from '@/hooks/use-status'
import { getUserModels } from '@/lib/api'
import { getLobeIcon } from '@/lib/lobe-icon'
import { requireServerSuccess } from '@/lib/server-error-message'
import { cn } from '@/lib/utils'

import {
  ASPECT_RATIOS,
  composeImagePrompt,
  extractGeneratedImages,
  getAvailableImageModels,
  resolveImageProtocol,
  STYLE_PRESETS,
  type AspectRatioId,
  type GeneratedImageItem,
  type StylePresetId,
} from './lib'

const EXAMPLE_PROMPTS = [
  '赛博朋克雨夜霓虹街道，倒映着全息广告牌，电影级光影细节',
  '戴着宇航员头盔的橘猫坐在月球表面看向地球，超清摄影质感',
  '极简主义云海山川日出风景，柔和晨光，水彩手绘艺术质感',
] as const

function resolveBaseUrl(serverAddress: unknown): string {
  const configured =
    typeof serverAddress === 'string' ? serverAddress.trim() : ''
  return (configured || window.location.origin).replace(/\/+$/, '')
}

interface GenerationRecord {
  model: string
  aspectRatio: AspectRatioId
  style: StylePresetId
  prompt: string
  elapsedMs: number
  images: GeneratedImageItem[]
  text: string
  usage?: {
    promptTokens: number
    completionTokens: number
    totalTokens: number
  }
}

export function Drawing() {
  const { t } = useTranslation()
  const { status } = useStatus()
  const { models: pricingModels, isLoading: isPricingLoading } =
    usePricingData()

  const keysQuery = useQuery({
    queryKey: ['drawing', 'api-keys'],
    queryFn: async () => {
      const result = requireServerSuccess(await getApiKeys({ p: 1, size: 100 }))
      return result.data?.items ?? []
    },
    staleTime: 30 * 1000,
  })

  const userModelsQuery = useQuery({
    queryKey: ['drawing', 'user-models'],
    queryFn: async () => {
      const result = requireServerSuccess(await getUserModels())
      return result.data ?? []
    },
    staleTime: 5 * 60 * 1000,
  })

  const enabledKeys = useMemo(
    () => (keysQuery.data ?? []).filter((key: ApiKey) => key.status === 1),
    [keysQuery.data]
  )

  const imageModels = useMemo(
    () =>
      getAvailableImageModels(pricingModels ?? [], userModelsQuery.data ?? []),
    [pricingModels, userModelsQuery.data]
  )

  const [selectedKeyId, setSelectedKeyId] = useState<number | null>(null)
  const [selectedModelName, setSelectedModelName] = useState<string>('')
  const [aspectRatio, setAspectRatio] = useState<AspectRatioId>('1:1')
  const [stylePreset, setStylePreset] = useState<StylePresetId>('none')
  const [prompt, setPrompt] = useState<string>('')
  const [negativePrompt, setNegativePrompt] = useState<string>('')
  const [previewImage, setPreviewImage] = useState<string | null>(null)
  const [elapsedSeconds, setElapsedSeconds] = useState<number>(0)

  const keySecretCacheRef = useRef<Map<number, string>>(new Map())

  // Default to the first enabled API key once loaded
  useEffect(() => {
    if (
      enabledKeys.length > 0 &&
      (selectedKeyId === null ||
        !enabledKeys.some((k) => k.id === selectedKeyId))
    ) {
      setSelectedKeyId(enabledKeys[0].id)
    }
  }, [enabledKeys, selectedKeyId])

  // Default to the first available image model once loaded
  useEffect(() => {
    if (
      imageModels.length > 0 &&
      (!selectedModelName ||
        !imageModels.some((m) => m.model_name === selectedModelName))
    ) {
      setSelectedModelName(imageModels[0].model_name)
    }
  }, [imageModels, selectedModelName])

  const selectedModel = useMemo(
    () => imageModels.find((m) => m.model_name === selectedModelName) ?? null,
    [imageModels, selectedModelName]
  )

  const selectedKey = useMemo(
    () => enabledKeys.find((k) => k.id === selectedKeyId) ?? null,
    [enabledKeys, selectedKeyId]
  )

  const baseUrl = resolveBaseUrl(status?.server_address)

  const generateMutation = useMutation({
    mutationFn: async (): Promise<GenerationRecord> => {
      if (!selectedKeyId) {
        throw new Error(t('Please select an API key first'))
      }
      if (!selectedModelName) {
        throw new Error(t('Please select a drawing model first'))
      }
      const trimmedPrompt = prompt.trim()
      if (!trimmedPrompt) {
        throw new Error(t('Please enter an image description'))
      }

      const startedAt = Date.now()

      let secret = keySecretCacheRef.current.get(selectedKeyId) ?? ''
      if (!secret) {
        const keyRes = await fetchTokenKey(selectedKeyId)
        secret = keyRes.success ? (keyRes.data?.key ?? '') : ''
        if (!secret) {
          throw new Error(
            keyRes.message || t('Unable to read the selected API key')
          )
        }
        keySecretCacheRef.current.set(selectedKeyId, secret)
      }

      const authBearer = secret.startsWith('sk-') ? secret : `sk-${secret}`
      const protocol = resolveImageProtocol(selectedModel)
      const composedPrompt = composeImagePrompt({
        prompt: trimmedPrompt,
        aspectRatio,
        style: stylePreset,
        negativePrompt,
      })

      const ratioOption =
        ASPECT_RATIOS.find((r) => r.id === aspectRatio) ?? ASPECT_RATIOS[0]

      const endpoint =
        protocol === 'images'
          ? `${baseUrl}/v1/images/generations`
          : `${baseUrl}/v1/chat/completions`

      const requestBody =
        protocol === 'images'
          ? {
              model: selectedModelName,
              prompt: composedPrompt,
              size: ratioOption.size,
              n: 1,
            }
          : {
              model: selectedModelName,
              stream: false,
              messages: [
                {
                  role: 'user',
                  content: composedPrompt,
                },
              ],
            }

      const response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${authBearer}`,
        },
        body: JSON.stringify(requestBody),
      })

      const body = (await response.json().catch(() => null)) as {
        error?: { message?: string }
        message?: string
      } | null

      if (!response.ok) {
        throw new Error(
          body?.error?.message ||
            body?.message ||
            t('The gateway answered HTTP {{status}}.', {
              status: response.status,
            })
        )
      }

      const parsed = extractGeneratedImages(body)
      if (parsed.images.length === 0) {
        throw new Error(
          parsed.text ||
            t(
              'The model completed the request without returning an image. Try refining your prompt.'
            )
        )
      }

      return {
        model: selectedModelName,
        aspectRatio,
        style: stylePreset,
        prompt: trimmedPrompt,
        elapsedMs: Math.max(Date.now() - startedAt, 100),
        images: parsed.images,
        text: parsed.text,
        usage: parsed.usage,
      }
    },
  })

  useEffect(() => {
    if (!generateMutation.isPending) {
      setElapsedSeconds(0)
      return
    }
    const start = Date.now()
    const timer = window.setInterval(() => {
      setElapsedSeconds(Math.floor((Date.now() - start) / 100) / 10)
    }, 200)
    return () => window.clearInterval(timer)
  }, [generateMutation.isPending])

  const canSubmit =
    Boolean(selectedKeyId) &&
    Boolean(selectedModelName) &&
    prompt.trim().length > 0 &&
    !generateMutation.isPending

  const handleSubmit = (event?: React.FormEvent) => {
    event?.preventDefault()
    if (!canSubmit) return
    generateMutation.mutate()
  }

  const modelIconKey = selectedModel?.icon || selectedModel?.vendor_icon
  const modelIcon = modelIconKey ? getLobeIcon(modelIconKey, 18) : null
  const result = generateMutation.data

  return (
    <SectionPageLayout>
      <SectionPageLayout.Title>{t('AI Drawing')}</SectionPageLayout.Title>
      <SectionPageLayout.Content>
        <div className='grid gap-4 lg:grid-cols-[minmax(0,24rem)_minmax(0,1fr)] xl:grid-cols-[minmax(0,26rem)_minmax(0,1fr)]'>
          {/* Left Panel: Model & Parameters */}
          <form
            onSubmit={handleSubmit}
            className='bg-card flex flex-col gap-5 rounded-2xl border p-4 shadow-xs sm:p-5'
          >
            {/* 1. API Key Selector */}
            <div className='flex flex-col gap-2'>
              <div className='flex items-center justify-between gap-2'>
                <label
                  htmlFor='drawing-api-key'
                  className='flex items-center gap-1.5 text-sm font-medium'
                >
                  <KeyRound className='text-muted-foreground size-4' />
                  {t('Select API Key')}
                </label>
                <Link
                  to='/keys'
                  className='text-muted-foreground hover:text-foreground text-xs underline underline-offset-4'
                >
                  {t('Manage my keys')}
                </Link>
              </div>

              {keysQuery.isLoading && (
                <div className='bg-muted/40 h-9 animate-pulse rounded-lg border' />
              )}

              {!keysQuery.isLoading && enabledKeys.length === 0 && (
                <div className='bg-muted/30 flex flex-col gap-2 rounded-xl border border-dashed p-3 text-xs'>
                  <p className='text-muted-foreground'>
                    {t(
                      'No enabled API keys found. Create an API key first to start drawing.'
                    )}
                  </p>
                  <div>
                    <Button
                      size='sm'
                      variant='outline'
                      render={<Link to='/keys' />}
                    >
                      <KeyRound data-icon='inline-start' />
                      {t('Create API Key')}
                    </Button>
                  </div>
                </div>
              )}

              {!keysQuery.isLoading && enabledKeys.length > 0 && (
                <select
                  id='drawing-api-key'
                  aria-label={t('Select API Key')}
                  value={selectedKeyId ?? ''}
                  onChange={(e) => setSelectedKeyId(Number(e.target.value))}
                  className='border-input bg-background focus-visible:border-ring focus-visible:ring-ring/50 dark:bg-input/30 h-9 w-full rounded-lg border px-2.5 text-sm outline-none focus-visible:ring-3'
                >
                  {enabledKeys.map((key) => (
                    <option key={key.id} value={key.id}>
                      {key.name}
                      {key.group ? ` (${key.group})` : ''}
                    </option>
                  ))}
                </select>
              )}

              {selectedKey?.group && (
                <p className='text-muted-foreground text-xs'>
                  {t('Token group')}:{' '}
                  <span className='text-foreground font-mono font-medium'>
                    {selectedKey.group}
                  </span>
                </p>
              )}
            </div>

            {/* 2. Drawing Model Selector */}
            <div className='flex flex-col gap-2'>
              <div className='flex items-center justify-between gap-2'>
                <label
                  htmlFor='drawing-model'
                  className='flex items-center gap-1.5 text-sm font-medium'
                >
                  <Sparkles className='text-muted-foreground size-4' />
                  {t('Drawing Model')}
                </label>
                <Link
                  to='/pricing'
                  className='text-muted-foreground hover:text-foreground text-xs underline underline-offset-4'
                >
                  {t('Model Square')}
                </Link>
              </div>

              {isPricingLoading && userModelsQuery.isLoading && (
                <div className='bg-muted/40 h-9 animate-pulse rounded-lg border' />
              )}

              {!(isPricingLoading && userModelsQuery.isLoading) &&
                imageModels.length === 0 && (
                  <div className='bg-muted/30 rounded-xl border border-dashed p-3 text-xs'>
                    <p className='text-muted-foreground'>
                      {t('No image generation models are currently available.')}
                    </p>
                  </div>
                )}

              {!(isPricingLoading && userModelsQuery.isLoading) &&
                imageModels.length > 0 && (
                  <>
                    <select
                      id='drawing-model'
                      aria-label={t('Drawing Model')}
                      value={selectedModelName}
                      onChange={(e) => setSelectedModelName(e.target.value)}
                      className='border-input bg-background focus-visible:border-ring focus-visible:ring-ring/50 dark:bg-input/30 h-9 w-full rounded-lg border px-2.5 font-mono text-sm outline-none focus-visible:ring-3'
                    >
                      {imageModels.map((model) => (
                        <option key={model.model_name} value={model.model_name}>
                          {model.model_name}
                        </option>
                      ))}
                    </select>

                    {selectedModel && (
                      <div className='bg-muted/30 flex items-center gap-2.5 rounded-xl border px-3 py-2 text-xs'>
                        {modelIcon ? (
                          <span className='shrink-0'>{modelIcon}</span>
                        ) : (
                          <ImageIcon className='text-muted-foreground size-4 shrink-0' />
                        )}
                        <div className='min-w-0 flex-1'>
                          <div className='flex flex-wrap items-center gap-1.5'>
                            <span className='truncate font-mono font-medium'>
                              {selectedModel.model_name}
                            </span>
                            {selectedModel.enable_groups?.map((g) => (
                              <Badge
                                key={g}
                                variant='secondary'
                                className='px-1.5 py-0 text-[10px]'
                              >
                                {g}
                              </Badge>
                            ))}
                          </div>
                          {selectedModel.description && (
                            <p className='text-muted-foreground mt-0.5 line-clamp-1'>
                              {selectedModel.description}
                            </p>
                          )}
                        </div>
                      </div>
                    )}
                  </>
                )}
            </div>

            {/* 3. Aspect Ratio */}
            <div className='flex flex-col gap-2'>
              <span className='text-sm font-medium'>{t('Aspect Ratio')}</span>
              <div
                className='grid grid-cols-5 gap-2'
                role='group'
                aria-label={t('Aspect Ratio')}
              >
                {ASPECT_RATIOS.map((option) => {
                  const active = aspectRatio === option.id
                  return (
                    <button
                      key={option.id}
                      type='button'
                      aria-pressed={active}
                      onClick={() => setAspectRatio(option.id)}
                      className={cn(
                        'flex flex-col items-center justify-center gap-1.5 rounded-xl border px-2 py-2.5 text-xs transition-colors',
                        active
                          ? 'border-primary bg-primary/8 text-foreground font-medium'
                          : 'border-border bg-background/60 text-muted-foreground hover:bg-muted/50 hover:text-foreground'
                      )}
                    >
                      <span
                        className={cn(
                          'rounded-xs border-2',
                          option.widthClass,
                          option.heightClass,
                          active
                            ? 'border-primary bg-primary/15'
                            : 'border-muted-foreground/50'
                        )}
                        aria-hidden='true'
                      />
                      <span className='font-mono text-[11px]'>
                        {option.ratioLabel}
                      </span>
                    </button>
                  )
                })}
              </div>
            </div>

            {/* 4. Style Preset */}
            <div className='flex flex-col gap-2'>
              <span className='flex items-center gap-1.5 text-sm font-medium'>
                <Palette className='text-muted-foreground size-4' />
                {t('Style Preset')}
              </span>
              <div
                className='flex flex-wrap gap-1.5'
                role='group'
                aria-label={t('Style Preset')}
              >
                {STYLE_PRESETS.map((preset) => {
                  const active = stylePreset === preset.id
                  return (
                    <button
                      key={preset.id}
                      type='button'
                      aria-pressed={active}
                      onClick={() => setStylePreset(preset.id)}
                      className={cn(
                        'rounded-lg border px-2.5 py-1 text-xs transition-colors',
                        active
                          ? 'border-primary bg-primary/10 text-foreground font-medium'
                          : 'border-border bg-background/60 text-muted-foreground hover:bg-muted/50 hover:text-foreground'
                      )}
                    >
                      {t(preset.labelKey)}
                    </button>
                  )
                })}
              </div>
            </div>

            {/* 5. Prompt Input */}
            <div className='flex flex-col gap-2'>
              <div className='flex items-center justify-between gap-2'>
                <label
                  htmlFor='drawing-prompt'
                  className='flex items-center gap-1.5 text-sm font-medium'
                >
                  <Wand2 className='text-muted-foreground size-4' />
                  {t('Image Prompt')}
                </label>
                <span className='text-muted-foreground text-[11px]'>
                  ⌘ + Enter
                </span>
              </div>
              <Textarea
                id='drawing-prompt'
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                onKeyDown={(e) => {
                  if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
                    e.preventDefault()
                    handleSubmit()
                  }
                }}
                rows={4}
                placeholder={t(
                  'Describe the subject, scene, lighting, and composition you want to generate...'
                )}
                className='min-h-24 resize-y'
              />

              {/* Quick example prompts */}
              <div className='flex flex-wrap items-center gap-1.5 pt-0.5'>
                <span className='text-muted-foreground text-[11px]'>
                  {t('Try an example')}:
                </span>
                {EXAMPLE_PROMPTS.map((sample) => (
                  <button
                    key={sample}
                    type='button'
                    onClick={() => setPrompt(sample)}
                    className='bg-muted/50 text-muted-foreground hover:bg-muted hover:text-foreground max-w-44 truncate rounded-md px-2 py-0.5 text-[11px] transition-colors'
                    title={sample}
                  >
                    {sample}
                  </button>
                ))}
              </div>
            </div>

            {/* 6. Negative Prompt (Optional) */}
            <div className='flex flex-col gap-1.5'>
              <label
                htmlFor='drawing-negative-prompt'
                className='text-muted-foreground text-xs font-medium'
              >
                {t('Negative Prompt (Optional)')}
              </label>
              <Input
                id='drawing-negative-prompt'
                value={negativePrompt}
                onChange={(e) => setNegativePrompt(e.target.value)}
                placeholder={t(
                  'Elements to avoid, e.g. blurry, low quality, watermark...'
                )}
              />
            </div>

            {/* Submit Button */}
            <Button
              type='submit'
              size='lg'
              disabled={!canSubmit}
              className='mt-1 w-full'
            >
              {generateMutation.isPending ? (
                <>
                  <Loader2
                    className='animate-spin'
                    data-icon='inline-start'
                  />
                  {t('Generating image...')}
                  {elapsedSeconds > 0 && ` (${elapsedSeconds.toFixed(1)}s)`}
                </>
              ) : (
                <>
                  <Sparkles data-icon='inline-start' />
                  {t('Generate Image')}
                </>
              )}
            </Button>
          </form>

          {/* Right Panel: Image Canvas & Result Display */}
          <section className='bg-card flex min-h-[28rem] flex-col rounded-2xl border p-4 shadow-xs sm:p-6'>
            {generateMutation.isPending && (
              <div className='flex flex-1 flex-col items-center justify-center gap-4 text-center'>
                <div className='bg-primary/8 border-primary/20 flex size-16 items-center justify-center rounded-2xl border'>
                  <Loader2 className='text-primary size-8 animate-spin' />
                </div>
                <div className='flex flex-col gap-1'>
                  <p className='text-base font-medium'>
                    {t('Generating your image...')}
                  </p>
                  <p className='text-muted-foreground font-mono text-xs tabular-nums'>
                    {selectedModelName} · {aspectRatio}
                    {elapsedSeconds > 0 && ` · ${elapsedSeconds.toFixed(1)}s`}
                  </p>
                </div>
              </div>
            )}

            {!generateMutation.isPending && generateMutation.isError && (
              <div
                className='flex flex-1 flex-col items-center justify-center gap-3 p-4 text-center'
                role='alert'
              >
                <div className='bg-destructive/10 border-destructive/30 flex size-12 items-center justify-center rounded-2xl border'>
                  <TriangleAlert className='text-destructive size-6' />
                </div>
                <div className='max-w-md space-y-1'>
                  <p className='text-destructive text-sm font-medium'>
                    {t('Image generation failed')}
                  </p>
                  <p className='text-muted-foreground text-xs break-words whitespace-pre-wrap'>
                    {generateMutation.error instanceof Error
                      ? generateMutation.error.message
                      : t('An unexpected error occurred')}
                  </p>
                </div>
              </div>
            )}

            {!generateMutation.isPending &&
              !generateMutation.isError &&
              result && (
                <div className='flex flex-1 flex-col gap-4'>
                  <div className='flex flex-wrap items-center justify-between gap-2 border-b pb-3'>
                    <div className='flex flex-wrap items-center gap-2'>
                      <Badge variant='secondary' className='font-mono text-xs'>
                        {result.model}
                      </Badge>
                      <Badge variant='outline' className='font-mono text-xs'>
                        {result.aspectRatio}
                      </Badge>
                      <span className='text-muted-foreground font-mono text-xs tabular-nums'>
                        {(result.elapsedMs / 1000).toFixed(1)}s
                      </span>
                      {result.usage && (
                        <span className='text-muted-foreground font-mono text-xs tabular-nums'>
                          · {result.usage.totalTokens.toLocaleString()} Tokens
                        </span>
                      )}
                    </div>

                    <div className='flex items-center gap-1.5'>
                      <CopyButton
                        value={result.prompt}
                        variant='outline'
                        size='sm'
                      >
                        {t('Copy Prompt')}
                      </CopyButton>
                      {result.images[0] && (
                        <>
                          <Button
                            type='button'
                            variant='outline'
                            size='sm'
                            onClick={() => setPreviewImage(result.images[0].url)}
                          >
                            <Maximize2 data-icon='inline-start' />
                            {t('Zoom')}
                          </Button>
                          <Button
                            variant='outline'
                            size='sm'
                            render={
                              <a
                                href={result.images[0].url}
                                download={`ai-drawing-${Date.now()}.png`}
                                target='_blank'
                                rel='noreferrer'
                              />
                            }
                          >
                            <Download data-icon='inline-start' />
                            {t('Download')}
                          </Button>
                        </>
                      )}
                    </div>
                  </div>

                  <div className='bg-muted/20 flex flex-1 items-center justify-center overflow-hidden rounded-xl border p-3 sm:p-4'>
                    <div
                      className={cn(
                        'grid w-full gap-4',
                        result.images.length > 1
                          ? 'sm:grid-cols-2'
                          : 'place-items-center'
                      )}
                    >
                      {result.images.map((img) => (
                        <div
                          key={img.url}
                          className='group relative overflow-hidden rounded-lg shadow-sm'
                        >
                          <img
                            src={img.url}
                            alt={result.prompt}
                            className='max-h-[34rem] w-auto max-w-full cursor-zoom-in rounded-lg object-contain'
                            onClick={() => setPreviewImage(img.url)}
                          />
                        </div>
                      ))}
                    </div>
                  </div>

                  {result.text && (
                    <p className='text-muted-foreground bg-muted/30 rounded-lg border px-3 py-2 text-xs whitespace-pre-wrap'>
                      {result.text}
                    </p>
                  )}
                </div>
              )}

            {!generateMutation.isPending &&
              !generateMutation.isError &&
              !result && (
                <div className='flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center'>
                  <div className='bg-muted/50 flex size-14 items-center justify-center rounded-2xl border'>
                    <ImageIcon className='text-muted-foreground size-7' />
                  </div>
                  <div className='max-w-sm space-y-1'>
                    <h3 className='text-sm font-medium'>
                      {t('Ready to create')}
                    </h3>
                    <p className='text-muted-foreground text-xs leading-relaxed'>
                      {t(
                        'Select your API key and drawing model on the left, configure the aspect ratio and style, then enter a prompt to generate an image.'
                      )}
                    </p>
                  </div>
                </div>
              )}
          </section>
        </div>

        {/* Fullscreen Image Lightbox — placed inside SectionPageLayout.Content
            so SectionPageLayout does not drop it. */}
        <Dialog
          open={Boolean(previewImage)}
          onOpenChange={(open) => {
            if (!open) setPreviewImage(null)
          }}
        >
          <DialogContent className='max-w-4xl sm:max-w-4xl'>
            <DialogHeader>
              <DialogTitle>{t('Image Preview')}</DialogTitle>
            </DialogHeader>
            {previewImage && (
              <div className='flex flex-col items-center gap-3'>
                <img
                  src={previewImage}
                  alt={result?.prompt || t('Generated image')}
                  className='max-h-[75dvh] w-auto max-w-full rounded-lg object-contain'
                />
              </div>
            )}
          </DialogContent>
        </Dialog>
      </SectionPageLayout.Content>
    </SectionPageLayout>
  )
}
