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
import { Download, RefreshCw } from 'lucide-react'
import { useTranslation } from 'react-i18next'

import { CopyButton } from '@/components/copy-button'
import { EmptyState } from '@/components/empty-state'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { Progress } from '@/components/ui/progress'

import { cn } from '@/lib/utils'

import { FAILURE_TEXT, STEP_STATUS_TEXT } from '../terminology'
import type { DesignAsset, DesignStepWithAssets } from '../types'

function isImageAsset(asset: DesignAsset): boolean {
  return asset.mime_type.startsWith('image/') || asset.mime_type === ''
}

/** Maps a step status to the badge tone that communicates it at a glance. */
function statusVariant(status: string): 'default' | 'destructive' | 'secondary' {
  if (status === 'succeeded') return 'default'
  if (status === 'failed') return 'destructive'
  return 'secondary'
}

function AssetItem(props: { asset: DesignAsset; index: number }) {
  const { t } = useTranslation()
  return (
    <div className='group relative overflow-hidden rounded-md border'>
      {isImageAsset(props.asset) ? (
        <img
          src={props.asset.url ?? ''}
          alt={`result-${props.index + 1}`}
          className='w-full'
          loading='lazy'
        />
      ) : (
        <video
          src={props.asset.url ?? ''}
          controls
          className='w-full'
          preload='metadata'
        />
      )}
      <a
        href={props.asset.url ?? ''}
        download
        className='bg-background/80 absolute right-2 top-2 rounded-md p-1.5 opacity-0 transition group-hover:opacity-100'
        title={t('Download')}
      >
        <Download className='size-4' />
      </a>
    </div>
  )
}

/**
 * Step 4. Groups finished assets by their purpose so several results stay
 * distinguishable, and surfaces each item as soon as it persists rather than
 * waiting for the whole batch.
 */
export function AssetBoard(props: {
  steps: DesignStepWithAssets[]
  generating: boolean
  /** Sends the user back to step 2 to revise and generate a different take. */
  onAdjust?: () => void
  /** Clears the prompt so the next run is a fresh variant, not the same one. */
  onRegenerate?: () => void
}) {
  const { t } = useTranslation()

  const grouped = props.steps.reduce<Map<string, DesignAsset[]>>((acc, step) => {
    const assets = step.assets ?? []
    if (assets.length === 0) return acc
    acc.set(step.role, [...(acc.get(step.role) ?? []), ...assets])
    return acc
  }, new Map())

  if (grouped.size === 0) {
    return (
      <EmptyState
        icon={Download}
        bordered
        title={
          props.generating ? t('Generating…') : t('No results yet')
        }
        description={
          props.generating
            ? t('Results appear here one by one as each one finishes.')
            : t('Once generation starts, finished results show up here to preview and download.')
        }
      />
    )
  }

  return (
    <div className='space-y-4'>
      {[...grouped.entries()].map(([role, assets]) => (
        <Card key={role}>
          <CardHeader>
            <CardTitle className='text-base'>{role}</CardTitle>
            <CardDescription>
              {t('{count} item(s)', { count: assets.length })}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className='grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3'>
              {assets.map((asset, index) => (
                <AssetItem key={asset.id} asset={asset} index={index} />
              ))}
            </div>
          </CardContent>
        </Card>
      ))}

      {/*
        Phase 1 has no accept/anchor endpoint in /api/design/*, so there is
        nothing honest to offer for "use this one as the base for the next".
        Saying so beats a row of buttons that would do nothing — and beats a
        silent dead end that reads as a bug.
      */}
      {props.onAdjust || props.onRegenerate ? (
        <Card>
          <CardHeader>
            <CardTitle className='text-base'>{t('What next?')}</CardTitle>
            <CardDescription>
              {t(
                'Download the result you like, or change the description to generate another version.'
              )}
            </CardDescription>
          </CardHeader>
          <CardContent className='space-y-3'>
            <div className='flex flex-wrap gap-2'>
              {props.onAdjust ? (
                <Button variant='outline' onClick={props.onAdjust}>
                  {t('Change description')}
                </Button>
              ) : null}
              {props.onRegenerate ? (
                <Button onClick={props.onRegenerate}>
                  {t('Generate another version')}
                </Button>
              ) : null}
            </div>
            <p className='text-muted-foreground text-xs'>
              {t(
                'Keeping several results visually consistent with an anchor image is not available in this version yet.'
              )}
            </p>
          </CardContent>
        </Card>
      ) : null}
    </div>
  )
}

/**
 * Run status list. The backend `task_id` is demoted to a copy button instead of
 * being printed as the primary identifier, and each failure shows what to do
 * next rather than a taxonomy term.
 */
export function RunStatus(props: {
  steps: DesignStepWithAssets[]
  onRetry: (stepId: number) => void
  retrying: boolean
  specSummary: (step: DesignStepWithAssets) => string
}) {
  const { t } = useTranslation()

  if (props.steps.length === 0) {
    return (
      <EmptyState
        bordered
        title={t('Nothing running')}
        description={t('Generation steps will appear here once you start.')}
      />
    )
  }

  const done = props.steps.filter((step) => step.status === 'succeeded').length
  const failed = props.steps.filter((step) => step.status === 'failed').length
  const percent =
    props.steps.length > 0
      ? Math.round((done / props.steps.length) * 100)
      : 0

  return (
    <div className='space-y-3'>
      <div className='space-y-2'>
        <div className='text-muted-foreground flex items-center justify-between text-sm'>
          <span>
            {t('{done} of {total} done', { done, total: props.steps.length })}
          </span>
          {failed > 0 ? (
            <span className='text-destructive'>
              {t('{count} failed', { count: failed })}
            </span>
          ) : null}
        </div>
        <Progress value={percent} />
      </div>

      {props.steps.map((step) => {
        const failure = step.failure_class
          ? FAILURE_TEXT[step.failure_class]
          : undefined
        return (
          <Card key={step.id}>
            <CardContent className='space-y-2 pt-4'>
              <div className='flex items-center justify-between gap-2'>
                <div className='flex min-w-0 items-center gap-2'>
                  <Badge variant={statusVariant(step.status)}>
                    {t(STEP_STATUS_TEXT[step.status] ?? step.status)}
                  </Badge>
                  <span className='truncate text-sm font-medium'>{step.role}</span>
                </div>
                {step.status === 'failed' && step.task_id === '' ? (
                  <Button
                    variant='outline'
                    size='sm'
                    disabled={props.retrying}
                    onClick={() => props.onRetry(step.id)}
                  >
                    <RefreshCw className='mr-1 size-3.5' />
                    {t('Retry')}
                  </Button>
                ) : null}
              </div>

              <div className='text-muted-foreground space-y-1 text-xs'>
                <div className={cn('truncate')}>{props.specSummary(step)}</div>
                {failure ? (
                  <div className='text-destructive space-y-0.5'>
                    <div>{t(failure.reason)}</div>
                    <div>{t(failure.action)}</div>
                  </div>
                ) : null}
                {step.task_id ? (
                  <div className='flex items-center gap-1'>
                    <span className='text-muted-foreground'>
                      {t('Task ID')}:
                    </span>
                    <span className='font-mono'>{step.task_id}</span>
                    <CopyButton value={step.task_id} />
                  </div>
                ) : null}
              </div>
            </CardContent>
          </Card>
        )
      })}
    </div>
  )
}
