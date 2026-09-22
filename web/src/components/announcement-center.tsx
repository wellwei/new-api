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
import type { TFunction } from 'i18next'
import { Bell, ChevronLeft, ChevronRight, Megaphone } from 'lucide-react'
import { useCallback, useState } from 'react'
import { useTranslation } from 'react-i18next'

import type { AnnouncementItem } from '@/components/announcement-detail-dialog'
import { Dialog } from '@/components/dialog'
import { RichContent } from '@/components/rich-content'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '@/components/ui/empty'
import { ScrollArea } from '@/components/ui/scroll-area'
import { getAnnouncementColorClass } from '@/lib/colors'
import { formatDateTimeObject } from '@/lib/time'
import { cn } from '@/lib/utils'

export interface AnnouncementCenterProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  unreadCount: number
  /** Site-wide notice (rich text). Shown above the list when configured. */
  notice: string
  announcements: AnnouncementItem[]
  loading: boolean
  className?: string
}

/**
 * Get relative time string from a date
 */
function getRelativeTime(publishDate: string | Date, t: TFunction): string {
  if (!publishDate) return ''

  const now = new Date()
  const pubDate = new Date(publishDate)

  // If invalid date, return original string
  if (Number.isNaN(pubDate.getTime())) {
    return typeof publishDate === 'string' ? publishDate : ''
  }

  const diffMs = now.getTime() - pubDate.getTime()
  const diffSeconds = Math.floor(diffMs / 1000)
  const diffMinutes = Math.floor(diffSeconds / 60)
  const diffHours = Math.floor(diffMinutes / 60)
  const diffDays = Math.floor(diffHours / 24)
  const diffWeeks = Math.floor(diffDays / 7)
  const diffMonths = Math.floor(diffDays / 30)
  const diffYears = Math.floor(diffDays / 365)

  // If future time, show specific date
  if (diffMs < 0) return formatDateTimeObject(pubDate)

  // Return relative time based on difference
  if (diffSeconds < 60) return t('Just now')
  if (diffMinutes < 60) {
    return diffMinutes === 1
      ? t('1 minute ago')
      : t('{{count}} minutes ago', { count: diffMinutes })
  }
  if (diffHours < 24) {
    return diffHours === 1
      ? t('1 hour ago')
      : t('{{count}} hours ago', { count: diffHours })
  }
  if (diffDays < 7) {
    return diffDays === 1
      ? t('1 day ago')
      : t('{{count}} days ago', { count: diffDays })
  }
  if (diffWeeks < 4) {
    return diffWeeks === 1
      ? t('1 week ago')
      : t('{{count}} weeks ago', { count: diffWeeks })
  }
  if (diffMonths < 12) {
    return diffMonths === 1
      ? t('1 month ago')
      : t('{{count}} months ago', { count: diffMonths })
  }
  if (diffYears < 2) return t('1 year ago')

  // Over 2 years, show specific date
  return formatDateTimeObject(pubDate)
}

/**
 * Announcement status dot indicator
 */
function AnnouncementDot({ type }: { type?: string }) {
  return (
    <span
      className={cn(
        'mt-1.5 inline-block size-2 shrink-0 rounded-full',
        getAnnouncementColorClass(type)
      )}
    />
  )
}

function getAnnouncementRenderKey(announcement: AnnouncementItem): string {
  if (announcement.id !== undefined && announcement.id !== null) {
    return `id:${announcement.id}`
  }

  return JSON.stringify({
    content: announcement.content ?? '',
    extra: announcement.extra ?? '',
    publishDate: announcement.publishDate ?? '',
    type: announcement.type ?? '',
  })
}

/** Published time as "relative • absolute", or nothing when undated. */
function AnnouncementTime({
  publishDate,
  t,
}: {
  publishDate: string | Date
  t: TFunction
}) {
  const date = new Date(publishDate)
  if (Number.isNaN(date.getTime())) {
    return typeof publishDate === 'string' ? <span>{publishDate}</span> : null
  }

  const relative = getRelativeTime(date, t)
  return (
    <span>
      {relative ? `${relative} • ` : null}
      {formatDateTimeObject(date)}
    </span>
  )
}

function EmptyState({
  icon,
  title,
  description,
}: {
  icon: React.ReactNode
  title: string
  description?: string
}) {
  return (
    <Empty className='min-h-48 border-0 p-4'>
      <EmptyHeader>
        <EmptyMedia variant='icon'>{icon}</EmptyMedia>
        <EmptyTitle>{title}</EmptyTitle>
        {description ? (
          <EmptyDescription>{description}</EmptyDescription>
        ) : null}
      </EmptyHeader>
    </Empty>
  )
}

/**
 * The full announcement, opened from a list row inside the same dialog.
 *
 * A second dialog would stack modals, so the detail takes the place of the
 * list and offers a way back to it.
 */
function AnnouncementDetailView({
  announcement,
  onBack,
  t,
}: {
  announcement: AnnouncementItem
  onBack: () => void
  t: TFunction
}) {
  return (
    <div className='space-y-4'>
      <Button
        variant='ghost'
        size='sm'
        className='text-muted-foreground hover:text-foreground -ms-2 h-7'
        onClick={onBack}
      >
        <ChevronLeft data-icon='inline-start' />
        {t('Back')}
      </Button>

      <div className='flex items-start gap-3'>
        <AnnouncementDot type={announcement.type} />
        <div className='flex min-w-0 flex-1 flex-col gap-3'>
          {announcement.publishDate ? (
            <p className='text-muted-foreground text-xs'>
              <AnnouncementTime
                publishDate={announcement.publishDate}
                t={t}
              />
            </p>
          ) : null}

          <RichContent breaks content={announcement.content || ''} />

          {announcement.extra ? (
            <div className='border-border/60 border-t pt-3'>
              <h4 className='mb-1.5 text-xs font-medium'>
                {t('Additional Information')}
              </h4>
              <RichContent
                breaks
                content={announcement.extra}
                className='text-muted-foreground text-xs'
              />
            </div>
          ) : null}
        </div>
      </div>
    </div>
  )
}

/**
 * The announcement list.
 *
 * Every row is a button: the list is a preview (the message is clamped), so
 * selecting a row opens the full text.
 */
function AnnouncementList({
  notice,
  announcements,
  loading,
  onSelect,
  t,
}: {
  notice: string
  announcements: AnnouncementItem[]
  loading: boolean
  onSelect: (announcement: AnnouncementItem) => void
  t: TFunction
}) {
  if (loading) {
    return (
      <EmptyState
        icon={<Megaphone />}
        title={t('Loading...')}
        description={t('Latest platform updates and notices')}
      />
    )
  }

  return (
    <div className='flex flex-col gap-4'>
      {notice ? (
        <div className='bg-muted/50 rounded-lg border p-3'>
          <div className='text-muted-foreground mb-1.5 flex items-center gap-1.5 text-xs font-medium'>
            <Bell className='size-3.5' />
            {t('Notice')}
          </div>
          <ScrollArea className='max-h-40 pr-2'>
            <RichContent breaks content={notice} />
          </ScrollArea>
        </div>
      ) : null}

      {announcements.length === 0 ? (
        <EmptyState
          icon={<Megaphone />}
          title={t('No announcements at this time')}
        />
      ) : (
        <ScrollArea className='max-h-[min(60vh,30rem)] pr-3'>
          <ul className='flex flex-col'>
            {announcements.map((item, idx) => (
              <li
                key={getAnnouncementRenderKey(item)}
                className={cn(
                  idx < announcements.length - 1 && 'border-border/60 border-b'
                )}
              >
                <button
                  type='button'
                  onClick={() => onSelect(item)}
                  className='hover:bg-muted/50 focus-visible:ring-ring group -mx-1 w-[calc(100%+0.5rem)] rounded-lg px-1 py-3 text-left transition-colors outline-none focus-visible:ring-2'
                >
                  <div className='flex items-start gap-3'>
                    <AnnouncementDot type={item.type} />
                    <div className='flex min-w-0 flex-1 flex-col gap-2'>
                      <div className='line-clamp-3 text-sm'>
                        <RichContent breaks content={item.content || ''} />
                      </div>

                      {item.extra ? (
                        <div className='text-muted-foreground line-clamp-2 text-xs'>
                          <RichContent breaks content={item.extra} />
                        </div>
                      ) : null}

                      <div className='text-muted-foreground flex items-center gap-1 text-xs'>
                        {item.publishDate ? (
                          <AnnouncementTime publishDate={item.publishDate} t={t} />
                        ) : null}
                        <span className='ms-auto flex items-center gap-1 opacity-60 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100 sm:opacity-0'>
                          {t('Click for details')}
                          <ChevronRight className='size-3.5' />
                        </span>
                      </div>
                    </div>
                  </div>
                </button>
              </li>
            ))}
          </ul>
        </ScrollArea>
      )}
    </div>
  )
}

/**
 * Site announcements: a labelled header button that opens the announcement
 * list in a dialog.
 *
 * This is deliberately not a notification bell with tabs — the site publishes
 * one kind of message (公告), and a first click should show it rather than ask
 * which kind the reader meant. The system notice, when the operator has
 * configured one, rides above the list in the same dialog.
 */
export function AnnouncementCenter({
  open,
  onOpenChange,
  unreadCount,
  notice,
  announcements,
  loading,
  className,
}: AnnouncementCenterProps) {
  const { t } = useTranslation()
  const [selected, setSelected] = useState<AnnouncementItem | null>(null)

  // Closing resets the drill-down, so reopening always starts at the list.
  const handleOpenChange = useCallback(
    (next: boolean) => {
      if (!next) setSelected(null)
      onOpenChange(next)
    },
    [onOpenChange]
  )

  return (
    <>
      <Button
        variant='ghost'
        size='sm'
        className={cn('relative h-9 shrink-0 gap-1.5 px-2', className)}
        aria-label={t('Announcements')}
        onClick={() => onOpenChange(true)}
      >
        <Megaphone className='size-[1.2rem]' />
        <span className='hidden sm:inline'>{t('Announcements')}</span>
        {unreadCount > 0 ? (
          <Badge
            variant='destructive'
            aria-hidden='true'
            className='h-5 min-w-5 px-1 text-[10px] font-semibold tabular-nums'
          >
            {unreadCount > 99 ? '99+' : unreadCount}
          </Badge>
        ) : null}
      </Button>

      <Dialog
        open={open}
        onOpenChange={handleOpenChange}
        title={selected ? t('Announcement Details') : t('Announcements')}
        description={
          selected ? undefined : t('Latest platform updates and notices')
        }
        contentClassName='sm:max-w-xl'
        contentHeight='auto'
        bodyClassName='space-y-4'
        footer={
          selected ? undefined : (
            <Button size='sm' onClick={() => handleOpenChange(false)}>
              {t('Close')}
            </Button>
          )
        }
      >
        {selected ? (
          <AnnouncementDetailView
            announcement={selected}
            onBack={() => setSelected(null)}
            t={t}
          />
        ) : (
          <AnnouncementList
            notice={notice}
            announcements={announcements}
            loading={loading}
            onSelect={setSelected}
            t={t}
          />
        )}
      </Dialog>
    </>
  )
}
