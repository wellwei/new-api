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
import { Sparkles } from 'lucide-react'
import { useTranslation } from 'react-i18next'

import { Button } from '@/components/ui/button'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'

import { SchemaForm } from '../schema-form'
import { ROLE_PRESETS } from '../terminology'
import type {
  DesignCapabilityPreset,
  DesignParameterSchema,
} from '../types'

/** Best available display name for a template chip. */
function presetLabel(
  preset: DesignCapabilityPreset,
  index: number,
  t: (key: string) => string
): string {
  if (typeof preset.name === 'string' && preset.name !== '') return preset.name
  if (typeof preset.id === 'string' && preset.id !== '') return preset.id
  return `${t('Template')} ${index + 1}`
}

type BriefFormProps = {
  name: string
  onNameChange: (value: string) => void
  role: string
  onRoleChange: (value: string) => void
  /** Requirement notes for the human, distinct from the model-facing prompt. */
  brief: string
  onBriefChange: (value: string) => void
  parameters: Record<string, unknown>
  onParameterChange: (name: string, value: unknown) => void
  schema: DesignParameterSchema | null
  schemaLoading?: boolean
  presets: DesignCapabilityPreset[]
  onPresetClick: (preset: DesignCapabilityPreset) => void
  kind?: 'image' | 'video'
  referenceLimits?: Record<string, number>
  disabled?: boolean
}

/**
 * Step 2. The only required input is the prompt; everything the schema adds
 * already carries a default, and rarely-used fields are folded away. The
 * project name and semantic role get sensible defaults so a first-time user
 * can go straight from description to preview.
 */
export function BriefForm(props: BriefFormProps) {
  const { t } = useTranslation()

  return (
    <div className='space-y-5'>
      {props.presets.length > 0 ? (
        <div className='space-y-2'>
          <Label className='text-muted-foreground text-xs'>
            {t('Start from a template')}
          </Label>
          <div className='flex flex-wrap gap-1.5'>
            {props.presets.map((preset, index) => {
              const label = presetLabel(preset, index, t)
              return (
                <Button
                  key={String(preset.id ?? index)}
                  type='button'
                  variant='outline'
                  size='sm'
                  className='h-7 px-2.5 text-xs'
                  disabled={props.disabled}
                  onClick={() => props.onPresetClick(preset)}
                >
                  <Sparkles className='mr-1 size-3' />
                  {label}
                </Button>
              )
            })}
          </div>
        </div>
      ) : null}

      <div className='space-y-2'>
        <Label htmlFor='design-brief'>
          {t('What do you want to see?')} *
        </Label>
        <SchemaForm
          schema={
            props.schema ?? {
              type: 'object',
              required: ['prompt'],
              properties: { prompt: { type: 'string' } },
            }
          }
          values={props.parameters}
          onChange={props.onParameterChange}
          disabled={props.disabled}
          kind={props.kind}
          referenceLimits={props.referenceLimits}
          collapseAdvanced
        />
        <p className='text-muted-foreground text-xs'>
          {t(
            'The more specific the description, the closer the result. Include subject, style, and scene.'
          )}
        </p>
      </div>

      <details className='group'>
        <summary className='text-muted-foreground hover:text-foreground cursor-pointer text-sm'>
          {t('Task name and purpose')}
        </summary>
        <div className='mt-4 space-y-4'>
          <div className='space-y-2'>
            <Label htmlFor='design-name'>{t('Task name')}</Label>
            <Input
              id='design-name'
              value={props.name}
              disabled={props.disabled}
              onChange={(event) => props.onNameChange(event.target.value)}
            />
            <p className='text-muted-foreground text-xs'>
              {t('Only for you to tell your tasks apart.')}
            </p>
          </div>

          <div className='space-y-2'>
            <Label htmlFor='design-role'>{t('What is this image for?')}</Label>
            <Input
              id='design-role'
              value={props.role}
              disabled={props.disabled}
              onChange={(event) => props.onRoleChange(event.target.value)}
            />
            <div className='flex flex-wrap gap-1.5 pt-1'>
              {ROLE_PRESETS.map((preset) => (
                <Button
                  key={preset.value}
                  type='button'
                  variant='outline'
                  size='sm'
                  className='h-7 px-2.5 text-xs'
                  disabled={props.disabled}
                  onClick={() => props.onRoleChange(preset.value)}
                >
                  {t(preset.label)}
                </Button>
              ))}
            </div>
            <p className='text-muted-foreground text-xs'>
              {t('Helps group results when you create several.')}
            </p>
          </div>

          <div className='space-y-2'>
            <Label htmlFor='design-brief'>{t('Other requirements')}</Label>
            <Textarea
              id='design-brief'
              rows={3}
              value={props.brief}
              disabled={props.disabled}
              placeholder={t(
                'Anything to keep in mind, such as text that must appear exactly.'
              )}
              onChange={(event) => props.onBriefChange(event.target.value)}
            />
            <p className='text-muted-foreground text-xs'>
              {t('Kept with the task for your own reference.')}
            </p>
          </div>
        </div>
      </details>
    </div>
  )
}

/**
 * Step 3. The old page hid this behind a "Plan & cost sheet" button and then a
 * dialog. It is now an always-visible panel: what you get, what it costs, and
 * the actions that move the task forward.
 *
 * Two distinct actions on purpose: confirming the cost sheet is not the same
 * consent as spending it, and keeping them apart means a failed run can be
 * retried without re-confirming an already-confirmed project.
 */
export function ConfirmPanel(props: {
  outputs: string
  model: string
  specs: string
  inputMode: string
  referenceUsage?: string
  estimateText: string
  confirmText: string
  /** True once the cost sheet has been accepted; flips the primary action. */
  confirmed: boolean
  onConfirm: () => void
  onRun: () => void
  onAdjust: () => void
  confirming: boolean
  generating?: boolean
  running?: boolean
  canGenerate: boolean
  missingHint?: string
}) {
  const { t } = useTranslation()

  const rows: { label: string; value: string }[] = [
    { label: t('You will get'), value: props.outputs },
    { label: t('Model'), value: props.model },
    { label: t('Specifications'), value: props.specs },
    { label: t('Based on'), value: props.inputMode },
  ]
  if (props.referenceUsage) {
    rows.push({ label: t('Reference images'), value: props.referenceUsage })
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className='text-base'>{t('Review and generate')}</CardTitle>
        <CardDescription>
          {props.confirmed
            ? t('Confirmed. Start generation when you are ready.')
            : t('Check the details below, then start generation.')}
        </CardDescription>
      </CardHeader>
      <CardContent className='space-y-4'>
        <dl className='space-y-2 text-sm'>
          {rows.map((row) => (
            <div key={row.label} className='flex justify-between gap-4'>
              <dt className='text-muted-foreground shrink-0'>{row.label}</dt>
              <dd className='text-right'>{row.value}</dd>
            </div>
          ))}
          <div className='flex justify-between gap-4 border-t pt-2'>
            <dt className='font-medium'>{t('Estimated cost')}</dt>
            <dd className='text-right font-medium'>{props.estimateText}</dd>
          </div>
        </dl>

        <p className='text-muted-foreground text-xs'>{props.confirmText}</p>

        {props.missingHint ? (
          <p className='text-muted-foreground text-xs'>{props.missingHint}</p>
        ) : null}

        <div className='flex flex-wrap gap-2'>
          {props.confirmed ? (
            <Button
              onClick={props.onRun}
              disabled={props.running || props.generating || !props.canGenerate}
            >
              {props.running || props.generating ? t('Starting…') : t('Start generation')}
            </Button>
          ) : (
            <Button
              onClick={props.onConfirm}
              disabled={props.confirming || !props.canGenerate}
            >
              {props.confirming ? t('Confirming…') : t('Confirm and continue')}
            </Button>
          )}
          <Button
            variant='outline'
            onClick={props.onAdjust}
            disabled={props.confirming || props.running}
          >
            {t('Adjust requirements')}
          </Button>
        </div>
      </CardContent>
    </Card>
  )
}
