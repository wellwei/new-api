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
import { useState } from 'react'
import { useTranslation } from 'react-i18next'

import { Markdown } from '@/components/ui/markdown'
import { cn } from '@/lib/utils'

import { DEFAULT_WIKI_PAGE_ID, WIKI_PAGES, type WikiPageId } from '../wiki'

/**
 * Documentation reader.
 *
 * Renders the bundled markdown pages in place, with the page list on the left
 * and the active document on the right. Everything is local content, so this
 * works regardless of external connectivity and no reader is sent off-site.
 */
export function WikiReader() {
  const { t } = useTranslation()
  const [activeId, setActiveId] = useState<WikiPageId>(DEFAULT_WIKI_PAGE_ID)
  const activePage =
    WIKI_PAGES.find((page) => page.id === activeId) ?? WIKI_PAGES[0]

  return (
    <div className='grid h-full min-h-0 gap-4 lg:grid-cols-[minmax(0,15rem)_minmax(0,1fr)]'>
      <nav
        aria-label={t('Docs')}
        className='bg-card h-fit rounded-xl border p-2 shadow-xs lg:sticky lg:top-0'
      >
        <ul className='flex flex-wrap gap-1 lg:flex-col lg:flex-nowrap'>
          {WIKI_PAGES.map((page) => {
            const isActive = page.id === activePage.id
            return (
              <li key={page.id} className='min-w-0 flex-1 lg:flex-none'>
                <button
                  type='button'
                  onClick={() => setActiveId(page.id)}
                  aria-current={isActive ? 'page' : undefined}
                  className={cn(
                    'hover:bg-muted/60 w-full rounded-lg px-3 py-2 text-left transition-colors',
                    isActive && 'bg-muted'
                  )}
                >
                  <span
                    className={cn(
                      'block truncate text-sm',
                      isActive ? 'font-medium' : 'text-muted-foreground'
                    )}
                  >
                    {page.title}
                  </span>
                  <span className='text-muted-foreground/60 mt-0.5 hidden text-xs lg:block'>
                    {page.summary}
                  </span>
                </button>
              </li>
            )
          })}
        </ul>
      </nav>

      <article className='bg-card hover-scrollbar min-h-0 overflow-y-auto rounded-xl border px-4 py-5 shadow-xs sm:px-6 sm:py-6'>
        <Markdown className='max-w-3xl text-sm leading-relaxed'>
          {activePage.content}
        </Markdown>
      </article>
    </div>
  )
}
