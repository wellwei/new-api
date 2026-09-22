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
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it } from 'vitest'

import { STATUS_QUERY_KEY } from '@/lib/status-query'

import { DocsTab } from '../components/docs-tab'
import { DEFAULT_WIKI_PAGE_ID, WIKI_PAGES } from '../wiki'

function renderDocsTab(docsLink = '') {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  queryClient.setQueryData(STATUS_QUERY_KEY, { docs_link: docsLink })

  return render(
    <QueryClientProvider client={queryClient}>
      <DocsTab />
    </QueryClientProvider>
  )
}

afterEach(cleanup)

describe('documentation is rendered in-site', () => {
  it('renders the default wiki page', () => {
    renderDocsTab()

    const defaultPage = WIKI_PAGES.find(
      (page) => page.id === DEFAULT_WIKI_PAGE_ID
    )
    if (!defaultPage) throw new Error('default wiki page is missing')

    expect(screen.getByRole('button', { current: 'page' })).toHaveTextContent(
      defaultPage.title
    )
  })

  it('lists every bundled page in the navigation', () => {
    renderDocsTab()

    for (const page of WIKI_PAGES) {
      expect(
        screen.getByRole('button', { name: new RegExp(page.title) })
      ).toBeInTheDocument()
    }
  })

  it('switches the rendered document when another page is selected', async () => {
    const user = userEvent.setup()
    renderDocsTab()

    const target = WIKI_PAGES.find((page) => page.id !== DEFAULT_WIKI_PAGE_ID)
    if (!target) throw new Error('wiki needs more than one page to switch')

    await user.click(
      screen.getByRole('button', { name: new RegExp(target.title) })
    )

    expect(screen.getByRole('button', { current: 'page' })).toHaveTextContent(
      target.title
    )
  })

  it('never embeds an external site', () => {
    renderDocsTab('https://docs.example.com/')

    // The console ships its own manual, so the reader is never sent off-site
    // and no embed should be reintroduced here.
    expect(document.querySelector('iframe')).toBeNull()
  })

  it('never links out to another documentation site', () => {
    renderDocsTab('https://docs.example.com/')

    // The manual is in-site by decision: a configured `docs_link` must not
    // turn this tab back into a signpost to an external site.
    expect(screen.queryByRole('link')).toBeNull()
    expect(
      screen.queryByRole('button', { name: /Open Documentation/ })
    ).toBeNull()
  })

  it('renders markdown structure rather than raw text', () => {
    renderDocsTab()

    // The default page is markdown, so its first heading must arrive as a
    // heading element — raw markdown left in the DOM would mean the renderer
    // or the bundled content silently broke.
    expect(screen.getAllByRole('heading').length).toBeGreaterThan(0)
  })
})
