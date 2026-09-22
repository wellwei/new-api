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
import { SectionPageLayout } from '@/components/layout'
import { Markdown } from '@/components/ui/markdown'

import { WIKI_PAGES, type WikiPageId } from './wiki'

export interface DocsPageProps {
  pageId: WikiPageId
}

/**
 * Documentation page.
 *
 * The page list lives in the sidebar (the Docs group lists the bundled
 * markdown files), so the page itself only renders the selected document —
 * the active entry is driven by the URL rather than local state, which keeps
 * every page directly linkable and the sidebar highlight honest.
 */
export function DocsPage(props: DocsPageProps) {
  const page =
    WIKI_PAGES.find((candidate) => candidate.id === props.pageId) ??
    WIKI_PAGES[0]

  return (
    <SectionPageLayout>
      <SectionPageLayout.Title>{page.title}</SectionPageLayout.Title>
      <SectionPageLayout.Content>
        <article className='mx-auto max-w-3xl'>
          <p className='text-muted-foreground mb-4 text-sm'>{page.summary}</p>
          <Markdown className='text-sm leading-relaxed'>
            {page.content}
          </Markdown>
        </article>
      </SectionPageLayout.Content>
    </SectionPageLayout>
  )
}
