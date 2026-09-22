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
import { cleanup, renderHook } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { ROLE } from '@/lib/roles'
import { useAuthStore } from '@/stores/auth-store'

import { useSidebarData } from '../use-sidebar-data'

beforeEach(() => {
  vi.stubGlobal('localStorage', {
    getItem: () => null,
    setItem: () => undefined,
    removeItem: () => undefined,
  })
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  useAuthStore.getState().auth.reset()
})

function sidebarFor(role?: number, modules?: object) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  client.setQueryData(['status'], {
    HeaderNavModules: modules ? JSON.stringify(modules) : '',
  })
  if (role !== undefined) {
    useAuthStore.getState().auth.setUser({ id: 1, username: 'alice', role })
  }
  function Wrapper(props: { children: ReactNode }) {
    return (
      <QueryClientProvider client={client}>
        {props.children}
      </QueryClientProvider>
    )
  }
  const { result } = renderHook(() => useSidebarData(), { wrapper: Wrapper })
  return {
    groups: result.current.navGroups,
    titles: result.current.navGroups
      .flatMap((group) => group.items)
      .map((item) => item.title),
    groupIds: result.current.navGroups.map((group) => group.id),
  }
}

describe('console sidebar visibility by role', () => {
  it('hides audit and task logs from a regular user but keeps usage logs', () => {
    const { titles } = sidebarFor(ROLE.USER)

    expect(titles).not.toContain('Audit Logs')
    expect(titles).not.toContain('Task Logs')
    expect(titles).toContain('Usage Logs')
  })

  it('hides the admin group from a regular user', () => {
    const { groupIds } = sidebarFor(ROLE.USER)

    expect(groupIds).not.toContain('admin')
  })

  it('keeps audit and task logs for an administrator', () => {
    const { titles } = sidebarFor(ROLE.ADMIN)

    expect(titles).toContain('Audit Logs')
    expect(titles).toContain('Task Logs')
  })

  it('shows the model square entry to every role', () => {
    expect(sidebarFor(ROLE.USER).titles).toContain('Model Square')
    expect(sidebarFor(ROLE.ADMIN).titles).toContain('Model Square')
  })

  it('treats a visitor with no role as a regular user', () => {
    const { titles } = sidebarFor()

    expect(titles).not.toContain('Audit Logs')
    expect(titles).not.toContain('Task Logs')
  })
})

describe('console sidebar visibility by site switch', () => {
  function docsChildren(role: number, modules?: object) {
    const docs = sidebarFor(role, modules)
      .groups.flatMap((group) => group.items)
      .find((item) => item.title === 'Docs')
    return docs?.items?.map((item) => item.url)
  }

  it('lists every documentation page under the Docs entry', () => {
    expect(docsChildren(ROLE.USER)).toEqual([
      '/docs/quick-start',
      '/docs/clients',
      '/docs/pricing',
      '/docs/faq',
    ])
  })

  it('drops the Docs entry when the docs module is switched off', () => {
    expect(sidebarFor(ROLE.USER, { docs: false }).titles).not.toContain('Docs')
  })

  it('drops the model square when the pricing module is switched off', () => {
    const { titles } = sidebarFor(ROLE.USER, {
      pricing: { enabled: false, requireAuth: false },
    })

    expect(titles).not.toContain('Model Square')
    expect(titles).toContain('Docs')
  })
})
