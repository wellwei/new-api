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
import { cleanup, renderHook, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { api } from '@/lib/api'
import { useNotificationStore } from '@/stores/notification-store'

import { useNotifications } from '../use-notifications'

// jsdom's localStorage shim persists across tests in one file, so the store is
// reset per test instead of relying on a fresh storage.
beforeEach(() => {
  useNotificationStore.setState({
    lastReadNotice: '',
    readAnnouncementKeys: [],
    closedUntilDate: null,
  })
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

function notificationsWith(options: {
  notice?: string
  announcements?: { id: number; content: string }[]
}) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  client.setQueryData(['status'], {
    announcements_enabled: true,
    announcements: options.announcements ?? [],
  })
  vi.spyOn(api, 'get').mockResolvedValue({
    data: { success: true, data: options.notice ?? '' },
  } as never)

  function Wrapper(props: { children: ReactNode }) {
    return (
      <QueryClientProvider client={client}>
        {props.children}
      </QueryClientProvider>
    )
  }
  return renderHook(() => useNotifications(), { wrapper: Wrapper })
}

describe('announcement center unread count', () => {
  it('adds the unread notice to the unread announcements', async () => {
    const { result } = notificationsWith({
      notice: '国庆期间照常服务。',
      announcements: [
        { id: 1, content: '维护窗口' },
        { id: 2, content: '新模型上线' },
      ],
    })

    await waitFor(() => expect(result.current.unreadCount).toBe(3))
  })

  it('counts a configured notice that the reader has not seen yet', async () => {
    const { result } = notificationsWith({ notice: '国庆期间照常服务。' })

    await waitFor(() => expect(result.current.unreadCount).toBe(1))
  })

  it('drops to zero once the dialog has been opened', async () => {
    const { result } = notificationsWith({
      notice: '国庆期间照常服务。',
      announcements: [{ id: 1, content: '维护窗口' }],
    })
    await waitFor(() => expect(result.current.unreadCount).toBe(2))

    result.current.setDialogOpen(true)

    await waitFor(() => expect(result.current.unreadCount).toBe(0))
  })
})
