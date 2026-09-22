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
import { cleanup, render, screen } from '@testing-library/react'
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest'

import { api } from '@/lib/api'

import { UptimePanel } from '../uptime-panel'

/**
 * With no Uptime Kuma monitor configured (the case on this deployment) the
 * panel reports what callers actually experienced, measured from the
 * gateway's own request metrics — instead of the empty state it used to show.
 */

beforeAll(() => {
  Object.defineProperty(HTMLElement.prototype, 'getAnimations', {
    configurable: true,
    value: () => [],
  })
})

let client: QueryClient

function renderPanel() {
  return render(
    <QueryClientProvider client={client}>
      <UptimePanel />
    </QueryClientProvider>
  )
}

beforeEach(() => {
  client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  vi.spyOn(api, 'get').mockImplementation(async (url: string) => {
    if (url === '/api/uptime/status') {
      return { data: { success: true, data: [] } }
    }
    if (url === '/api/perf-metrics/summary') {
      return {
        data: {
          success: true,
          data: {
            summary: {
              success_rate: 98.44,
              avg_latency_ms: 10454,
              avg_tps: 163,
            },
            models: [
              {
                model_name: 'deepseek-v4.1-flash',
                success_rate: 100,
                avg_latency_ms: 8712,
                avg_tps: 224,
              },
              {
                model_name: 'glm-5.3-flash',
                success_rate: 94.44,
                avg_latency_ms: 20680,
                avg_tps: 26,
              },
            ],
          },
        },
      }
    }
    throw new Error(`Unexpected GET ${url}`)
  })
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  client.clear()
})

describe('availability panel without an uptime monitor', () => {
  it('reports the measured success rate and latency per model', async () => {
    renderPanel()

    expect(await screen.findByText('98.44%')).toBeVisible()
    expect(screen.getByText('deepseek-v4.1-flash')).toBeVisible()
    expect(screen.getByText('100.00%')).toBeVisible()
    expect(screen.getByText('20.68s')).toBeVisible()
    expect(
      screen.getByText(
        'Measured from the requests this gateway served in the last 24 hours.'
      )
    ).toBeVisible()
  })

  it('says there is nothing to measure when no request was served', async () => {
    client.clear()
    vi.restoreAllMocks()
    vi.spyOn(api, 'get').mockImplementation(async (url: string) => {
      if (url === '/api/uptime/status') {
        return { data: { success: true, data: [] } }
      }
      if (url === '/api/perf-metrics/summary') {
        return {
          data: { success: true, data: { summary: null, models: [] } },
        }
      }
      throw new Error(`Unexpected GET ${url}`)
    })
    renderPanel()

    expect(
      await screen.findByText(
        'No requests have been served in the last 24 hours, so there is nothing to measure yet.'
      )
    ).toBeVisible()
  })
})
