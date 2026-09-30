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
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  applyCapabilityPreset,
  type DraftState,
  filterCapabilitiesByKind,
  summarizeStepSpec,Design
} from '../index'
import { AssetBoard, RunStatus } from '../components/asset-board'
import { defaultValuesFromSchema, SchemaForm } from '../schema-form'
import {
  capabilityDisplayName,
  humanParamLabel,
  humanParamValue,
  isAdvancedParam,
  missingRequiredFields,
  readableModelName,
} from '../terminology'
import type {
  DesignAsset,
  DesignCapability,
  DesignParameterSchema,
  DesignStepWithAssets,
} from '../types'

afterEach(() => {
  cleanup()
})

const sampleSchema: DesignParameterSchema = {
  type: 'object',
  required: ['prompt'],
  properties: {
    prompt: {
      type: 'string',
      title: '画面描述',
    },
    model: {
      type: 'string',
      'x-hidden': true,
      default: 'wan2.6-image',
    },
    aspect_ratio: {
      type: 'string',
      title: '画面比例',
      enum: ['1:1', '3:4', '4:3', '16:9', '9:16', '21:9'],
      constraints: ['1:1', '3:4', '16:9'],
      default: '1:1',
    },
    resolution: {
      type: 'string',
      title: '分辨率',
      enum: ['1K', '2K', '4K'],
      constraints: ['1K', '2K'],
      default: '2K',
    },
    count: {
      type: 'integer',
      title: '生成张数',
      minimum: 1,
      maximum: 4,
      default: 1,
    },
  },
}

describe('AI design workbench schema & helpers', () => {
  it('extracts visible defaults from schema while ignoring x-hidden fields', () => {
    const defaults = defaultValuesFromSchema(sampleSchema)
    expect(defaults).toEqual({
      aspect_ratio: '1:1',
      resolution: '2K',
      count: 1,
    })
    expect(defaults).not.toHaveProperty('model')
  })

  it('renders SchemaForm with default values and hides x-hidden properties', () => {
    const onChange = vi.fn()
    render(
      <SchemaForm
        schema={sampleSchema}
        values={{}}
        onChange={onChange}
      />
    )
    expect(screen.getByText(/画面描述/)).toBeDefined()
    expect(screen.getByText('画面比例')).toBeDefined()
    expect(screen.getByText('分辨率')).toBeDefined()
    expect(screen.getByText('生成张数')).toBeDefined()
    expect(screen.queryByText('model')).toBeNull()
    const numberInput = screen.getByRole('spinbutton') as HTMLInputElement
    expect(numberInput.value).toBe('1')
  })

  it('filters capabilities by delivery kind (image vs video)', () => {
    const capabilities: DesignCapability[] = [
      {
        id: 'alibaba:wan2.6-image',
        plugin_key: 'alibaba',
        plugin_name: 'Alibaba',
        model: 'wan2.6-image',
        media_type: 'image',
        operations: ['generate', 'edit'],
        defer_schema: true,
        available: true,
      },
      {
        id: 'doubao:doubao-seedance-1-0-pro-250528',
        plugin_key: 'doubao',
        plugin_name: 'Doubao',
        model: 'doubao-seedance-1-0-pro-250528',
        media_type: 'video',
        operations: ['generate'],
        defer_schema: true,
        available: true,
      },
    ]

    expect(filterCapabilitiesByKind(capabilities, 'image').map((c) => c.id)).toEqual([
      'alibaba:wan2.6-image',
    ])
    expect(filterCapabilitiesByKind(capabilities, 'video').map((c) => c.id)).toEqual([
      'doubao:doubao-seedance-1-0-pro-250528',
    ])
  })

  it('applies scene preset role and merges schema defaults with preset parameters', () => {
    const draft: DraftState = {
      name: '新品海报',
      kind: 'image',
      capability_id: 'alibaba:wan2.6-image',
      token_id: 1,
      role: '主视觉',
      brief: '',
      parameters: {
        prompt: '赛博朋克风格咖啡罐',
      },
    }

    const next = applyCapabilityPreset(
      draft,
      {
        id: 'poster-kv',
        name: '主视觉海报',
        role: '主视觉海报',
        parameters: {
          aspect_ratio: '3:4',
        },
      },
      sampleSchema
    )

    expect(next.role).toBe('主视觉海报')
    expect(next.parameters).toEqual({
      aspect_ratio: '3:4',
      resolution: '2K',
      count: 1,
      prompt: '赛博朋克风格咖啡罐',
    })
  })

  it('summarizes frozen step specifications and distinguishes text vs reference image input', () => {
    const textSpec = summarizeStepSpec(
      JSON.stringify({
        prompt: 'A quiet mountain lake at sunrise',
        aspect_ratio: '16:9',
        resolution: '720P',
        duration: 5,
        generate_audio: true,
      })
    )
    expect(textSpec.inputMode).toBe('纯文字生成')
    // Schema keys and raw "key=value" pairs must never reach the page.
    expect(textSpec.summary).toBe(
      '画面比例 宽屏 16:9 · 清晰度 高清 720P · 视频时长 5 秒 · 生成声音 开启'
    )
    expect(textSpec.summary).not.toContain('aspect_ratio')
    expect(textSpec.summary).not.toContain('=')

    const refSpec = summarizeStepSpec(
      JSON.stringify({
        prompt: 'Keep the same character in a snowy forest',
        aspect_ratio: '3:4',
        resolution: '2K',
        count: 2,
        image: ['https://example.com/anchor.png'],
      })
    )
    expect(refSpec.inputMode).toBe('参考图驱动')
    expect(refSpec.summary).toBe('画面比例 竖版 3:4 · 清晰度 高清（2K） · 生成数量 2 张')
    expect(refSpec.referenceCount).toBe(1)
  })

  it('never shows a raw schema key or opaque enum value to the user', () => {
    // The schema title is the plugin author's label for that model and wins.
    expect(humanParamLabel('aspect_ratio', '画面比例')).toBe('画面比例')
    // Without a title, the generic map keeps the field readable.
    expect(humanParamLabel('aspect_ratio')).toBe('画面比例')
    expect(humanParamLabel('unknown_field')).toBe('unknown_field')
    // Opaque upstream tokens become something a user can choose between.
    expect(humanParamValue('1024x1024')).toBe('方形 1:1（1024×1024）')
    expect(humanParamValue('2K')).toBe('高清（2K）')
    expect(humanParamValue('16:9')).toBe('宽屏 16:9')
    // An unknown value must pass through rather than render as blank.
    expect(humanParamValue('something-new')).toBe('something-new')
    // Rarely-needed fields collapse so the first screen stays short.
    expect(isAdvancedParam('seed')).toBe(true)
    expect(isAdvancedParam('prompt')).toBe(false)
  })

  it('reports exactly which required fields are still missing', () => {
    expect(missingRequiredFields(false, '', 0)).toEqual([
      '画面描述',
      '模型',
      '扣费账户',
    ])
    expect(missingRequiredFields(true, 'a:b', 1)).toEqual([])
  })
})

describe('SchemaForm honours the whole parameter schema', () => {
  /** Mirrors the workbuddy plugin's image + video capability declarations. */
  const workbenchImageSchema: DesignParameterSchema = {
    type: 'object',
    required: ['prompt'],
    properties: {
      prompt: {
        type: 'string',
        title: '画面与视觉描述 (Prompt)',
        maxLength: 2000,
        'x-append': '保持主体清晰、构图完整、光影自然统一',
      },
      size: {
        type: 'string',
        title: '画幅尺寸 (Size)',
        enum: ['1024x1024', '768x1024'],
        default: '1024x1024',
      },
      image: {
        type: 'array',
        title: '参考图 / 待编辑原图 URL',
        maxItems: 4,
        items: { type: 'string' },
      },
    },
  }

  it('renders array-typed reference images as slots, not a joined string', () => {
    const onChange = vi.fn()
    const { container } = render(
      <SchemaForm
        schema={workbenchImageSchema}
        values={{ image: ['https://example.com/a.png'] }}
        onChange={onChange}
        referenceLimits={{ maxImages: 4 }}
      />
    )
    // The declared cap is visible before the user overshoots it.
    expect(container.textContent).toContain('1 / 4')
    // The image URL is listed as a row, not flattened into a text input value.
    expect(container.textContent).toContain('https://example.com/a.png')
    expect(
      (screen.getByPlaceholderText('Paste an image URL') as HTMLInputElement).value
    ).toBe('')
  })

  it('surfaces the plugin x-append requirement instead of dropping it', () => {
    render(
      <SchemaForm
        schema={workbenchImageSchema}
        values={{}}
        onChange={vi.fn()}
      />
    )
    expect(screen.getByText('保持主体清晰、构图完整、光影自然统一')).toBeDefined()
  })

  it('keeps a numeric enum a closed set rather than a free number box', () => {
    const onChange = vi.fn()
    render(
      <SchemaForm
        schema={{
          type: 'object',
          properties: {
            duration: { type: 'integer', title: '时长（秒）', enum: [5, 6, 10], default: 5 },
          },
        }}
        values={{}}
        onChange={onChange}
      />
    )
    // A select trigger renders a combobox; a free numeric field would not.
    expect(screen.getByRole('combobox')).toBeDefined()
    expect(screen.queryByRole('spinbutton')).toBeNull()
  })

  it('locks aspect_ratio for video once a frame image fixes the ratio', () => {
    render(
      <SchemaForm
        schema={{
          type: 'object',
          properties: {
            aspect_ratio: {
              type: 'string',
              title: '画面比例',
              enum: ['16:9', '9:16'],
              default: '16:9',
            },
          },
        }}
        values={{ first_frame_image: 'https://example.com/first.png' }}
        onChange={vi.fn()}
        kind="video"
      />
    )
    // The user must be told why the control is dead, not just find it greyed out.
    expect(
      screen.getByText('The reference image already determines the frame ratio.')
    ).toBeDefined()
    expect(screen.getByRole('combobox')).toHaveProperty('disabled', true)
  })

  it('leaves aspect_ratio editable for text-to-video', () => {
    render(
      <SchemaForm
        schema={{
          type: 'object',
          properties: {
            aspect_ratio: {
              type: 'string',
              title: '画面比例',
              enum: ['16:9', '9:16'],
              default: '16:9',
            },
          },
        }}
        values={{}}
        onChange={vi.fn()}
        kind="video"
      />
    )
    expect(screen.getByRole('combobox')).toHaveProperty('disabled', false)
  })
})

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

describe('Design page component render', () => {
  it('renders without crashing when capabilities and projects are empty', () => {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    })
    client.setQueryData(['design', 'capabilities'], [])
    client.setQueryData(['design', 'projects'], {
      items: [],
      total: 0,
      page: 1,
      size: 50,
    })
    client.setQueryData(['design', 'api-keys'], [])

    const { container } = render(
      <QueryClientProvider client={client}>
        <Design />
      </QueryClientProvider>
    )
    expect(container.textContent).toBeTruthy()
  })

  it("renders project form, presets, and workflow when a project is loaded", () => {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    })
    client.setQueryData(["design", "capabilities"], [
      {
        id: "alibaba:wan2.6-image",
        plugin_key: "alibaba",
        plugin_name: "Alibaba",
        model: "wan2.6-image",
        media_type: "image",
        operations: ["generate"],
        defer_schema: false,
        parameter_schema: sampleSchema,
        presets: [{ id: "poster-kv", name: "主视觉海报", role: "主视觉" }],
        available: true,
      },
    ])
    client.setQueryData(["design", "projects"], {
      items: [
        {
          id: 1,
          user_id: 1,
          name: "测试海报项目",
          kind: "image",
          status: "awaiting_confirmation",
          plan_revision: 1,
          brief: "",
          role: "主视觉",
          default_capability: "alibaba:wan2.6-image",
          token_id: 1,
          parameters: JSON.stringify({ prompt: "test", aspect_ratio: "3:4" }),
          created_at: 1,
          updated_at: 1,
        },
      ],
      total: 1,
      page: 1,
      size: 50,
    })
    client.setQueryData(["design", "project", 1], {
      id: 1,
      user_id: 1,
      name: "测试海报项目",
      kind: "image",
      status: "awaiting_confirmation",
      plan_revision: 1,
      brief: "",
      role: "主视觉",
      default_capability: "alibaba:wan2.6-image",
      token_id: 1,
      parameters: JSON.stringify({ prompt: "test", aspect_ratio: "3:4" }),
      created_at: 1,
      updated_at: 1,
      steps: [],
    })
    client.setQueryData(["design", "api-keys"], [{ id: 1, name: "default-key" }])

    const { container } = render(
      <QueryClientProvider client={client}>
        <Design />
      </QueryClientProvider>
    )
    // awaiting_confirmation lands on the preview step. Confirming the cost
    // sheet and starting generation are two separate acts now, so an
    // unconfirmed project offers "Confirm and continue" — not "Start
    // generation", which would let one click spend money. Name and role moved
    // behind the brief step's disclosure, so they are not on screen here.
    // Exactly one match each: the page has a single layout, so nothing is
    // rendered twice for a second breakpoint.
    expect(container.textContent).toContain("主视觉")
    expect(screen.getByText("Review and generate")).toBeDefined()
    expect(screen.getByText("Confirm and continue")).toBeDefined()
    expect(screen.queryByText("Start generation")).toBeNull()
  })

  it("offers generation only after the cost sheet is confirmed", () => {
    // A `ready` project has been confirmed but not yet run: the primary action
    // flips to actually spending.
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    })
    client.setQueryData(["design", "capabilities"], [
      {
        id: "alibaba:wan2.6-image",
        plugin_key: "alibaba",
        plugin_name: "Alibaba",
        model: "wan2.6-image",
        media_type: "image",
        operations: ["generate"],
        defer_schema: false,
        parameter_schema: sampleSchema,
        available: true,
      },
    ])
    client.setQueryData(["design", "projects"], {
      items: [
        {
          id: 5,
          user_id: 1,
          name: "Ready project",
          kind: "image",
          status: "ready",
          plan_revision: 1,
          brief: "",
          role: "主视觉",
          default_capability: "alibaba:wan2.6-image",
          token_id: 1,
          parameters: JSON.stringify({ prompt: "test" }),
          created_at: 1,
          updated_at: 1,
        },
      ],
      total: 1,
      page: 1,
      size: 50,
    })
    client.setQueryData(["design", "project", 5], {
      id: 5,
      user_id: 1,
      name: "Ready project",
      kind: "image",
      status: "ready",
      plan_revision: 1,
      brief: "",
      role: "主视觉",
      default_capability: "alibaba:wan2.6-image",
      token_id: 1,
      parameters: JSON.stringify({ prompt: "test" }),
      created_at: 1,
      updated_at: 1,
      estimate: { model_price: 1, group_ratio: 1, quota_per_call: 100 },
      steps: [],
    })
    client.setQueryData(["design", "api-keys"], [{ id: 1, name: "default-key" }])

    render(
      <QueryClientProvider client={client}>
        <Design />
      </QueryClientProvider>
    )
    expect(screen.getByText("Start generation")).toBeDefined()
    expect(screen.queryByText("Confirm and continue")).toBeNull()
  })

  it("renders a draft project without crashing when the API returns steps: null", () => {
    // 2026-09-30 线上事故：无步骤的 draft 项目被后端序列化成 "steps": null，
    // 前端 project?.steps[0] 直接 TypeError。后端已改为永远返回数组，这里锁死
    // 前端对历史 null 形状的容错。
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    })
    client.setQueryData(["design", "capabilities"], [])
    client.setQueryData(["design", "projects"], {
      items: [
        {
          id: 7,
          user_id: 1,
          name: "设计项目",
          kind: "image",
          status: "draft",
          plan_revision: 1,
          brief: "",
          role: "",
          default_capability: "",
          token_id: 0,
          parameters: "",
          created_at: 1,
          updated_at: 1,
          steps: null,
        },
      ],
      total: 1,
      page: 1,
      size: 50,
    })
    client.setQueryData(["design", "project", 7], {
      id: 7,
      user_id: 1,
      name: "设计项目",
      kind: "image",
      status: "draft",
      plan_revision: 1,
      brief: "",
      role: "",
      default_capability: "",
      token_id: 0,
      parameters: "",
      created_at: 1,
      updated_at: 1,
      steps: null,
    })
    client.setQueryData(["design", "api-keys"], [])

    const { container } = render(
      <QueryClientProvider client={client}>
        <Design />
      </QueryClientProvider>
    )
    expect(container.textContent).toBeTruthy()
  })
})

const makeCapability = (over: Partial<DesignCapability> = {}): DesignCapability => ({
  id: 'workbuddy:hy-image-3.5-wb',
  plugin_key: 'workbuddy',
  plugin_name: 'Tencent WorkBuddy',
  model: 'hy-image-3.5-wb',
  media_type: 'image',
  operations: ['generate'],
  defer_schema: false,
  available: true,
  ...over,
})

const makeAsset = (over: Partial<DesignAsset> = {}): DesignAsset => ({
  id: 1,
  project_id: 1,
  step_id: 1,
  semantic_role: '主视觉',
  candidate_index: 0,
  task_id: 'task-1',
  artifact_key: 'out.png',
  mime_type: 'image/png',
  width: 1024,
  height: 1024,
  duration: 0,
  size: 2048,
  sha256: 'a'.repeat(64),
  accepted: false,
  selected: false,
  url: 'https://example.com/a.png',
  ...over,
})

const makeStep = (over: Partial<DesignStepWithAssets> = {}): DesignStepWithAssets => ({
  id: 1,
  project_id: 1,
  role: '主视觉',
  operation: 'image.generate',
  capability_id: 'workbuddy:hy-image-3.5-wb',
  model: 'hy-image-3.5-wb',
  parameters: '{}',
  plan_revision: 1,
  confirm_revision: 1,
  attempt: 0,
  idempotency_key: 'idem-1',
  task_id: 'task-1',
  status: 'succeeded',
  failure_class: '',
  assets: [],
  ...over,
})

describe('capability display naming', () => {
  it('labels an unambiguous capability by vendor and keeps the internal slug out', () => {
    const only = makeCapability()
    expect(capabilityDisplayName(only, [only])).toBe('Tencent WorkBuddy')
  })

  it('disambiguates two capabilities from the same vendor and kind', () => {
    const a = makeCapability()
    const b = makeCapability({ id: 'workbuddy:hy-image-4-wb', model: 'hy-image-4-wb' })
    expect(capabilityDisplayName(a, [a, b])).toBe('Tencent WorkBuddy · Hy image 3.5')
    expect(capabilityDisplayName(b, [a, b])).toBe('Tencent WorkBuddy · Hy image 4')
  })

  it('leaves the label alone when the sibling is another kind', () => {
    const image = makeCapability()
    const video = makeCapability({
      id: 'workbuddy:hy-video-1-wb',
      model: 'hy-video-1-wb',
      media_type: 'video',
    })
    expect(capabilityDisplayName(image, [image, video])).toBe('Tencent WorkBuddy')
  })

  it('rejoins a version split by separators and drops the build stamp', () => {
    expect(readableModelName('doubao-seedance-1-0-pro-250528')).toBe(
      'Doubao seedance 1.0 pro'
    )
  })

  it('keeps every token when all of them look internal, so a label is never empty', () => {
    expect(readableModelName('wb-beta')).toBe('Wb beta')
  })
})

describe('asset board grouping', () => {
  it('groups by the asset semantic role rather than the step role', () => {
    // Both steps share one step role, so grouping by step would collapse two
    // different deliverables into a single card titled after the step.
    render(
      <AssetBoard
        generating={false}
        steps={[
          makeStep({
            id: 1,
            assets: [makeAsset({ id: 11, step_id: 1, semantic_role: '封面图' })],
          }),
          makeStep({
            id: 2,
            role: '主视觉',
            assets: [makeAsset({ id: 12, step_id: 2, semantic_role: '细节图' })],
          }),
        ]}
      />
    )
    expect(screen.getByText('封面图')).toBeDefined()
    expect(screen.getByText('细节图')).toBeDefined()
    expect(screen.queryByText('主视觉')).toBeNull()
  })

  it('falls back to the step role for an asset that carries none', () => {
    render(
      <AssetBoard
        generating={false}
        steps={[makeStep({ assets: [makeAsset({ semantic_role: '   ' })] })]}
      />
    )
    expect(screen.getByText('主视觉')).toBeDefined()
  })

  it('orders candidates of one role by candidate_index, not by arrival', () => {
    render(
      <AssetBoard
        generating={false}
        steps={[
          makeStep({
            role: '场景一',
            assets: [
              makeAsset({
                id: 21,
                semantic_role: '场景一',
                candidate_index: 1,
                url: 'https://example.com/b.png',
              }),
              makeAsset({
                id: 22,
                semantic_role: '场景一',
                candidate_index: 0,
                url: 'https://example.com/a.png',
              }),
            ],
          }),
        ]}
      />
    )
    const images = screen.getAllByRole('img')
    expect(images[0].getAttribute('src')).toBe('https://example.com/a.png')
    expect(images[1].getAttribute('src')).toBe('https://example.com/b.png')
    // The alt names the deliverable and the position. Test resources are empty,
    // so i18next hands back the key — assert that, not an interpolated sentence.
    expect(images[0].getAttribute('alt')).toBe('{role}, result {index}')
  })
})

describe('run log', () => {
  it('offers no retry once a step produced a task and points at it instead', () => {
    render(
      <RunStatus
        retrying={false}
        onRetry={vi.fn()}
        specSummary={() => '画面比例 宽屏 16:9'}
        steps={[
          makeStep({
            status: 'failed',
            failure_class: 'upstream_failed',
            task_id: 'task-9',
          }),
        ]}
      />
    )
    // A task exists, so resubmission would pay twice: no button at all.
    expect(screen.queryByText('Retry')).toBeNull()
    expect(screen.getByText('task-9')).toBeDefined()
    expect(screen.getByText('生成服务执行失败。')).toBeDefined()
  })

  it('offers a retry for a submission that never produced a task', () => {
    render(
      <RunStatus
        retrying={false}
        onRetry={vi.fn()}
        specSummary={() => '画面比例 宽屏 16:9'}
        steps={[
          makeStep({
            status: 'failed',
            failure_class: 'submission_rejected',
            task_id: '',
          }),
        ]}
      />
    )
    expect(screen.getByText('Retry')).toBeDefined()
    expect(screen.getByText('提交没有成功，未产生费用。')).toBeDefined()
  })

  it('reports the failed count as text, not only as a coloured bar', () => {
    render(
      <RunStatus
        retrying={false}
        onRetry={vi.fn()}
        specSummary={() => '-'}
        steps={[
          makeStep({ id: 1, status: 'succeeded' }),
          makeStep({ id: 2, status: 'failed', failure_class: 'upstream_failed' }),
        ]}
      />
    )
    // Progress is announced as text in a live region, not only as a coloured
    // bar. Test resources are empty, so the interpolated keys come back raw.
    const done = screen.getByText('{done} of {total} done')
    expect(done.closest('[aria-live="polite"]')).not.toBeNull()
    expect(screen.getByText('{count} failed')).toBeDefined()
  })
})

describe('deep link entry', () => {
  const linkedProject = {
    id: 9,
    user_id: 1,
    name: '链接指向的任务',
    kind: 'image',
    status: 'awaiting_confirmation',
    plan_revision: 3,
    brief: '',
    role: '主视觉',
    default_capability: 'workbuddy:hy-image-3.5-wb',
    token_id: 1,
    parameters: JSON.stringify({ prompt: 'a poster' }),
    created_at: 1,
    updated_at: 1,
    steps: [],
  }
  const newestProject = {
    ...linkedProject,
    id: 1,
    name: '最新的任务',
    status: 'draft',
    plan_revision: 1,
  }

  const seedTwoProjects = () => {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    })
    client.setQueryData(['design', 'capabilities'], [makeCapability()])
    client.setQueryData(['design', 'projects'], {
      items: [newestProject, linkedProject],
      total: 2,
      page: 1,
      size: 50,
    })
    client.setQueryData(['design', 'project', 1], newestProject)
    client.setQueryData(['design', 'project', 9], linkedProject)
    client.setQueryData(['design', 'api-keys'], [{ id: 1, name: 'default-key' }])
    return client
  }

  it('lands on the project the URL names instead of the newest one', () => {
    render(
      <QueryClientProvider client={seedTwoProjects()}>
        <Design initialProjectId={9} initialPlanRevision={3} />
      </QueryClientProvider>
    )
    // The linked project awaits confirmation, so its cost sheet is on screen;
    // the newest one is a draft and would show the brief step instead.
    expect(screen.getByText('Confirm and continue')).toBeDefined()
    expect(screen.queryByText(/re-planned after the link was sent/)).toBeNull()
  })

  it('falls back to the newest project when the URL names none', () => {
    render(
      <QueryClientProvider client={seedTwoProjects()}>
        <Design />
      </QueryClientProvider>
    )
    expect(screen.queryByText('Confirm and continue')).toBeNull()
  })

  it('warns when the linked quote was superseded by a newer plan', () => {
    render(
      <QueryClientProvider client={seedTwoProjects()}>
        <Design initialProjectId={9} initialPlanRevision={2} />
      </QueryClientProvider>
    )
    expect(
      screen.getByText(/re-planned after the link was sent/)
    ).toBeDefined()
  })
})
