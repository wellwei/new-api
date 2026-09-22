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
import { cleanup, renderHook } from '@testing-library/react'
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

function sidebarTitles(role?: number) {
  if (role !== undefined) {
    useAuthStore.getState().auth.setUser({ id: 1, username: 'alice', role })
  }
  const { result } = renderHook(() => useSidebarData())
  return {
    titles: result.current.navGroups
      .flatMap((group) => group.items)
      .map((item) => item.title),
    groupIds: result.current.navGroups.map((group) => group.id),
  }
}

describe('console sidebar visibility by role', () => {
  it('hides audit and task logs from a regular user but keeps usage logs', () => {
    const { titles } = sidebarTitles(ROLE.USER)

    expect(titles).not.toContain('Audit Logs')
    expect(titles).not.toContain('Task Logs')
    expect(titles).toContain('Usage Logs')
  })

  it('hides the admin group from a regular user', () => {
    const { groupIds } = sidebarTitles(ROLE.USER)

    expect(groupIds).not.toContain('admin')
  })

  it('keeps audit and task logs for an administrator', () => {
    const { titles } = sidebarTitles(ROLE.ADMIN)

    expect(titles).toContain('Audit Logs')
    expect(titles).toContain('Task Logs')
  })

  it('shows the model square entry to every role', () => {
    expect(sidebarTitles(ROLE.USER).titles).toContain('Explore')
    expect(sidebarTitles(ROLE.ADMIN).titles).toContain('Explore')
  })

  it('treats a visitor with no role as a regular user', () => {
    const { titles } = sidebarTitles()

    expect(titles).not.toContain('Audit Logs')
    expect(titles).not.toContain('Task Logs')
  })
})
