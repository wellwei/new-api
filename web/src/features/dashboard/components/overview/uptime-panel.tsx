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
import { useQuery } from '@tanstack/react-query'
import { Activity, RotateCw } from 'lucide-react'
import { memo, useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { Button } from '@/components/ui/button'
import { IconBadge } from '@/components/ui/icon-badge'
import { ScrollArea } from '@/components/ui/scroll-area'
import { getUptimeStatus } from '@/features/dashboard/api'
import type {
  UptimeGroupResult,
  UptimeMonitor,
} from '@/features/dashboard/types'
import { getPerfMetricsSummary } from '@/features/performance-metrics/api'
import {
  formatLatency,
  formatUptimePct,
  getSuccessRateLevel,
} from '@/features/performance-metrics/lib/format'
import { requireServerSuccess } from '@/lib/server-error-message'
import { cn } from '@/lib/utils'

import { PanelWrapper } from '../ui/panel-wrapper'

const AVAILABILITY_WINDOW_HOURS = 24

const STATUS_COLOR_MAP: Record<number, string> = {
  1: 'bg-emerald-500',
  0: 'bg-red-500',
  2: 'bg-amber-500',
  3: 'bg-blue-500',
}
const DEFAULT_STATUS_COLOR = 'bg-muted-foreground/40'

const SUCCESS_RATE_DOT_CLASS: Record<string, string> = {
  excellent: 'bg-emerald-500',
  good: 'bg-emerald-400',
  warning: 'bg-amber-500',
  critical: 'bg-red-500',
  unknown: 'bg-muted-foreground/40',
}

const StatusDot = memo(function StatusDot(props: { status: number }) {
  const color = STATUS_COLOR_MAP[props.status] ?? DEFAULT_STATUS_COLOR
  return <span className={cn('inline-block size-2 rounded-full', color)} />
})

function SuccessDot(props: { rate: number }) {
  const level = getSuccessRateLevel(props.rate)
  return (
    <span
      className={cn(
        'inline-block size-2 rounded-full',
        SUCCESS_RATE_DOT_CLASS[level]
      )}
    />
  )
}

function Row(props: { children: React.ReactNode }) {
  return (
    <div className='hover:bg-muted/40 border-border/40 flex items-center justify-between gap-2 border-b px-3 py-2 transition-colors last:border-b-0 sm:px-5 sm:py-2.5'>
      {props.children}
    </div>
  )
}

/**
 * Availability of the gateway over the last 24 hours, measured from its own
 * request metrics.
 *
 * Used when no Uptime Kuma monitor is configured (the usual case here). It is
 * a different question from an external monitor — this reports what callers
 * actually experienced, and nothing at all when no requests were served — so
 * the panel says which one it is showing rather than implying a synthetic
 * uptime number.
 */
function GatewayAvailability() {
  const { t } = useTranslation()
  const metricsQuery = useQuery({
    queryKey: ['perf-metrics-summary', AVAILABILITY_WINDOW_HOURS],
    queryFn: async () =>
      requireServerSuccess(
        await getPerfMetricsSummary(AVAILABILITY_WINDOW_HOURS)
      ),
    staleTime: 60 * 1000,
    retry: false,
  })

  const models = metricsQuery.data?.data.models ?? []
  const summary = metricsQuery.data?.data.summary
  const hasRequests = summary !== undefined && summary !== null

  if (metricsQuery.isLoading) {
    return (
      <p className='text-muted-foreground px-3 py-6 text-center text-sm sm:px-5'>
        {t('Loading...')}
      </p>
    )
  }

  if (!hasRequests) {
    return (
      <p className='text-muted-foreground px-3 py-6 text-center text-sm sm:px-5'>
        {t(
          'No requests have been served in the last 24 hours, so there is nothing to measure yet.'
        )}
      </p>
    )
  }

  return (
    <>
      <div className='bg-muted/30 border-border/60 border-b px-3 py-3 sm:px-5'>
        <div className='flex flex-wrap items-baseline gap-x-6 gap-y-2'>
          <div className='flex flex-col gap-0.5'>
            <span className='text-muted-foreground text-xs'>
              {t('Requests succeeded')}
            </span>
            <span className='font-mono text-lg font-semibold tabular-nums'>
              {formatUptimePct(summary.success_rate)}
            </span>
          </div>
          <div className='flex flex-col gap-0.5'>
            <span className='text-muted-foreground text-xs'>
              {t('Average latency')}
            </span>
            <span className='font-mono text-lg font-semibold tabular-nums'>
              {formatLatency(summary.avg_latency_ms)}
            </span>
          </div>
        </div>
        <p className='text-muted-foreground/70 mt-2 text-xs'>
          {t(
            'Measured from the requests this gateway served in the last 24 hours.'
          )}
        </p>
      </div>

      {models.map((model) => (
        <Row key={model.model_name}>
          <div className='flex min-w-0 items-center gap-2.5'>
            <SuccessDot rate={model.success_rate} />
            <span className='truncate font-mono text-sm'>
              {model.model_name}
            </span>
          </div>
          <div className='flex shrink-0 items-center gap-3 font-mono text-xs tabular-nums'>
            <span className='text-muted-foreground'>
              {formatLatency(model.avg_latency_ms)}
            </span>
            <span className='font-semibold'>
              {formatUptimePct(model.success_rate)}
            </span>
          </div>
        </Row>
      ))}
    </>
  )
}

export function UptimePanel() {
  const { t } = useTranslation()
  const [groups, setGroups] = useState<UptimeGroupResult[]>([])
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)

  const loadGroups = useCallback(async (signal?: AbortSignal) => {
    try {
      const res = await getUptimeStatus()
      if (signal?.aborted) return
      setGroups(res?.data || [])
    } catch {
      if (signal?.aborted) return
      setGroups([])
    }
  }, [])

  useEffect(() => {
    const abortController = new AbortController()

    void loadGroups(abortController.signal).finally(() => {
      if (!abortController.signal.aborted) setLoading(false)
    })

    return () => {
      abortController.abort()
    }
  }, [loadGroups])

  const handleRefresh = () => {
    setRefreshing(true)
    void loadGroups().finally(() => setRefreshing(false))
  }

  const hasMonitors = groups.length > 0

  return (
    <PanelWrapper
      title={
        <span className='flex items-center gap-2'>
          <IconBadge tone='success' size='sm'>
            <Activity />
          </IconBadge>
          {hasMonitors ? t('Uptime') : t('Availability')}
        </span>
      }
      description={
        hasMonitors
          ? t('Monitor groups from Uptime Kuma')
          : t('What callers experienced over the last 24 hours')
      }
      loading={loading}
      height='h-80'
      contentClassName='p-0'
      headerActions={
        <Button
          variant='ghost'
          size='sm'
          onClick={handleRefresh}
          disabled={refreshing}
          className='size-7 p-0'
        >
          <RotateCw
            className={cn('size-3.5', refreshing && 'animate-spin')}
            aria-label={t('Refresh')}
          />
        </Button>
      }
    >
      <ScrollArea className='h-80'>
        {hasMonitors ? (
          <div>
            {groups.map((group, groupIdx) => (
              <div key={group.categoryName}>
                <div className='bg-muted/30 border-border/60 border-b px-3 py-2 sm:px-5'>
                  <div className='flex items-center gap-2'>
                    <h4 className='text-muted-foreground text-xs font-semibold tracking-wider uppercase'>
                      {group.categoryName}
                    </h4>
                    <span className='text-muted-foreground/40 font-mono text-xs tabular-nums'>
                      {group.monitors?.length || 0}
                    </span>
                  </div>
                </div>

                {group.monitors?.map(
                  (monitor: UptimeMonitor, monitorIdx: number) => (
                    <div
                      key={monitor.name}
                      className={cn(
                        'hover:bg-muted/40 flex items-center justify-between gap-2 px-3 py-2 transition-colors sm:px-5 sm:py-2.5',
                        monitorIdx < (group.monitors?.length || 0) - 1 &&
                          'border-border/40 border-b',
                        groupIdx < groups.length - 1 &&
                          monitorIdx === (group.monitors?.length || 0) - 1 &&
                          'border-border/60 border-b'
                      )}
                    >
                      <div className='flex min-w-0 items-center gap-2.5'>
                        <StatusDot status={monitor.status} />
                        <span className='truncate text-sm'>{monitor.name}</span>
                        {monitor.group && (
                          <span className='text-muted-foreground/40 shrink-0 text-xs'>
                            ({monitor.group})
                          </span>
                        )}
                      </div>
                      <span className='text-foreground shrink-0 font-mono text-sm font-semibold tabular-nums'>
                        {((monitor.uptime ?? 0) * 100).toFixed(2)}%
                      </span>
                    </div>
                  )
                )}
              </div>
            ))}
          </div>
        ) : (
          <GatewayAvailability />
        )}
      </ScrollArea>
    </PanelWrapper>
  )
}
