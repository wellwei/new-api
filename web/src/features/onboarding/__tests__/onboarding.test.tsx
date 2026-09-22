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
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { api } from '@/lib/api'
import { isOnboardingDone } from '@/lib/onboarding'
import { useAuthStore } from '@/stores/auth-store'

import { Onboarding } from '../index'

let client: QueryClient
let createdKeys: { id: number; name: string; key: string; status: number }[]
let createCalls: number
let chatResponse: { ok: boolean; status: number; body: unknown }

function renderOnboarding() {
  const router = createRouter({
    routeTree: createRootRoute({ component: Onboarding }),
    history: createMemoryHistory({ initialEntries: ['/'] }),
  })
  render(
    <QueryClientProvider client={client}>
      {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
      <RouterProvider router={router as any} />
    </QueryClientProvider>
  )
  return router
}

beforeEach(() => {
  window.localStorage.clear()
  createdKeys = []
  createCalls = 0
  chatResponse = { ok: true, status: 200, body: { choices: [] } }

  useAuthStore.getState().auth.setUser({
    id: 7,
    username: 'newcomer',
    role: 1,
  })

  client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })

  vi.spyOn(api, 'get').mockImplementation(async (url: string) => {
    if (url.startsWith('/api/token/')) {
      return {
        data: {
          success: true,
          // A copy, like a real response: handing back the live array would
          // let a later creation mutate an earlier cached list.
          data: { items: [...createdKeys], total: createdKeys.length },
        },
      }
    }
    if (url === '/api/user/models') {
      return { data: { success: true, data: ['glm-5.3'] } }
    }
    if (url === '/api/status') {
      return {
        data: {
          success: true,
          data: { server_address: 'https://gateway.example.com' },
        },
      }
    }
    throw new Error(`Unexpected GET ${url}`)
  })

  vi.spyOn(api, 'post').mockImplementation(async (url: string) => {
    if (url === '/api/token/') {
      createCalls += 1
      createdKeys.push({
        id: 100 + createCalls,
        name: 'My key',
        key: 'masked',
        status: 1,
      })
      // The real endpoint answers with `{success: true}` and nothing else; the
      // wizard has to find the new key in the list, so the mock must not hand
      // it over either.
      return { data: { success: true, message: '' } }
    }
    if (/^\/api\/token\/\d+\/key$/.test(url)) {
      const id = Number(url.split('/')[3])
      return { data: { success: true, data: { key: `plaintext-${id}` } } }
    }
    throw new Error(`Unexpected POST ${url}`)
  })

  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({
      ok: chatResponse.ok,
      status: chatResponse.status,
      json: async () => chatResponse.body,
    }))
  )
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  useAuthStore.getState().auth.reset()
})

describe('first-run onboarding', () => {
  it('creates a key and shows both values the reader has to copy', async () => {
    const user = userEvent.setup()
    renderOnboarding()

    await user.click(
      await screen.findByRole('button', { name: 'Create API Key' })
    )

    // Step two shows the address and the plaintext key together: they are what
    // the reader pastes into a client, so neither may be missing.
    await waitFor(() =>
      expect(screen.getByText('https://gateway.example.com/v1')).toBeVisible()
    )
    expect(screen.getByText('sk-plaintext-101')).toBeVisible()
    expect(createCalls).toBe(1)
  })

  it('proves the setup with a real request and reports success', async () => {
    const user = userEvent.setup()
    renderOnboarding()

    await user.click(
      await screen.findByRole('button', { name: 'Create API Key' })
    )
    await user.click(
      await screen.findByRole('button', { name: /Next: send a test request/ })
    )
    await user.click(
      await screen.findByRole('button', { name: 'Send test request' })
    )

    expect(
      await screen.findByText('It works — the gateway answered')
    ).toBeVisible()
  })

  it('surfaces the gateway message when the test request fails', async () => {
    chatResponse = {
      ok: false,
      status: 401,
      body: { error: { message: '无效的令牌' } },
    }
    const user = userEvent.setup()
    renderOnboarding()

    await user.click(
      await screen.findByRole('button', { name: 'Create API Key' })
    )
    await user.click(
      await screen.findByRole('button', { name: /Next: send a test request/ })
    )
    await user.click(
      await screen.findByRole('button', { name: 'Send test request' })
    )

    expect(
      await screen.findByText('The request did not go through')
    ).toBeVisible()
    // The gateway's own wording is what tells the reader what to fix.
    expect(screen.getByText('无效的令牌')).toBeVisible()
  })

  it('marks the wizard as dealt with when skipped', async () => {
    const user = userEvent.setup()
    renderOnboarding()

    await user.click(
      await screen.findByRole('button', {
        name: 'Skip for now, take me to the console',
      })
    )

    expect(isOnboardingDone(7)).toBe(true)
  })

  it('offers existing keys instead of creating another one', async () => {
    createdKeys.push({ id: 5, name: 'Old key', key: 'masked', status: 1 })
    const user = userEvent.setup()
    renderOnboarding()

    await user.click(
      await screen.findByRole('button', { name: 'Continue with Old key' })
    )

    await waitFor(() =>
      expect(screen.getByText('sk-plaintext-5')).toBeVisible()
    )
    expect(createCalls).toBe(0)
  })
})
