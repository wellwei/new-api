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
import { createFileRoute, redirect } from '@tanstack/react-router'

import { DASHBOARD_DEFAULT_SECTION } from '@/features/dashboard/section-registry'
import { DocsPage } from '@/features/docs'
import { DEFAULT_WIKI_PAGE_ID, isWikiPageId } from '@/features/docs/wiki'
import { isToggleModuleEnabledForGuard } from '@/lib/nav-modules'

/**
 * Documentation page: the sidebar lists the bundled markdown files and this
 * route renders the selected one. The `docs` module switch hides the entry, so
 * the guard keeps its URL from being a back door to the switched-off surface.
 */
export const Route = createFileRoute('/_authenticated/docs/$pageId')({
  beforeLoad: async ({ context, params }) => {
    const enabled = await isToggleModuleEnabledForGuard(
      context.queryClient,
      'docs'
    )
    if (!enabled) {
      throw redirect({
        to: '/dashboard/$section',
        params: { section: DASHBOARD_DEFAULT_SECTION },
        replace: true,
      })
    }
    if (!isWikiPageId(params.pageId)) {
      throw redirect({
        to: '/docs/$pageId',
        params: { pageId: DEFAULT_WIKI_PAGE_ID },
        replace: true,
      })
    }
  },
  component: DocsPageRoute,
})

function DocsPageRoute() {
  const { pageId } = Route.useParams()
  // beforeLoad already redirected unknown ids; this keeps the narrowed type.
  if (!isWikiPageId(pageId)) return null
  return <DocsPage pageId={pageId} />
}
