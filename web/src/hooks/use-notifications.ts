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
import { useState, useMemo } from 'react'

import type { AnnouncementItem } from '@/components/announcement-detail-dialog'
import { useStatus } from '@/hooks/use-status'
import { getNotice } from '@/lib/api'
import { requireServerSuccess } from '@/lib/server-error-message'
import { useNotificationStore } from '@/stores/notification-store'

function hashString(input: string): string {
  let hash = 0
  if (!input) return '0'

  for (let i = 0; i < input.length; i += 1) {
    const chr = input.charCodeAt(i)
    hash = (hash << 5) - hash + chr
    hash |= 0
  }

  return hash.toString(36)
}

/**
 * Generate a unique key for an announcement
 * Prefer backend id, fall back to a content hash so edits register
 */
function getAnnouncementKey(item: AnnouncementItem): string {
  if (!item) return ''

  if (item.id !== undefined && item.id !== null) {
    return `id:${item.id}`
  }

  const fingerprint = JSON.stringify({
    publishDate: (item.publishDate as string) || '',
    content: (item.content as string) || '',
    extra: (item.extra as string) || '',
    type: (item.type as string) || '',
    title: (item.title as string) || '',
  })
  return `hash:${hashString(fingerprint)}`
}

/**
 * Hook to manage the announcement center (site notice + announcements)
 * Provides the dialog state and the unread count for the header button.
 */
export function useNotifications() {
  const [dialogOpen, setDialogOpen] = useState(false)

  // Fetch Notice from API
  const {
    data: noticeResponse,
    isLoading: noticeLoading,
    refetch: refetchNotice,
  } = useQuery({
    queryKey: ['notice'],
    queryFn: async () => requireServerSuccess(await getNotice()),
    staleTime: 1000 * 60 * 5, // 5 minutes
  })

  // Fetch Announcements from status
  const { status, loading: statusLoading } = useStatus()
  const announcementsEnabled = status?.announcements_enabled ?? false
  const announcements = useMemo<AnnouncementItem[]>(() => {
    if (!announcementsEnabled) return []
    // `/api/status` types `announcements` as opaque JSON, so the shape of an
    // entry is asserted here — it is validated by the server before storage.
    const list = (status?.announcements || []) as AnnouncementItem[]
    return list.slice(0, 20)
  }, [announcementsEnabled, status?.announcements])

  // Notification store
  const { lastReadNotice, markNoticeRead, markAnnouncementsRead, isAnnouncementRead } =
    useNotificationStore()

  // Extract notice content
  const noticeContent = noticeResponse?.success
    ? (noticeResponse.data || '').trim()
    : ''

  // Calculate unread counts
  const unreadCount = useMemo(() => {
    const noticeUnread =
      noticeContent && noticeContent !== lastReadNotice ? 1 : 0

    const announcementsUnread = announcements.filter(
      (item) => !isAnnouncementRead(getAnnouncementKey(item))
    ).length

    return noticeUnread + announcementsUnread
  }, [noticeContent, lastReadNotice, announcements, isAnnouncementRead])

  const markAnnouncementsAsRead = () => {
    if (announcements.length > 0) {
      markAnnouncementsRead(announcements.map(getAnnouncementKey))
    }
  }

  // Opening the dialog puts the list on screen, which is what "read" means
  // here; there is no per-tab step left to hang it on.
  const handleDialogOpenChange = (open: boolean) => {
    if (!open) {
      setDialogOpen(false)
      return
    }

    if (noticeContent) {
      markNoticeRead(noticeContent)
    }
    markAnnouncementsAsRead()
    setDialogOpen(true)
  }

  return {
    // Data
    notice: noticeContent,
    announcements,
    loading: noticeLoading || statusLoading,

    // Unread count for the header button badge
    unreadCount,

    // Dialog state
    dialogOpen,
    setDialogOpen: handleDialogOpenChange,

    // Actions
    refetchNotice,
  }
}
