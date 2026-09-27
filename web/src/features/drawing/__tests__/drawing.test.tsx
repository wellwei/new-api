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
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router'
import {
  cleanup,
  render,
  renderHook,
  screen,
  waitFor,
} from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { useSidebarData } from '@/hooks/use-sidebar-data'
import { api } from '@/lib/api'
import { useAuthStore } from '@/stores/auth-store'

import { Drawing } from '../index'
import {
  composeImagePrompt,
  extractGeneratedImages,
  getAvailableImageModels,
  resolveImageProtocol,
} from '../lib'

const SAMPLE_DATA_URL =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='

let client: QueryClient
let mockKeys: {
  id: number
  name: string
  key: string
  status: number
  group: string
}[]
let gatewayResponse: { ok: boolean; status: number; body: unknown }
let capturedFetchCalls: {
  url: string
  headers: Record<string, string>
  body: unknown
}[]

function renderDrawing() {
  const router = createRouter({
    routeTree: createRootRoute({ component: Drawing }),
    history: createMemoryHistory({ initialEntries: ['/drawing'] }),
  })
  render(
    <QueryClientProvider client={client}>
      {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
      <RouterProvider router={router as any} />
    </QueryClientProvider>
  )
  return router
}

beforeEach(() => {
  mockKeys = [
    {
      id: 11,
      name: 'Default Key',
      key: 'masked-11',
      status: 1,
      group: 'default',
    },
    {
      id: 22,
      name: 'VIP Key',
      key: 'masked-22',
      status: 1,
      group: 'vip',
    },
  ]
  capturedFetchCalls = []
  gatewayResponse = {
    ok: true,
    status: 200,
    body: {
      choices: [
        {
          message: {
            role: 'assistant',
            content: '',
            images: [
              {
                type: 'image_url',
                image_url: { url: SAMPLE_DATA_URL },
              },
            ],
          },
        },
      ],
      usage: {
        prompt_tokens: 18,
        completion_tokens: 1290,
        total_tokens: 1308,
      },
    },
  }

  useAuthStore.getState().auth.setUser({
    id: 7,
    username: 'artist',
    role: 1,
  })

  client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })

  vi.spyOn(api, 'get').mockImplementation(async (url: string) => {
    if (url.startsWith('/api/token/')) {
      return {
        data: {
          success: true,
          data: {
            items: [...mockKeys],
            total: mockKeys.length,
            page: 1,
            page_size: 100,
          },
        },
      }
    }
    if (url === '/api/pricing') {
      return {
        data: {
          success: true,
          data: [
            {
              model_name: 'gemini-3.1-flash-image',
              description: 'Nano Banana 2 图像生成模型',
              quota_type: 0,
              model_ratio: 0.25,
              model_price: 0,
              owner_by: 'Google',
              completion_ratio: 120,
              enable_groups: ['default', 'vip'],
              supported_endpoint_types: ['openai', 'openai-response'],
            },
            {
              model_name: 'glm-5.3',
              description: '通用对话模型',
              quota_type: 0,
              model_ratio: 0.5,
              model_price: 0,
              owner_by: 'Zhipu',
              completion_ratio: 2,
              enable_groups: ['default'],
              supported_endpoint_types: ['openai'],
            },
          ],
          vendors: [],
          group_ratio: { default: 1, vip: 1 },
          usable_group: { default: '默认分组', vip: 'VIP 分组' },
          supported_endpoint: {},
        },
      }
    }
    if (url === '/api/user/models') {
      return {
        data: {
          success: true,
          data: ['gemini-3.1-flash-image', 'glm-5.3'],
        },
      }
    }
    if (url === '/api/status') {
      return {
        data: {
          success: true,
          data: { server_address: 'https://gateway.example.com' },
        },
      }
    }
    throw new Error(`Unexpected GET ${url}`)
  })

  vi.spyOn(api, 'post').mockImplementation(async (url: string) => {
    if (/^\/api\/token\/\d+\/key$/.test(url)) {
      const id = Number(url.split('/')[3])
      return {
        data: {
          success: true,
          data: { key: `secret-token-${id}` },
        },
      }
    }
    throw new Error(`Unexpected POST ${url}`)
  })

  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      capturedFetchCalls.push({
        url,
        headers: (init?.headers as Record<string, string>) ?? {},
        body: init?.body ? JSON.parse(String(init.body)) : null,
      })
      return {
        ok: gatewayResponse.ok,
        status: gatewayResponse.status,
        json: async () => gatewayResponse.body,
      }
    })
  )
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  useAuthStore.getState().auth.reset()
})

describe('AI Drawing helpers', () => {
  it('filters only image generation models from pricing and fallback lists', () => {
    const models = getAvailableImageModels(
      [
        {
          id: 1,
          model_name: 'gemini-3.1-flash-image',
          quota_type: 0,
          model_ratio: 0.25,
          model_price: 0,
          completion_ratio: 120,
          enable_groups: ['default'],
          supported_endpoint_types: ['openai'],
        },
        {
          id: 2,
          model_name: 'claude-sonnet-4-6',
          quota_type: 0,
          model_ratio: 1.5,
          model_price: 0,
          completion_ratio: 5,
          enable_groups: ['default'],
          supported_endpoint_types: ['openai'],
        },
      ],
      ['flux-1-schnell', 'gpt-6-astra']
    )

    expect(models.map((m) => m.model_name)).toEqual([
      'gemini-3.1-flash-image',
      'flux-1-schnell',
    ])
  })

  it('uses chat protocol for gemini-3.1-flash-image and images protocol for pure image-generation endpoints', () => {
    expect(
      resolveImageProtocol({
        id: 1,
        model_name: 'gemini-3.1-flash-image',
        quota_type: 0,
        model_ratio: 0.25,
        model_price: 0,
        completion_ratio: 120,
        enable_groups: ['default'],
        supported_endpoint_types: ['openai'],
      })
    ).toBe('chat')

    expect(
      resolveImageProtocol({
        id: 3,
        model_name: 'dall-e-3',
        quota_type: 1,
        model_ratio: 1,
        model_price: 0.04,
        completion_ratio: 1,
        enable_groups: ['default'],
        supported_endpoint_types: ['image-generation'],
      })
    ).toBe('images')
  })

  it('extracts images from chat completions message.images and standard data arrays', () => {
    const chatParsed = extractGeneratedImages({
      choices: [
        {
          message: {
            content: 'Here is your cat',
            images: [{ image_url: { url: SAMPLE_DATA_URL } }],
          },
        },
      ],
      usage: { prompt_tokens: 10, completion_tokens: 1200, total_tokens: 1210 },
    })
    expect(chatParsed.images).toEqual([{ url: SAMPLE_DATA_URL }])
    expect(chatParsed.text).toBe('Here is your cat')
    expect(chatParsed.usage?.totalTokens).toBe(1210)

    const standardParsed = extractGeneratedImages({
      data: [{ b64_json: 'AAAA', revised_prompt: 'A refined cat' }],
    })
    expect(standardParsed.images).toEqual([
      { url: 'data:image/png;base64,AAAA', revisedPrompt: 'A refined cat' },
    ])
  })

  it('composes prompt with style, aspect ratio, and negative prompt', () => {
    const composed = composeImagePrompt({
      prompt: 'A cat astronaut on Mars',
      aspectRatio: '16:9',
      style: 'photorealistic',
      negativePrompt: 'blurry, watermark',
    })
    expect(composed).toContain('A cat astronaut on Mars')
    expect(composed).toContain('Aspect ratio: 16:9')
    expect(composed).toContain('Photorealistic photography')
    expect(composed).toContain('Avoid: blurry, watermark')
  })
})

describe('AI Drawing page and sidebar entry', () => {
  it('places AI Drawing at the very top of the left sidebar general group', () => {
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    )
    const { result } = renderHook(() => useSidebarData(), { wrapper })
    const generalGroup = result.current.navGroups.find(
      (g) => g.id === 'general'
    )
    expect(generalGroup).toBeDefined()
    expect(generalGroup?.items[0]?.url).toBe('/drawing')
  })

  it('allows selecting an API key, model, and parameters to generate and display an image', async () => {
    const warnSpy = vi
      .spyOn(console, 'warn')
      .mockImplementation(() => undefined)
    const user = userEvent.setup()
    renderDrawing()

    // Wait for keys and image models to populate
    const keySelect = await screen.findByLabelText('Select API Key')
    const modelSelect = await screen.findByLabelText('Drawing Model')

    await waitFor(() => {
      expect(modelSelect).toHaveValue('gemini-3.1-flash-image')
    })
    // Non-image models like glm-5.3 must not appear in the drawing model selector
    expect(
      screen.queryByRole('option', { name: 'glm-5.3' })
    ).not.toBeInTheDocument()

    // Switch to the second API key (VIP Key, id=22)
    await user.selectOptions(keySelect, '22')
    expect(keySelect).toHaveValue('22')

    // Select 16:9 aspect ratio
    await user.click(screen.getByRole('button', { name: '16:9' }))

    // Enter prompt and generate
    const promptInput = screen.getByLabelText(/Image Prompt/i)
    await user.type(promptInput, '一只宇航员橘猫')

    const submitBtn = screen.getByRole('button', { name: /Generate Image/i })
    await user.click(submitBtn)

    // Generated image should be rendered
    const img = await screen.findByRole('img', { name: '一只宇航员橘猫' })
    expect(img).toHaveAttribute('src', SAMPLE_DATA_URL)
    expect(screen.getByText(/1,308 Tokens/)).toBeVisible()

    // Verify request payload & selected API key authorization header
    expect(capturedFetchCalls).toHaveLength(1)
    expect(capturedFetchCalls[0].url).toBe(
      'https://gateway.example.com/v1/chat/completions'
    )
    expect(capturedFetchCalls[0].headers.Authorization).toBe(
      'Bearer sk-secret-token-22'
    )
    expect(capturedFetchCalls[0].body).toMatchObject({
      model: 'gemini-3.1-flash-image',
      stream: false,
    })

    // SectionPageLayout must not warn about unslotted children
    expect(warnSpy).not.toHaveBeenCalled()
  })

  it('surfaces gateway error message when generation fails', async () => {
    gatewayResponse = {
      ok: false,
      status: 429,
      body: { error: { message: '当前分组并发已达上限' } },
    }
    const user = userEvent.setup()
    renderDrawing()

    const modelSelect = await screen.findByLabelText('Drawing Model')
    await waitFor(() =>
      expect(modelSelect).toHaveValue('gemini-3.1-flash-image')
    )

    await user.type(screen.getByLabelText(/Image Prompt/i), '测试图片')
    await user.click(screen.getByRole('button', { name: /Generate Image/i }))

    expect(await screen.findByRole('alert')).toBeVisible()
    expect(screen.getByText('当前分组并发已达上限')).toBeVisible()
  })
})
