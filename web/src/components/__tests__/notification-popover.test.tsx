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
import { cleanup, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeAll, expect, it, vi } from 'vitest'

import { NotificationPopover } from '../notification-popover'

// jsdom has no Web Animations API; Base UI's scroll area calls it when the
// popover animates out, which would surface as an unhandled exception here.
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

function renderPopover(
  activeTab: 'notice' | 'announcements' = 'announcements'
) {
  const onOpenChange = vi.fn()
  render(
    <NotificationPopover
      open
      onOpenChange={onOpenChange}
      unreadCount={2}
      activeTab={activeTab}
      onTabChange={() => undefined}
      notice=''
      announcements={ANNOUNCEMENTS}
      loading={false}
    />
  )
  return { onOpenChange }
}

it('lists announcements without opening a detail dialog', () => {
  renderPopover()

  // The popover itself carries role="dialog" in Base UI, so the detail dialog
  // is identified by its own title instead.
  expect(screen.queryByText('Announcement Details')).toBeNull()
  expect(
    screen.getByRole('button', { name: /夜间维护窗口/ })
  ).toBeInTheDocument()
})

it('opens the full announcement in a dialog when one is clicked', async () => {
  const user = userEvent.setup()
  renderPopover()

  await user.click(screen.getByRole('button', { name: /夜间维护窗口/ }))

  const dialog = await screen.findByRole('dialog', {
    name: 'Announcement Details',
  })
  expect(within(dialog).getByText(/夜间维护窗口/)).toBeVisible()
  expect(within(dialog).getByText(/维护期间请求会返回 503/)).toBeVisible()
})

it('closes the popover behind the dialog so dismissing it does not fall back into the list', async () => {
  const user = userEvent.setup()
  const { onOpenChange } = renderPopover()

  await user.click(screen.getByRole('button', { name: /claude-sonnet 已上线/ }))

  expect(onOpenChange).toHaveBeenCalledWith(false)
  expect(
    await screen.findByRole('dialog', { name: 'Announcement Details' })
  ).toBeVisible()
})
