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
import { Pricing } from '@/features/pricing'
import { pricingSearchSchema } from '@/features/pricing/search'
import { getModuleAccessForGuard } from '@/lib/nav-modules'

export const Route = createFileRoute('/_authenticated/pricing/')({
  validateSearch: pricingSearchSchema,
  beforeLoad: async ({ context }) => {
    // The backend serves /api/pricing under HeaderNavModuleAuth("pricing"), so
    // a disabled model square answers 403 — send the visitor to the console
    // overview instead of rendering a page that cannot load.
    const access = await getModuleAccessForGuard(context.queryClient, 'pricing')
    if (!access.enabled) {
      throw redirect({
        to: '/dashboard/$section',
        params: { section: DASHBOARD_DEFAULT_SECTION },
        replace: true,
      })
    }
  },
  component: Pricing,
})
