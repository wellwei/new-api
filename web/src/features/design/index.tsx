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
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  Download,
  FilePlus2,
  Loader2,
  Play,
  RefreshCw,
  Sparkles,
  Trash2,
  TriangleAlert,
} from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { CopyButton } from '@/components/copy-button'
import { SectionPageLayout } from '@/components/layout'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Textarea } from '@/components/ui/textarea'
import { getApiKeys } from '@/features/keys/api'
import {
  defaultValuesFromSchema,
  SchemaForm,
} from '@/features/design/schema-form'
import {
  confirmDesignProject,
  createDesignProject,
  deleteDesignProject,
  getDesignCapabilities,
  getDesignCapabilitySchema,
  getDesignProject,
  listDesignProjects,
  planDesignProject,
  retryDesignStep,
  runDesignProject,
  updateDesignProject,
} from '@/features/design/api'
import type {
  DesignCapability,
  DesignCapabilityPreset,
  DesignParameterSchema,
  DesignProjectView,
  DesignStepWithAssets,
} from '@/features/design/types'
import { formatQuota } from '@/lib/format'
import { requireServerSuccess } from '@/lib/server-error-message'
import { cn } from '@/lib/utils'

const STATUS_LABELS: Record<string, string> = {
  draft: '草稿',
  awaiting_confirmation: '待确认',
  ready: '已确认',
  generating: '生成中',
  review: '待验收',
  completed: '已完成',
  partial: '部分完成',
}

const STEP_STATUS_LABELS: Record<string, string> = {
  pending: '待提交',
  submitted: '已提交',
  succeeded: '已完成',
  failed: '已失败',
}

const FAILURE_LABELS: Record<string, string> = {
  submission_rejected: '提交被拒（未产生任务，可重试）',
  parameter_rejected: '参数被上游拒绝（修正后重试）',
  upstream_failed: '上游任务失败',
}

export type DraftState = {
  name: string
  kind: 'image' | 'video'
  capability_id: string
  token_id: number
  role: string
  brief: string
  parameters: Record<string, unknown>
}

export function draftFromProject(project: DesignProjectView): DraftState {
  let parameters: Record<string, unknown> = {}
  try {
    parameters = project.parameters ? JSON.parse(project.parameters) : {}
  } catch {
    parameters = {}
  }
  return {
    name: project.name,
    kind: project.kind,
    capability_id: project.default_capability,
    token_id: project.token_id,
    role: project.role || '主视觉',
    brief: project.brief ?? '',
    parameters,
  }
}

export function filterCapabilitiesByKind(
  capabilities: DesignCapability[],
  kind: 'image' | 'video'
): DesignCapability[] {
  const matched = capabilities.filter((item) => item.media_type === kind)
  return matched.length > 0 ? matched : capabilities
}

export function applyCapabilityPreset(
  draft: DraftState,
  preset: DesignCapabilityPreset,
  schema?: DesignParameterSchema | null
): DraftState {
  const defaults = defaultValuesFromSchema(schema)
  const presetParams =
    preset.parameters && typeof preset.parameters === 'object'
      ? preset.parameters
      : {}
  const nextRole =
    typeof preset.role === 'string' && preset.role.trim() !== ''
      ? preset.role.trim()
      : draft.role
  return {
    ...draft,
    role: nextRole,
    parameters: {
      ...defaults,
      ...draft.parameters,
      ...presetParams,
    },
  }
}

const REFERENCE_PARAM_KEYS = [
  'image',
  'first_frame_image',
  'last_frame_image',
  'reference_images',
] as const

const SPEC_DISPLAY_KEYS = [
  'aspect_ratio',
  'resolution',
  'size',
  'duration',
  'count',
  'generate_audio',
] as const

export function summarizeStepSpec(parametersRaw: string): {
  summary: string
  inputMode: string
  prompt: string
} {
  let parsed: Record<string, unknown> = {}
  try {
    parsed = parametersRaw ? JSON.parse(parametersRaw) : {}
  } catch {
    parsed = {}
  }
  const hasReference = REFERENCE_PARAM_KEYS.some((key) => {
    const val = parsed[key]
    if (Array.isArray(val)) return val.length > 0
    if (typeof val === 'string') return val.trim() !== ''
    return val != null
  })
  const inputMode = hasReference ? '参考图驱动' : '纯文字生成'
  const parts: string[] = []
  for (const key of SPEC_DISPLAY_KEYS) {
    const val = parsed[key]
    if (val === undefined || val === null || val === '') continue
    if (typeof val === 'boolean') {
      parts.push(`${key}=${val ? '开启' : '关闭'}`)
    } else {
      parts.push(`${key}=${String(val)}`)
    }
  }
  const prompt = typeof parsed['prompt'] === 'string' ? parsed['prompt'] : ''
  return {
    summary: parts.join(' · '),
    inputMode,
    prompt,
  }
}

function isAssetImage(asset: { mime_type: string }): boolean {
  return asset.mime_type.startsWith('image/') || asset.mime_type === ''
}

function AssetItem({
  url,
  mimeType,
  index,
}: {
  url: string
  mimeType: string
  index: number
}) {
  return (
    <div className="group relative overflow-hidden rounded-md border">
      {isAssetImage({ mime_type: mimeType }) ? (
        <img src={url} alt={`candidate-${index}`} className="w-full" loading="lazy" />
      ) : (
        <video src={url} controls className="w-full" preload="metadata" />
      )}
      <a
        href={url}
        download
        className="bg-background/80 absolute right-2 top-2 rounded-md p-1.5 opacity-0 transition group-hover:opacity-100"
        title="下载"
      >
        <Download className="h-4 w-4" />
      </a>
    </div>
  )
}

export function Design() {
  const { t } = useTranslation()
  const queryClient = useQueryClient()

  const [selectedId, setSelectedId] = useState<number | null>(null)
  const [draft, setDraft] = useState<DraftState | null>(null)
  const [mobileTab, setMobileTab] = useState<'params' | 'assets' | 'workflow'>(
    'params'
  )
  const [confirmOpen, setConfirmOpen] = useState(false)
  const [errorText, setErrorText] = useState('')

  const capabilitiesQuery = useQuery({
    queryKey: ['design', 'capabilities'],
    queryFn: getDesignCapabilities,
    staleTime: 60 * 1000,
  })
  const capabilities: DesignCapability[] = Array.isArray(capabilitiesQuery.data)
    ? capabilitiesQuery.data
    : []

  const projectsQuery = useQuery({
    queryKey: ['design', 'projects'],
    queryFn: () => listDesignProjects({ p: 1, size: 50 }),
    staleTime: 10 * 1000,
  })
  const projects = Array.isArray(projectsQuery.data?.items)
    ? projectsQuery.data.items
    : []

  const projectQuery = useQuery({
    queryKey: ['design', 'project', selectedId],
    queryFn: () => getDesignProject(selectedId as number),
    enabled: selectedId != null,
    // While tasks are in flight, poll so assets appear as they persist.
    refetchInterval: (query) => {
      const data = query.state.data as DesignProjectView | undefined
      if (!data) return false
      const running =
        data.status === 'generating' ||
        (data.steps ?? []).some((step) => step.status === 'submitted')
      return running ? 4000 : false
    },
  })
  const project = projectQuery.data

  const keysQuery = useQuery({
    queryKey: ['design', 'api-keys'],
    queryFn: async () => {
      const result = requireServerSuccess(await getApiKeys({ p: 1, size: 100 }))
      return result.data?.items ?? []
    },
    staleTime: 30 * 1000,
  })
  const keys = Array.isArray(keysQuery.data) ? keysQuery.data : []

  useEffect(() => {
    if (selectedId === null && projects.length > 0) {
      setSelectedId(projects[0].id)
    }
  }, [selectedId, projects])

  useEffect(() => {
    if (project) {
      setDraft(draftFromProject(project))
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project?.id])

  const filteredCapabilities = useMemo(
    () => filterCapabilitiesByKind(capabilities, draft?.kind ?? 'image'),
    [capabilities, draft?.kind]
  )

  const capability = useMemo(
    () =>
      capabilities.find((item) => item.id === draft?.capability_id) ?? null,
    [capabilities, draft?.capability_id]
  )

  const deferredSchemaQuery = useQuery({
    queryKey: ['design', 'capability-schema', capability?.id],
    queryFn: () => getDesignCapabilitySchema(capability!.id),
    enabled: Boolean(
      capability?.id && capability.defer_schema && !capability.parameter_schema
    ),
    staleTime: 5 * 60 * 1000,
  })

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ['design'] })
  }

  const withError = async (action: () => Promise<unknown>) => {
    setErrorText('')
    try {
      await action()
      invalidate()
    } catch (error) {
      setErrorText(error instanceof Error ? error.message : String(error))
    }
  }

  const createMutation = useMutation({
    mutationFn: createDesignProject,
    onSuccess: (created) => {
      setSelectedId(created.id)
      setDraft(draftFromProject({ ...created, steps: [] }))
      invalidate()
    },
    onError: (error: Error) => setErrorText(error.message),
  })

  const saveDraft = () => {
    if (!selectedId || !draft) return
    void withError(() =>
      updateDesignProject(selectedId, {
        name: draft.name,
        kind: draft.kind,
        capability_id: draft.capability_id,
        token_id: draft.token_id,
        role: draft.role,
        brief: draft.brief,
        parameters: draft.parameters,
      })
    )
  }

  const planMutation = useMutation({
    mutationFn: async () => {
      if (!selectedId || !draft) throw new Error('请先保存草稿')
      await updateDesignProject(selectedId, {
        name: draft.name,
        kind: draft.kind,
        capability_id: draft.capability_id,
        token_id: draft.token_id,
        role: draft.role,
        brief: draft.brief,
        parameters: draft.parameters,
      })
      return planDesignProject(selectedId)
    },
    onSuccess: (planned) => {
      setDraft(draftFromProject(planned))
      invalidate()
    },
    onError: (error: Error) => setErrorText(error.message),
  })

  const confirmMutation = useMutation({
    mutationFn: () => {
      if (!selectedId) throw new Error('未选择项目')
      return confirmDesignProject(selectedId)
    },
    onSuccess: () => {
      setConfirmOpen(false)
      invalidate()
    },
    onError: (error: Error) => setErrorText(error.message),
  })

  const runMutation = useMutation({
    mutationFn: () => {
      if (!selectedId) throw new Error('未选择项目')
      return runDesignProject(selectedId)
    },
    onSuccess: (result) => {
      setMobileTab('workflow')
      if (result.submitError) setErrorText(result.submitError)
      invalidate()
    },
    onError: (error: Error) => setErrorText(error.message),
  })

  const retryMutation = useMutation({
    mutationFn: (stepId: number) => {
      if (!selectedId) throw new Error('未选择项目')
      return retryDesignStep(selectedId, stepId)
    },
    onSuccess: () => invalidate(),
    onError: (error: Error) => setErrorText(error.message),
  })

  const deleteMutation = useMutation({
    mutationFn: () => {
      if (!selectedId) throw new Error('未选择项目')
      return deleteDesignProject(selectedId)
    },
    onSuccess: () => {
      setSelectedId(null)
      setDraft(null)
      invalidate()
    },
    onError: (error: Error) => setErrorText(error.message),
  })

  const busy =
    planMutation.isPending ||
    confirmMutation.isPending ||
    runMutation.isPending ||
    retryMutation.isPending ||
    deleteMutation.isPending ||
    createMutation.isPending

  const editable =
    project?.status === 'draft' ||
    project?.status === 'awaiting_confirmation' ||
    project?.status === 'ready'

  const paramSchema: DesignParameterSchema | null =
    capability?.parameter_schema ?? deferredSchemaQuery.data ?? null
  const hasSchemaPrompt = Boolean(paramSchema?.properties?.['prompt'])
  const promptText = (draft?.parameters['prompt'] as string | undefined) ?? ''
  const presets = capability?.presets ?? []

  const renderParamsPanel = () => (
    <div className="space-y-4">
      {capabilities.length === 0 ? (
        <Card>
          <CardContent className="text-muted-foreground py-8 text-center text-sm">
            {capabilitiesQuery.isLoading
              ? t('Loading…')
              : t('No design capability is available: the workbench switch must be on, and a workbench plugin capability must be priced with an available channel.')}
          </CardContent>
        </Card>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">{t('Project')}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex items-center gap-2">
            <Select
              value={selectedId == null ? '' : String(selectedId)}
              onValueChange={(value) => {
                setSelectedId(value === '' ? null : Number(value))
                setDraft(null)
              }}
            >
              <SelectTrigger className="w-full">
                <SelectValue placeholder={t('Select project')} />
              </SelectTrigger>
              <SelectContent>
                {projects.map((item) => (
                  <SelectItem key={item.id} value={String(item.id)}>
                    {item.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button
              variant="outline"
              size="sm"
              disabled={busy}
              onClick={() => {
                const defaultCap =
                  capabilities.find((item) => item.media_type === 'image') ??
                  capabilities[0]
                createMutation.mutate({
                  name: `设计项目 ${new Date().toLocaleString()}`,
                  kind: defaultCap?.media_type ?? 'image',
                  capability_id: defaultCap?.id ?? '',
                  token_id: keys[0]?.id ?? 0,
                })
              }}
            >
              <FilePlus2 className="mr-1 h-4 w-4" />
              {t('New')}
            </Button>
          </div>

          {project && draft ? (
            <div className="space-y-3">
              <div className="space-y-2">
                <Label>{t('Name')}</Label>
                <Input
                  value={draft.name}
                  disabled={!editable}
                  onChange={(event) =>
                    setDraft({ ...draft, name: event.target.value })
                  }
                />
              </div>
              <div className="grid grid-cols-2 gap-2">
                <div className="space-y-2">
                  <Label>{t('Delivery form')}</Label>
                  <Select
                    value={draft.kind}
                    disabled={!editable}
                    onValueChange={(value) => {
                      const nextKind = value as 'image' | 'video'
                      const matching = filterCapabilitiesByKind(
                        capabilities,
                        nextKind
                      )
                      const currentMatches = matching.some(
                        (item) => item.id === draft.capability_id
                      )
                      setDraft({
                        ...draft,
                        kind: nextKind,
                        capability_id: currentMatches
                          ? draft.capability_id
                          : (matching[0]?.id ?? ''),
                        parameters: currentMatches ? draft.parameters : {},
                      })
                    }}
                  >
                    <SelectTrigger className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="image">{t('Image')}</SelectItem>
                      <SelectItem value="video">{t('Video')}</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-2">
                  <Label>{t('Semantic role')}</Label>
                  <Input
                    value={draft.role}
                    disabled={!editable}
                    onChange={(event) =>
                      setDraft({ ...draft, role: event.target.value })
                    }
                  />
                </div>
              </div>
              <div className="space-y-2">
                <Label>{t('Capability / Model')}</Label>
                <Select
                  value={draft.capability_id}
                  disabled={!editable}
                  onValueChange={(value) => {
                    const selectedCap = capabilities.find(
                      (item) => item.id === value
                    )
                    setDraft({
                      ...draft,
                      kind: selectedCap?.media_type ?? draft.kind,
                      capability_id: value ?? '',
                      parameters: {},
                    })
                  }}
                >
                  <SelectTrigger className="w-full">
                    <SelectValue placeholder={t('Select capability')} />
                  </SelectTrigger>
                  <SelectContent>
                    {filteredCapabilities.map((item) => (
                      <SelectItem key={item.id} value={item.id}>
                        {item.plugin_name} · {item.model}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label>{t('Billing token')}</Label>
                <Select
                  value={draft.token_id === 0 ? '' : String(draft.token_id)}
                  disabled={!editable}
                  onValueChange={(value) =>
                    setDraft({ ...draft, token_id: Number(value) })
                  }
                >
                  <SelectTrigger className="w-full">
                    <SelectValue placeholder={t('Select token')} />
                  </SelectTrigger>
                  <SelectContent>
                    {keys.map((key: { id: number; name: string }) => (
                      <SelectItem key={key.id} value={String(key.id)}>
                        {key.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <p className="text-muted-foreground text-xs">
                  {t('The server bills through this token directly; the token secret never reaches the browser.')}
                </p>
              </div>
            </div>
          ) : null}
        </CardContent>
      </Card>

      {project && draft ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">{t('Requirements & Parameters')}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            {presets.length > 0 ? (
              <div className="space-y-2">
                <Label className="text-xs text-muted-foreground">
                  {t('Scene presets')}
                </Label>
                <div className="flex flex-wrap gap-1.5">
                  {presets.map((preset, index) => {
                    const label =
                      typeof preset.name === 'string' && preset.name
                        ? preset.name
                        : typeof preset.id === 'string' && preset.id
                          ? preset.id
                          : `Preset ${index + 1}`
                    return (
                      <Button
                        key={String(preset.id ?? index)}
                        type="button"
                        variant="outline"
                        size="sm"
                        className="h-7 px-2.5 text-xs"
                        disabled={!editable}
                        onClick={() =>
                          setDraft(
                            applyCapabilityPreset(draft, preset, paramSchema)
                          )
                        }
                      >
                        <Sparkles className="mr-1 h-3 w-3" />
                        {label}
                      </Button>
                    )
                  })}
                </div>
              </div>
            ) : null}
            {deferredSchemaQuery.isLoading ? (
              <div className="text-muted-foreground flex items-center gap-2 text-sm">
                <Loader2 className="h-4 w-4 animate-spin" />
                <span>{t('Loading…')}</span>
              </div>
            ) : null}
            {paramSchema ? (
              <SchemaForm
                schema={paramSchema}
                values={draft.parameters}
                disabled={!editable}
                onChange={(name, value) =>
                  setDraft({
                    ...draft,
                    parameters: { ...draft.parameters, [name]: value },
                  })
                }
              />
            ) : null}
            {!hasSchemaPrompt && !deferredSchemaQuery.isLoading ? (
              <div className="space-y-2">
                <Label>{t('Prompt')} *</Label>
                <Textarea
                  rows={4}
                  value={promptText}
                  disabled={!editable}
                  onChange={(event) =>
                    setDraft({
                      ...draft,
                      parameters: {
                        ...draft.parameters,
                        prompt: event.target.value,
                      },
                    })
                  }
                />
              </div>
            ) : null}
            <div className="flex flex-wrap items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                disabled={!editable || busy}
                onClick={saveDraft}
              >
                {t('Save draft')}
              </Button>
              <Button
                size="sm"
                disabled={!editable || busy || draft.capability_id === '' || draft.token_id === 0}
                onClick={() => planMutation.mutate()}
              >
                {planMutation.isPending ? (
                  <Loader2 className="mr-1 h-4 w-4 animate-spin" />
                ) : null}
                {t('Plan & cost sheet')}
              </Button>
            </div>
          </CardContent>
        </Card>
      ) : null}

      {errorText ? (
        <div className="text-destructive flex items-start gap-2 text-sm">
          <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" />
          <span>{errorText}</span>
        </div>
      ) : null}
    </div>
  )

  const renderAssetsPanel = () => {
    const steps = Array.isArray(project?.steps) ? project.steps : []
    const assetsByRole = new Map<string, DesignStepWithAssets['assets']>()
    steps.forEach((step) => {
      const assets = step.assets ?? []
      if (assets.length === 0) return
      assetsByRole.set(step.role, [
        ...(assetsByRole.get(step.role) ?? []),
        ...assets,
      ])
    })
    return (
      <div className="space-y-4">
        {assetsByRole.size === 0 ? (
          <Card>
            <CardContent className="text-muted-foreground py-10 text-center text-sm">
              {t('Finished assets appear here one by one as tasks complete')}
            </CardContent>
          </Card>
        ) : null}
        {[...assetsByRole.entries()].map(([role, assets]) => (
          <Card key={role}>
            <CardHeader>
              <CardTitle className="text-base">{role}</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
                {(assets ?? []).map((asset, index) => (
                  <AssetItem
                    key={asset.id}
                    url={asset.url ?? ''}
                    mimeType={asset.mime_type}
                    index={index}
                  />
                ))}
              </div>
            </CardContent>
          </Card>
        ))}
      </div>
    )
  }

  const renderWorkflowPanel = () => {
    const steps = Array.isArray(project?.steps) ? project.steps : []
    return (
      <div className="space-y-3">
        {steps.map((step) => {
          const spec = summarizeStepSpec(step.parameters)
          return (
            <Card key={step.id}>
              <CardContent className="space-y-2 pt-4">
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <Badge
                      variant={
                        step.status === 'succeeded'
                          ? 'default'
                          : step.status === 'failed'
                            ? 'destructive'
                            : 'secondary'
                      }
                    >
                      {STEP_STATUS_LABELS[step.status] ?? step.status}
                    </Badge>
                    <span className="text-sm font-medium">{step.role}</span>
                  </div>
                  {step.status === 'failed' && step.task_id === '' ? (
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={busy}
                      onClick={() => retryMutation.mutate(step.id)}
                    >
                      <RefreshCw className="mr-1 h-3.5 w-3.5" />
                      {t('Retry')}
                    </Button>
                  ) : null}
                </div>
                <div className="text-muted-foreground text-xs space-y-1">
                  <div>
                    {t('Model')}: {step.model} · {t('Operation')}: {step.operation}
                  </div>
                  <div>
                    {t('Input source')}: {spec.inputMode}
                    {spec.summary ? ` · ${spec.summary}` : ''}
                  </div>
                  {step.task_id ? (
                    <div className="flex items-center gap-1">
                      <span>task: {step.task_id}</span>
                      <CopyButton value={step.task_id} />
                    </div>
                  ) : null}
                  {step.status === 'failed' && step.failure_class ? (
                    <div className="text-destructive">
                      {FAILURE_LABELS[step.failure_class] ?? step.failure_class}
                    </div>
                  ) : null}
                </div>
              </CardContent>
            </Card>
          )
        })}
        {steps.length === 0 ? (
          <Card>
            <CardContent className="text-muted-foreground py-10 text-center text-sm">
              {t('After planning, steps and dependencies appear here')}
            </CardContent>
          </Card>
        ) : null}
      </div>
    )
  }

  const estimate = project?.estimate
  const showConfirmSheet =
    project?.status === 'awaiting_confirmation' && estimate != null
  const primaryStepSpec = summarizeStepSpec(
    project?.steps?.[0]?.parameters ?? project?.parameters ?? ''
  )

  return (
    <SectionPageLayout>
      <SectionPageLayout.Title>{t('AI Design Workbench')}</SectionPageLayout.Title>
      <SectionPageLayout.Actions>
        {project ? (
          <div className="flex items-center gap-2">
            <Badge variant="outline">
              {STATUS_LABELS[project.status] ?? project.status}
            </Badge>
            {showConfirmSheet ? (
              <Button size="sm" onClick={() => setConfirmOpen(true)}>
                {t('Confirm cost & ready')}
              </Button>
            ) : null}
            {project.status === 'ready' ? (
              <Button
                size="sm"
                disabled={busy}
                onClick={() => runMutation.mutate()}
              >
                <Play className="mr-1 h-4 w-4" />
                {t('Start generation')}
              </Button>
            ) : null}
            <Button
              variant="outline"
              size="sm"
              disabled={busy || project.status === 'generating'}
              onClick={() => deleteMutation.mutate()}
            >
              <Trash2 className="h-4 w-4" />
            </Button>
          </div>
        ) : null}
      </SectionPageLayout.Actions>
      <SectionPageLayout.Content>
        {/* Mobile: three tabs per §9 */}
        <div className="md:hidden">
          <Tabs value={mobileTab} onValueChange={(value) => setMobileTab(value as typeof mobileTab)}>
            <TabsList className="w-full">
              <TabsTrigger value="params" className="flex-1">{t('Parameters')}</TabsTrigger>
              <TabsTrigger value="assets" className="flex-1">{t('Canvas')}</TabsTrigger>
              <TabsTrigger value="workflow" className="flex-1">{t('Workflow')}</TabsTrigger>
            </TabsList>
            <TabsContent value="params">{renderParamsPanel()}</TabsContent>
            <TabsContent value="assets">{renderAssetsPanel()}</TabsContent>
            <TabsContent value="workflow">{renderWorkflowPanel()}</TabsContent>
          </Tabs>
        </div>

        {/* Desktop: three columns per §9 */}
        <div className={cn('hidden gap-4 md:grid md:grid-cols-3 xl:grid-cols-4')}>
          <div className="xl:col-span-1 md:col-span-1">{renderParamsPanel()}</div>
          <div className="xl:col-span-2 md:col-span-1">{renderAssetsPanel()}</div>
          <div className="xl:col-span-1 md:col-span-1">{renderWorkflowPanel()}</div>
        </div>

        <Dialog open={confirmOpen} onOpenChange={setConfirmOpen}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>{t('Cost confirmation')}</DialogTitle>
              <DialogDescription>
                {t('Confirm the outputs and estimated charge; generation unlocks after confirmation.')}
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-3 text-sm">
              <div className="flex justify-between gap-4">
                <span>{t('Outputs')}</span>
                <span className="text-right">
                  {(project?.steps ?? []).map((step) => step.role).join('、') || '-'}
                </span>
              </div>
              <div className="flex justify-between gap-4">
                <span>{t('Model')}</span>
                <span className="text-right">{project?.steps?.[0]?.model ?? '-'}</span>
              </div>
              <div className="flex justify-between gap-4">
                <span>{t('Specifications')}</span>
                <span className="text-right">
                  {primaryStepSpec.summary || '-'}
                </span>
              </div>
              <div className="flex justify-between gap-4">
                <span>{t('Input source')}</span>
                <span className="text-right">{primaryStepSpec.inputMode}</span>
              </div>
              <div className="flex justify-between gap-4">
                <span>{t('Estimated charge')}</span>
                <span className="font-medium text-right">
                  {estimate ? formatQuota(estimate.quota_per_call) : '-'}
                </span>
              </div>
              <p className="text-muted-foreground text-xs">
                {t('The estimate is for confirmation only; settlement follows the real usage the plugin reports, and failures are refunded automatically.')}
              </p>
              <div className="flex justify-end gap-2 pt-2">
                <Button variant="outline" onClick={() => setConfirmOpen(false)}>
                  {t('Back')}
                </Button>
                <Button
                  disabled={confirmMutation.isPending}
                  onClick={() => confirmMutation.mutate()}
                >
                  {confirmMutation.isPending ? (
                    <Loader2 className="mr-1 h-4 w-4 animate-spin" />
                  ) : null}
                  {t('Confirm')}
                </Button>
              </div>
            </div>
          </DialogContent>
        </Dialog>
      </SectionPageLayout.Content>
    </SectionPageLayout>
  )
}
