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
import { render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'

import { SectionPageLayout } from '../section-page-layout'

afterEach(() => {
  vi.restoreAllMocks()
})

it('renders the four named slots', () => {
  render(
    <SectionPageLayout>
      <SectionPageLayout.Breadcrumb>crumbs</SectionPageLayout.Breadcrumb>
      <SectionPageLayout.Title>Models</SectionPageLayout.Title>
      <SectionPageLayout.Actions>
        <button type='button'>Refresh</button>
      </SectionPageLayout.Actions>
      <SectionPageLayout.Content>body</SectionPageLayout.Content>
    </SectionPageLayout>
  )

  expect(screen.getByRole('heading', { name: 'Models' })).toBeVisible()
  expect(screen.getByRole('button', { name: 'Refresh' })).toBeVisible()
  expect(screen.getByText('body')).toBeVisible()
  expect(screen.getByText('crumbs')).toBeVisible()
})

it('warns about a child that fills no slot, because it will not render', () => {
  // A bare sibling is the shape that silently swallowed the model-details
  // drawer: the element is accepted by JSX and then dropped by the layout, so
  // without this warning the only symptom is "clicking does nothing".
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)

  function NotASlot() {
    return <div>never rendered</div>
  }

  render(
    <SectionPageLayout>
      <SectionPageLayout.Title>Models</SectionPageLayout.Title>
      <SectionPageLayout.Content>body</SectionPageLayout.Content>
      <NotASlot />
    </SectionPageLayout>
  )

  expect(screen.queryByText('never rendered')).toBeNull()
  expect(warn).toHaveBeenCalledTimes(1)
  expect(warn.mock.calls[0]?.[0]).toContain('<NotASlot>')
  expect(warn.mock.calls[0]?.[0]).toContain('only')
})

it('stays quiet when every child fills a slot', () => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)

  render(
    <SectionPageLayout>
      <SectionPageLayout.Title>Models</SectionPageLayout.Title>
      <SectionPageLayout.Content>body</SectionPageLayout.Content>
    </SectionPageLayout>
  )

  expect(warn).not.toHaveBeenCalled()
})
