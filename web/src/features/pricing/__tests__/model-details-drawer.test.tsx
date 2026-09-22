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
  createRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import { api } from '@/lib/api'

import { Pricing } from '../index'

// The drawer embeds charts, and vchart does not resolve under vitest (its ESM
// entry imports extensionless paths). Stub the chart layer: this test is about
// whether the drawer mounts at all, not about what it draws.
vi.mock('@visactor/react-vchart', () => ({ VChart: () => null }))
vi.mock('@visactor/vchart', () => ({
  ThemeManager: { setCurrentTheme: vi.fn() },
}))

const MODELS = [
  {
    model_name: 'example-model',
    vendor_id: 1,
    quota_type: 0,
    model_ratio: 1,
    completion_ratio: 3,
    enable_groups: ['default'],
    supported_endpoint_types: ['openai'],
  },
]

let client: QueryClient

beforeEach(() => {
  client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  vi.spyOn(api, 'get').mockImplementation(async (url: string) => {
    if (url === '/api/pricing') {
      return {
        data: {
          success: true,
          data: MODELS,
          vendors: [{ id: 1, name: 'Example' }],
          group_ratio: { default: 1 },
          usable_group: { default: { desc: 'Default', ratio: 1 } },
          supported_endpoint: {
            openai: { path: '/v1/chat/completions', method: 'post' },
          },
          auto_groups: ['default'],
        },
      } as never
    }
    return { data: { success: true, data: {} } } as never
  })
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

/**
 * Render the model square on a route whose id matches the file-based one.
 *
 * The trailing slash matters: the page looks itself up as
 * `/_authenticated/pricing/`, which is the id an `index.tsx` route gets.
 */
async function renderPricing(entry = '/pricing') {
  const root = createRootRoute()
  const auth = createRoute({ getParentRoute: () => root, id: '_authenticated' })
  const pricing = createRoute({
    getParentRoute: () => auth,
    path: '/pricing/',
    component: Pricing,
    validateSearch: (search: Record<string, unknown>) => search,
  })
  const router = createRouter({
    routeTree: root.addChildren([auth.addChildren([pricing])]),
    history: createMemoryHistory({ initialEntries: [entry] }),
  })
  render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  )
  // The catalogue is what proves the page itself rendered; a drawer open from
  // the URL adds a second `example-model` heading, so wait on the card grid.
  await screen.findAllByText('Example')
  return router
}

/**
 * The model square shows a model's details in a drawer. The drawer is a
 * portal, so the only way it can fail to appear is by never being mounted —
 * which is exactly what happened while it sat outside
 * `SectionPageLayout.Content`: the layout renders its four named slots only
 * and dropped everything else without a word.
 */
it('opens the model details when a card is clicked', async () => {
  const user = userEvent.setup()
  const router = await renderPricing()

  const details = await screen.findAllByRole('button', { name: 'Details' })
  await user.click(details[0])

  expect(await screen.findByRole('dialog')).toBeVisible()
  await waitFor(() =>
    expect(router.state.location.search).toMatchObject({
      model: 'example-model',
    })
  )
})

it('opens the drawer for a model named in the URL', async () => {
  await renderPricing('/pricing?model=example-model')

  expect(await screen.findByRole('dialog')).toBeVisible()
})
