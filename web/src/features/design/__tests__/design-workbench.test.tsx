import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  applyCapabilityPreset,
  type DraftState,
  filterCapabilitiesByKind,
  summarizeStepSpec,
} from '../index'
import { defaultValuesFromSchema, SchemaForm } from '../schema-form'
import type { DesignCapability, DesignParameterSchema } from '../types'

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
    expect(textSpec.summary).toBe(
      'aspect_ratio=16:9 · resolution=720P · duration=5 · generate_audio=开启'
    )

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
    expect(refSpec.summary).toBe('aspect_ratio=3:4 · resolution=2K · count=2')
  })
})

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { Design } from '../index'

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
    expect(container.textContent).toContain("主视觉海报")
    expect(screen.getAllByDisplayValue("测试海报项目").length).toBeGreaterThan(0)
  })
})
