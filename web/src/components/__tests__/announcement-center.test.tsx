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
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeAll, expect, it, vi } from 'vitest'

import {
  AnnouncementCenter,
  type AnnouncementCenterProps,
} from '../announcement-center'

// jsdom has no Web Animations API; Base UI's dialog and scroll area call it
// while animating, which would surface as an unhandled exception here.
beforeAll(() => {
  Object.defineProperty(HTMLElement.prototype, 'getAnimations', {
    configurable: true,
    value: () => [],
  })
})

afterEach(cleanup)

const ANNOUNCEMENTS = [
  {
    id: 1,
    type: 'warning',
    content: '夜间维护窗口：本周六 02:00–04:00 暂停服务',
    extra: '维护期间请求会返回 503。',
    publishDate: '2026-09-20T10:00:00Z',
  },
  {
    id: 2,
    type: 'success',
    content: 'claude-sonnet 已上线',
    publishDate: '2026-09-18T10:00:00Z',
  },
]

function renderCenter(overrides: Partial<AnnouncementCenterProps> = {}) {
  const onOpenChange = vi.fn()
  render(
    <AnnouncementCenter
      open
      onOpenChange={onOpenChange}
      unreadCount={2}
      notice=''
      announcements={ANNOUNCEMENTS}
      loading={false}
      {...overrides}
    />
  )
  return { onOpenChange }
}

it('shows the list as soon as the dialog opens, with no tab to pick first', () => {
  renderCenter()

  expect(
    screen.getByRole('heading', { name: 'Announcements' })
  ).toBeVisible()
  expect(screen.getByText(/夜间维护窗口/)).toBeVisible()
  expect(screen.getByText(/claude-sonnet 已上线/)).toBeVisible()
})

it('labels the header button 公告 and opens the dialog when clicked', async () => {
  const user = userEvent.setup()
  const { onOpenChange } = renderCenter({ open: false })

  await user.click(screen.getByRole('button', { name: 'Announcements' }))

  expect(onOpenChange).toHaveBeenCalledWith(true)
})

it('counts unread announcements on the button', () => {
  renderCenter({ open: false, unreadCount: 3 })

  expect(screen.getByText('3')).toBeVisible()
})

it('opens the full announcement in place when a row is clicked', async () => {
  const user = userEvent.setup()
  renderCenter()

  await user.click(screen.getByRole('button', { name: /夜间维护窗口/ }))

  expect(
    screen.getByRole('heading', { name: 'Announcement Details' })
  ).toBeVisible()
  expect(screen.getByText(/维护期间请求会返回 503/)).toBeVisible()
  // The list is replaced, not stacked behind a modal.
  expect(screen.queryByText(/claude-sonnet 已上线/)).toBeNull()
})

it('returns to the list from the detail view', async () => {
  const user = userEvent.setup()
  renderCenter()

  await user.click(screen.getByRole('button', { name: /claude-sonnet 已上线/ }))
  await user.click(screen.getByRole('button', { name: 'Back' }))

  expect(
    screen.getByRole('heading', { name: 'Announcements' })
  ).toBeVisible()
  expect(screen.getByText(/夜间维护窗口/)).toBeVisible()
})

it('carries the configured system notice above the list', () => {
  renderCenter({ notice: '本站在国庆期间照常服务。' })

  expect(screen.getByText('Notice')).toBeVisible()
  expect(screen.getByText('本站在国庆期间照常服务。')).toBeVisible()
})

it('says there is nothing to read when the operator published none', () => {
  renderCenter({ announcements: [] })

  expect(screen.getByText('No announcements at this time')).toBeVisible()
  expect(screen.queryByText('Notice')).toBeNull()
})
