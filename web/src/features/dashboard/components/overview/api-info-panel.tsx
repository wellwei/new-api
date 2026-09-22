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
import { Route } from 'lucide-react'
import { useCallback, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { IconBadge } from '@/components/ui/icon-badge'
import { ScrollArea } from '@/components/ui/scroll-area'
import { useApiInfo } from '@/features/dashboard/hooks/use-status-data'
import {
  probeEndpoint,
  resolveApiInfoItems,
  resolveGatewayBaseUrl,
} from '@/features/dashboard/lib/api-info'
import type { ApiInfoItem, PingStatusMap } from '@/features/dashboard/types'
import { useStatus } from '@/hooks/use-status'

import { PanelWrapper } from '../ui/panel-wrapper'
import { ApiInfoItemComponent } from './api-info-item'

export function ApiInfoPanel() {
  const { t } = useTranslation()
  const { items: configured, loading } = useApiInfo()
  const { status } = useStatus()
  // Probes are keyed by URL and start absent: nothing is claimed about an
  // endpoint until the reader asks, so an untested row shows no verdict.
  const [pingStatus, setPingStatus] = useState<PingStatusMap>({})

  const baseUrl = resolveGatewayBaseUrl(status?.server_address)
  const { items, fromConfig } = useMemo(
    () => resolveApiInfoItems(configured, baseUrl),
    [baseUrl, configured]
  )

  const handleTest = useCallback(async (url: string) => {
    setPingStatus((previous) => ({
      ...previous,
      [url]: { latency: null, testing: true, error: false, status: null },
    }))

    const result = await probeEndpoint(url)
    setPingStatus((previous) => ({ ...previous, [url]: result }))
  }, [])

  return (
    <PanelWrapper
      title={
        <span className='flex items-center gap-2'>
          <IconBadge tone='info' size='sm'>
            <Route />
          </IconBadge>
          {t('API Info')}
        </span>
      }
      description={
        fromConfig
          ? t('Configured routes and latency checks')
          : t('Endpoints this gateway serves')
      }
      loading={loading}
      height='h-72'
      contentClassName='p-0'
    >
      <ScrollArea className='h-72'>
        {!fromConfig && (
          <p className='text-muted-foreground border-border/60 border-b px-3 py-2 text-xs sm:px-5'>
            {t(
              'No addresses have been configured, so these are the routes this gateway serves at {{base}}.',
              { base: baseUrl }
            )}
          </p>
        )}
        <div>
          {items.map((item: ApiInfoItem, idx: number) => (
            <div
              key={item.url}
              className={
                idx < items.length - 1 ? 'border-border/60 border-b' : ''
              }
            >
              <ApiInfoItemComponent
                item={item}
                status={pingStatus[item.url]}
                onTest={handleTest}
              />
            </div>
          ))}
        </div>
      </ScrollArea>
    </PanelWrapper>
  )
}
