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
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest'

import { resolveApiInfoItems } from '@/features/dashboard/lib/api-info'
import { api } from '@/lib/api'
import { STATUS_QUERY_KEY } from '@/lib/status-query'

import { ApiInfoPanel } from '../api-info-panel'

/**
 * The two overview panels used to render empty states whenever the operator
 * had not filled in a setting, which on this deployment is always. These
 * cases pin the replacements: the gateway's own endpoints, and a probe whose
 * verdict comes from the status the gateway actually answered.
 */

// jsdom has no Web Animations API; Base UI's scroll area calls it when the
// panel unmounts, which would surface as an unhandled exception here.
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
      <ApiInfoPanel />
    </QueryClientProvider>
  )
}

beforeEach(() => {
  client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  client.setQueryData(STATUS_QUERY_KEY, {
    server_address: 'https://gateway.example.com',
  })
  vi.spyOn(api, 'get').mockResolvedValue({
    data: { success: true, data: {} },
  })
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  client.clear()
})

describe('API info panel', () => {
  it('lists the relay endpoints when the operator configured none', async () => {
    renderPanel()

    for (const route of [
      '/v1/chat/completions',
      '/v1/responses',
      '/v1/messages',
    ]) {
      expect(await screen.findByText(route)).toBeVisible()
    }
    expect(screen.getByText(/No addresses have been configured/)).toBeVisible()
  })

  it('times a probe and reads the answer as proof the path is served', async () => {
    // 401 is what the relay routes return to an unauthenticated probe, and it
    // is a healthy answer: the route exists and authenticated the caller first.
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => ({
      status: 401,
      ok: false,
    }))
    vi.stubGlobal('fetch', fetchMock)
    const user = userEvent.setup()
    renderPanel()

    const testButtons = await screen.findAllByRole('button', {
      name: /Test Latency/,
    })
    await user.click(testButtons[0])

    await waitFor(() => expect(screen.getAllByText(/ms$/).length).toBe(1))
    // A HEAD probe 404s on every relay route (no HEAD route is registered), so
    // the probe has to be the POST these routes actually answer.
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ method: 'POST' })
  })

  it('reports a missing route instead of a latency', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ status: 404, ok: false }))
    )
    const user = userEvent.setup()
    renderPanel()

    const testButtons = await screen.findAllByRole('button', {
      name: /Test Latency/,
    })
    await user.click(testButtons[0])

    expect(await screen.findByText('Missing')).toBeVisible()
  })

  it('says the endpoint is unreachable when the probe cannot connect', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('network down')
      })
    )
    const user = userEvent.setup()
    renderPanel()

    const testButtons = await screen.findAllByRole('button', {
      name: /Test Latency/,
    })
    await user.click(testButtons[0])

    expect(await screen.findByText('Unreachable')).toBeVisible()
  })

  it('prefers the operator list when one is configured', () => {
    const configured = [
      {
        url: 'https://mirror.example.com/v1',
        route: '/v1',
        description: 'mirror',
        color: 'blue',
      },
    ]

    const result = resolveApiInfoItems(
      configured,
      'https://gateway.example.com'
    )

    expect(result.fromConfig).toBe(true)
    expect(result.items).toBe(configured)
  })
})
