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
import { afterEach, describe, expect, it } from 'vitest'

import { DocsPage } from '../index'
import { DEFAULT_WIKI_PAGE_ID, WIKI_PAGES } from '../wiki'

afterEach(cleanup)

describe('documentation is rendered in-site', () => {
  it('renders the requested page title and body', () => {
    const target = WIKI_PAGES.find((page) => page.id !== DEFAULT_WIKI_PAGE_ID)
    if (!target) throw new Error('wiki needs more than one page')

    render(<DocsPage pageId={target.id} />)

    expect(
      screen.getByRole('heading', { level: 2, name: target.title })
    ).toBeVisible()
    expect(screen.getByText(target.summary)).toBeVisible()
  })

  it('renders markdown structure rather than raw text', () => {
    render(<DocsPage pageId={DEFAULT_WIKI_PAGE_ID} />)

    // The pages are markdown, so headings must arrive as heading elements —
    // raw markdown left in the DOM would mean the renderer or the bundled
    // content silently broke.
    const headings = screen.getAllByRole('heading')
    expect(headings.length).toBeGreaterThan(1)
    expect(
      headings.some((heading) => heading.textContent?.startsWith('#'))
    ).toBe(false)
  })

  it('never links out to an external documentation site', () => {
    render(<DocsPage pageId={DEFAULT_WIKI_PAGE_ID} />)

    // The manual is in-site by decision: no signpost, no embed.
    expect(document.querySelector('iframe')).toBeNull()
    expect(document.querySelector('a[href^="http"]')).toBeNull()
  })
})
