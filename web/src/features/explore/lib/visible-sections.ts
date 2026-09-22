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
import { parseHeaderNavModulesFromStatus } from '@/lib/nav-modules'

import { EXPLORE_SECTION_IDS, type ExploreSectionId } from '../section-registry'

/**
 * Explore tabs the current site configuration allows.
 *
 * Each tab mirrors the switch that already governs its data source, so an
 * admin-turned-off surface disappears instead of rendering a shell whose
 * requests the backend would reject: the model square follows the pricing
 * module (`/api/pricing` is served under `HeaderNavModuleAuth("pricing")`),
 * announcements follow `announcements_enabled`, and docs follow the docs
 * module flag.
 */
export function resolveVisibleExploreSections(
  status: Record<string, unknown> | null
): ExploreSectionId[] {
  const modules = parseHeaderNavModulesFromStatus(status)

  return EXPLORE_SECTION_IDS.filter((section) => {
    if (section === 'models') return modules.pricing.enabled
    if (section === 'announcements') {
      return status?.announcements_enabled !== false
    }
    return modules.docs !== false
  })
}
