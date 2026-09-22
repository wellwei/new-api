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
import { getRouteApi, useNavigate } from '@tanstack/react-router'
import { Compass } from 'lucide-react'
import { useCallback } from 'react'
import { useTranslation } from 'react-i18next'

import { EmptyState } from '@/components/empty-state'
import { SectionPageLayout } from '@/components/layout'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { AnnouncementsPanel } from '@/features/dashboard/components/overview/announcements-panel'
import { PricingPanel } from '@/features/pricing'
import { useStatus } from '@/hooks/use-status'

import { DocsTab } from './components/docs-tab'
import { resolveVisibleExploreSections } from './lib/visible-sections'
import {
  type ExploreSectionId,
  EXPLORE_DEFAULT_SECTION,
} from './section-registry'

const route = getRouteApi('/_authenticated/explore/$section')

const SECTION_META: Record<ExploreSectionId, { titleKey: string }> = {
  models: { titleKey: 'Model Square' },
  announcements: { titleKey: 'Announcements' },
  docs: { titleKey: 'Docs' },
}

const ANNOUNCEMENTS_HEIGHT = 'h-[calc(100dvh-19rem)] min-h-80'

/**
 * Console discovery page.
 *
 * Hosts the model square, announcements and documentation as tabs of one
 * navigation entry, and owns the URL state (active tab and the model whose
 * details are open) so each view is directly linkable.
 */
export function Explore() {
  const { t } = useTranslation()
  const navigate = useNavigate({ from: '/explore/$section' })
  const params = route.useParams()
  const search = route.useSearch()
  const { status } = useStatus()

  const visibleSections = resolveVisibleExploreSections(status)

  const requested = params.section as ExploreSectionId
  const activeSection = visibleSections.includes(requested)
    ? requested
    : visibleSections[0]

  const handleSectionChange = useCallback(
    (section: string) => {
      void navigate({
        to: '/explore/$section',
        params: { section: section as ExploreSectionId },
        search: (previous) => previous,
      })
    },
    [navigate]
  )

  const handleModelNameChange = useCallback(
    (modelName: string | null) => {
      void navigate({
        to: '/explore/$section',
        params: { section: 'models' },
        search: (previous) => ({ ...previous, model: modelName ?? undefined }),
        replace: true,
      })
    },
    [navigate]
  )

  const titleKey = activeSection
    ? SECTION_META[activeSection].titleKey
    : SECTION_META[EXPLORE_DEFAULT_SECTION].titleKey

  return (
    <SectionPageLayout fixedContent>
      <SectionPageLayout.Title>{t(titleKey)}</SectionPageLayout.Title>
      <SectionPageLayout.Content>
        <div className='flex h-full min-h-0 flex-col gap-4'>
          <Tabs value={activeSection} onValueChange={handleSectionChange}>
            <TabsList>
              {visibleSections.map((section) => (
                <TabsTrigger key={section} value={section}>
                  {t(SECTION_META[section].titleKey)}
                </TabsTrigger>
              ))}
            </TabsList>
          </Tabs>

          <div className='min-h-0 flex-1'>
            {activeSection === undefined && (
              <EmptyState
                icon={Compass}
                title={t('Nothing to show here yet')}
                description={t(
                  'The model square, announcements and documentation are all disabled by the site administrator.'
                )}
              />
            )}
            {activeSection === 'models' && (
              <PricingPanel
                search={search}
                modelName={search.model ?? null}
                onModelNameChange={handleModelNameChange}
                className='flex h-full min-h-0 flex-col'
              />
            )}
            {activeSection === 'announcements' && (
              <AnnouncementsPanel height={ANNOUNCEMENTS_HEIGHT} />
            )}
            {activeSection === 'docs' && <DocsTab />}
          </div>
        </div>
      </SectionPageLayout.Content>
    </SectionPageLayout>
  )
}
