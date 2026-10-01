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
import { ImageIcon, Trash2, TriangleAlert } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { ConfirmDialog } from '@/components/confirm-dialog'
import { EmptyState } from '@/components/empty-state'
import { LoadingState } from '@/components/loading-state'
import { SectionPageLayout } from '@/components/layout'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { getApiKeys } from '@/features/keys/api'

import { formatQuota } from '@/lib/format'
import { requireServerSuccess } from '@/lib/server-error-message'

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
} from './api'
import { AssetBoard, RunStatus } from './components/asset-board'
import { BriefForm, ConfirmPanel } from './components/brief-form'
import { EntryEmptyState, EntryPicker } from './components/entry-picker'
import { StepBar } from './components/step-bar'
import { describeReferenceUsage, summarizeStepSpec } from './lib/spec-summary'
import { defaultValuesFromSchema } from './schema-form'
import {
  capabilityDisplayName,
  missingRequiredFields,
  PROJECT_STATUS_HINT,
  PROJECT_STATUS_TEXT,
  type StepKey,
} from './terminology'
import type {
  DesignCapability,
  DesignCapabilityPreset,
  DesignParameterSchema,
  DesignProjectView,
  DesignStepWithAssets,
} from './types'

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

/**
 * Re-exported from lib/spec-summary so existing importers (and the test suite)
 * keep a stable path. The implementation moved out of this file because it grew
 * a reference-image branch and stopped being a two-line JSON.parse.
 */
export { summarizeStepSpec }

/** Derives the furthest step the user has legitimately reached. */
function stepForStatus(status: string | undefined): StepKey {
  if (!status) return 'entry'
  if (status === 'draft') return 'brief'
  if (status === 'awaiting_confirmation' || status === 'ready') return 'preview'
  return 'result'
}

export type DesignProps = {
  /**
   * Project the URL points at. Wins over "newest first" so a link someone was
   * sent lands on that task instead of on whatever was created last.
   */
  initialProjectId?: number
  /**
   * Plan revision the link was minted for. The server bumps the revision on
   * every re-plan, so a mismatch means the quote on screen is not the one the
   * reader was sent to approve.
   */
  initialPlanRevision?: number
  /** Lets the route own the URL, which is what makes a deep link survive a refresh. */
  onProjectSelect?: (projectId: number) => void
}

export function Design(props: DesignProps = {}) {
  const { t } = useTranslation()
  const queryClient = useQueryClient()

  const [selectedId, setSelectedId] = useState<number | null>(null)
  const [draft, setDraft] = useState<DraftState | null>(null)
  const [step, setStep] = useState<StepKey>('entry')
  const [errorText, setErrorText] = useState('')
  const [deleteOpen, setDeleteOpen] = useState(false)

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
        (data.steps ?? []).some((stepItem) => stepItem.status === 'submitted')
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
    if (selectedId !== null || projects.length === 0) return
    const linked = projects.find((item) => item.id === props.initialProjectId)
    setSelectedId(linked?.id ?? projects[0].id)
    // projects is re-derived each render; the id list is the real signal here.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId, projectsQuery.data, props.initialProjectId])

  useEffect(() => {
    if (project) {
      setDraft(draftFromProject(project))
      setStep(stepForStatus(project.status))
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project?.id, project?.status])

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ['design'] })
  }

  const createMutation = useMutation({
    mutationFn: createDesignProject,
    onSuccess: (created) => {
      setSelectedId(created.id)
      setDraft(draftFromProject({ ...created, steps: [] }))
      setStep('entry')
      invalidate()
    },
    onError: (error: Error) => setErrorText(error.message),
  })

  const planMutation = useMutation({
    mutationFn: async () => {
      if (!selectedId || !draft) throw new Error(t('Please finish step 1 first'))
      // Saving and planning are one user action now: the old page required a
      // separate "save draft" click that gave no feedback.
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
      setStep('preview')
      invalidate()
    },
    onError: (error: Error) => setErrorText(error.message),
  })

  const confirmMutation = useMutation({
    mutationFn: () => {
      if (!selectedId) throw new Error(t('No task selected'))
      // Approve the revision this link names, not the project's current one.
      // Sending the current revision would make the server check pointless:
      // a re-plan between reading the quote and clicking would then be
      // confirmed at the new price the user never saw.
      return confirmDesignProject(selectedId, props.initialPlanRevision)
    },
    onSuccess: (confirmed) => {
      // Confirmation alone must not spend money. The design doc (§4.3) treats
      // "review the cost sheet" and "start generating" as two deliberate acts,
      // and keeping them apart also means a failed run cannot be retried by
      // re-confirming an already-confirmed project (§4.6).
      setDraft(draftFromProject({ ...confirmed, steps: [] }))
      setErrorText('')
      invalidate()
    },
    onError: (error: Error) => setErrorText(error.message),
  })

  const runMutation = useMutation({
    mutationFn: () => {
      if (!selectedId) throw new Error(t('No task selected'))
      return runDesignProject(selectedId)
    },
    onSuccess: (result) => {
      setStep('result')
      if (result.submitError) setErrorText(result.submitError)
      invalidate()
    },
    onError: (error: Error) => setErrorText(error.message),
  })

  const retryMutation = useMutation({
    mutationFn: (stepId: number) => {
      if (!selectedId) throw new Error(t('No task selected'))
      return retryDesignStep(selectedId, stepId)
    },
    onSuccess: () => invalidate(),
    onError: (error: Error) => setErrorText(error.message),
  })

  const deleteMutation = useMutation({
    mutationFn: () => {
      if (!selectedId) throw new Error(t('No task selected'))
      return deleteDesignProject(selectedId)
    },
    onSuccess: () => {
      setSelectedId(null)
      setDraft(null)
      setStep('entry')
      setDeleteOpen(false)
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

  const capability = useMemo(
    () => capabilities.find((item) => item.id === draft?.capability_id) ?? null,
    // capabilitiesQuery.data is the stable source; the derived array is not.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [capabilitiesQuery.data, draft?.capability_id]
  )

  const deferredSchemaId =
    capability && capability.defer_schema && !capability.parameter_schema
      ? capability.id
      : null

  const deferredSchemaQuery = useQuery({
    queryKey: ['design', 'capability-schema', deferredSchemaId],
    queryFn: () => getDesignCapabilitySchema(deferredSchemaId as string),
    enabled: deferredSchemaId !== null,
    staleTime: 5 * 60 * 1000,
  })

  const paramSchema: DesignParameterSchema | null =
    capability?.parameter_schema ?? deferredSchemaQuery.data ?? null
  const promptText = (draft?.parameters['prompt'] as string | undefined) ?? ''
  const steps: DesignStepWithAssets[] = Array.isArray(project?.steps)
    ? project.steps
    : []
  const primarySpec = summarizeStepSpec(
    steps[0]?.parameters ?? project?.parameters ?? ''
  )

  /**
   * The link a reader arrived on names the plan revision it was minted for. A
   * re-plan bumps that revision server side, so a mismatch means the numbers on
   * screen are newer than the ones the reader was sent to approve — worth
   * saying out loud before anyone clicks.
   */
  const quoteSuperseded =
    props.initialPlanRevision !== undefined &&
    project !== undefined &&
    project.plan_revision !== props.initialPlanRevision

  /**
   * A planned step carries the raw model slug, which is vendor plumbing. The
   * quote shows the same human label the picker showed, so the two screens
   * cannot disagree about what was chosen.
   */
  const previewCapability =
    capability ??
    capabilities.find((item) => item.id === steps[0]?.capability_id)
  const previewModelLabel = previewCapability
    ? capabilityDisplayName(previewCapability, capabilities)
    : (steps[0]?.model ?? '-')

  const missing = draft
    ? missingRequiredFields(
        promptText.trim() !== '',
        draft.capability_id,
        draft.token_id
      )
    : []
  const canPlan = draft !== null && missing.length === 0 && !busy

  const reached: StepKey = (() => {
    if (!project) return 'entry'
    if (project.status === 'generating' || steps.length > 0) return 'result'
    if (project.status === 'awaiting_confirmation' || project.status === 'ready') {
      return 'preview'
    }
    if (promptText.trim() !== '') return 'preview'
    return 'entry'
  })()

  const startFirstProject = () => {
    const defaultCap =
      capabilities.find((item) => item.media_type === 'image') ?? capabilities[0]
    createMutation.mutate({
      name: t('Untitled design'),
      kind: defaultCap?.media_type ?? 'image',
      capability_id: defaultCap?.id ?? '',
      token_id: keys[0]?.id ?? 0,
    })
  }

  const renderEntry = () => {
    if (!project || !draft) return null
    return (
      <EntryPicker
        kind={draft.kind}
        onKindChange={(kind) => {
          const matching = filterCapabilitiesByKind(capabilities, kind)
          const currentKept = matching.some(
            (item) => item.id === draft.capability_id
          )
          setDraft({
            ...draft,
            kind,
            capability_id: currentKept
              ? draft.capability_id
              : (matching[0]?.id ?? ''),
            parameters: currentKept ? draft.parameters : {},
          })
        }}
        capabilities={capabilities}
        capabilityId={draft.capability_id}
        onCapabilityChange={(id) => {
          const selected = capabilities.find((item) => item.id === id)
          setDraft({
            ...draft,
            kind: selected?.media_type ?? draft.kind,
            capability_id: id,
            parameters: {},
          })
        }}
        tokenId={draft.token_id}
        onTokenChange={(id) => setDraft({ ...draft, token_id: id })}
        keys={keys}
      />
    )
  }

  const renderBrief = () => {
    if (!draft) return null
    return (
      <BriefForm
        name={draft.name}
        onNameChange={(value) => setDraft({ ...draft, name: value })}
        role={draft.role}
        onRoleChange={(value) => setDraft({ ...draft, role: value })}
        brief={draft.brief}
        onBriefChange={(value) => setDraft({ ...draft, brief: value })}
        parameters={draft.parameters}
        onParameterChange={(name, value) =>
          setDraft({
            ...draft,
            parameters: { ...draft.parameters, [name]: value },
          })
        }
        schema={paramSchema}
        schemaLoading={deferredSchemaQuery.isLoading}
        presets={capability?.presets ?? []}
        kind={draft.kind}
        referenceLimits={capability?.reference_limits}
        onPresetClick={(preset) =>
          setDraft(applyCapabilityPreset(draft, preset, paramSchema))
        }
      />
    )
  }

  const renderPreview = () => {
    const confirmed = project?.status === 'ready'
    const canConfirm =
      project?.status === 'awaiting_confirmation' || project?.status === 'draft'
    return (
      <ConfirmPanel
        outputs={
          steps.length > 0
            ? steps.map((item) => item.role).join('、')
            : (draft?.role ?? '-')
        }
        model={previewModelLabel}
        specs={primarySpec.summary || '-'}
        inputMode={primarySpec.inputMode}
        referenceUsage={
          primarySpec.referenceCount > 0
            ? describeReferenceUsage(
                steps[0]?.parameters ?? project?.parameters ?? '',
                capability?.reference_limits
              )
            : undefined
        }
        estimateText={
          project?.estimate ? formatQuota(project.estimate.quota_per_call) : '-'
        }
        confirmText={t(
          'The estimate is for confirmation only; settlement follows the real usage the plugin reports, and failures are refunded automatically.'
        )}
        confirmed={confirmed}
        onConfirm={() => confirmMutation.mutate()}
        onRun={() => runMutation.mutate()}
        onAdjust={() => setStep('brief')}
        confirming={confirmMutation.isPending}
        running={runMutation.isPending}
        generating={project?.status === 'generating'}
        canGenerate={canConfirm || confirmed}
        missingHint={
          missing.length > 0
            ? t('Still needed: {fields}', { fields: missing.join('、') })
            : undefined
        }
      />
    )
  }

  const regenerate = () => {
    if (!draft) return
    // Keep the model and format, drop the prompt: the user asked for another
    // take, not a rerun of the identical request.
    setDraft({ ...draft, parameters: {} })
    setStep('brief')
  }

  const renderResult = () => (
    <div className='space-y-4'>
      <AssetBoard
        steps={steps}
        generating={project?.status === 'generating'}
        onAdjust={() => setStep('brief')}
        onRegenerate={regenerate}
      />
      {steps.length > 0 ? (
        <RunStatus
          steps={steps}
          onRetry={(stepId) => retryMutation.mutate(stepId)}
          retrying={retryMutation.isPending}
          specSummary={(item) => {
            const spec = summarizeStepSpec(item.parameters)
            if (spec.summary) return spec.summary
            return t('No extra settings')
          }}
        />
      ) : null}
    </div>
  )

  if (capabilitiesQuery.isLoading) {
    return (
      <SectionPageLayout>
        <SectionPageLayout.Title>{t('AI Design')}</SectionPageLayout.Title>
        <SectionPageLayout.Content>
          <LoadingState message={t('Loading…')} />
        </SectionPageLayout.Content>
      </SectionPageLayout>
    )
  }

  if (capabilities.length === 0) {
    return (
      <SectionPageLayout>
        <SectionPageLayout.Title>{t('AI Design')}</SectionPageLayout.Title>
        <SectionPageLayout.Content>
          <EmptyState
            icon={ImageIcon}
            bordered
            title={t('No models available yet')}
            description={t(
              'A model appears here once it is enabled, priced, and reachable. Ask an administrator to enable one.'
            )}
          />
        </SectionPageLayout.Content>
      </SectionPageLayout>
    )
  }

  const showEntryGate = !project || !draft

  return (
    <SectionPageLayout>
      <SectionPageLayout.Title>{t('AI Design')}</SectionPageLayout.Title>
      <SectionPageLayout.Actions>
        {project ? (
          <div className='flex items-center gap-2'>
            <Badge variant='outline'>
              {t(PROJECT_STATUS_TEXT[project.status] ?? project.status)}
            </Badge>
            <Button
              variant='outline'
              size='sm'
              disabled={busy || project.status === 'generating'}
              onClick={() => setDeleteOpen(true)}
            >
              <Trash2 className='size-4' />
              {/* Icon-only control: screen readers still need a name. */}
              <span className='sr-only'>{t('Delete task')}</span>
            </Button>
          </div>
        ) : null}
      </SectionPageLayout.Actions>
      <SectionPageLayout.Content>
        <div className='space-y-5'>
          {project ? (
            <div className='space-y-2'>
              <StepBar
                current={step}
                reached={reached}
                onStepClick={setStep}
              />
              <p className='text-muted-foreground text-sm'>
                {t(PROJECT_STATUS_HINT[project.status] ?? '')}
              </p>
            </div>
          ) : null}

          {projects.length > 1 ? (
            <div className='flex flex-wrap items-center gap-2'>
              {projects.map((item) => (
                <Button
                  key={item.id}
                  variant={item.id === selectedId ? 'default' : 'outline'}
                  size='sm'
                  onClick={() => {
                    setSelectedId(item.id)
                    setDraft(null)
                    props.onProjectSelect?.(item.id)
                  }}
                >
                  {item.name}
                </Button>
              ))}
              <Button
                variant='outline'
                size='sm'
                disabled={busy}
                onClick={startFirstProject}
              >
                {t('New task')}
              </Button>
            </div>
          ) : null}

          {errorText ? (
            <div className='text-destructive flex items-start gap-2 text-sm'>
              <TriangleAlert className='mt-0.5 size-4 shrink-0' />
              <span>{errorText}</span>
            </div>
          ) : null}

          {quoteSuperseded ? (
            <Alert>
              <TriangleAlert />
              <AlertDescription>
                {t(
                  'This task was re-planned after the link was sent, so the figures below are newer than the ones you were asked to approve.'
                )}
              </AlertDescription>
            </Alert>
          ) : null}

          {showEntryGate ? (
            <EntryEmptyState
              onStart={startFirstProject}
              disabled={busy || keys.length === 0}
            />
          ) : (
            /*
              The active step owns the left column, results the right. One
              layout for every width: below `md` the two columns simply stack,
              which is why the page no longer carries a second, tab-shaped
              information architecture to keep in sync.
            */
            <div className='grid gap-5 md:grid-cols-2'>
              <div className='space-y-4'>
                {step === 'entry' ? renderEntry() : null}
                {step === 'brief' ? renderBrief() : null}
                {step === 'preview' ? renderPreview() : null}

                {step === 'brief' ? (
                  <div className='flex justify-end'>
                    <Button
                      onClick={() => planMutation.mutate()}
                      disabled={!canPlan}
                    >
                      {planMutation.isPending ? t('Preparing…') : t('Review and generate')}
                    </Button>
                  </div>
                ) : null}
                {step === 'preview' ? (
                  <Button variant='outline' onClick={() => setStep('entry')}>
                    {t('Change type or model')}
                  </Button>
                ) : null}
              </div>
              <div>{renderResult()}</div>
            </div>
          )}
        </div>

        <ConfirmDialog
          open={deleteOpen}
          onOpenChange={setDeleteOpen}
          title={t('Delete this design task?')}
          desc={t(
            'The task and its results are removed. This cannot be undone.'
          )}
          destructive
          isLoading={deleteMutation.isPending}
          handleConfirm={() => deleteMutation.mutate()}
        />
      </SectionPageLayout.Content>
    </SectionPageLayout>
  )
}
