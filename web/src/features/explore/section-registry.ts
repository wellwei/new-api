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
import { createSectionRegistry } from '@/features/system-settings/utils/section-registry'

/**
 * Explore section definitions.
 *
 * Explore is the console's single discovery page: the model square and the
 * announcement/documentation surfaces that used to be standalone public pages
 * are tabs here, so the whole product lives behind one navigation entry.
 */
const EXPLORE_SECTIONS = [
  {
    id: 'models',
    titleKey: 'Model Square',
    build: () => null,
  },
  {
    id: 'announcements',
    titleKey: 'Announcements',
    build: () => null,
  },
  {
    id: 'docs',
    titleKey: 'Docs',
    build: () => null,
  },
] as const

export type ExploreSectionId = (typeof EXPLORE_SECTIONS)[number]['id']

const exploreRegistry = createSectionRegistry<
  ExploreSectionId,
  Record<string, never>,
  []
>({
  sections: EXPLORE_SECTIONS,
  defaultSection: 'models',
  basePath: '/explore',
  urlStyle: 'path',
})

export const EXPLORE_SECTION_IDS = exploreRegistry.sectionIds
export const EXPLORE_DEFAULT_SECTION = exploreRegistry.defaultSection

/** Type guard for validating section IDs without casting. */
export function isExploreSectionId(s: string): s is ExploreSectionId {
  return (EXPLORE_SECTION_IDS as readonly string[]).includes(s)
}
