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

import { pricingSearchSchema } from '@/features/pricing/search'

/**
 * Per-model addresses from when the model square was a public page: the
 * details drawer is addressed by the `model` search parameter now, so forward
 * old links there instead of 404ing them.
 */
export const Route = createFileRoute('/_authenticated/pricing/$modelId/')({
  validateSearch: pricingSearchSchema,
  beforeLoad: ({ params, search }) => {
    throw redirect({
      to: '/pricing',
      search: { ...search, model: params.modelId },
      replace: true,
    })
  },
})
