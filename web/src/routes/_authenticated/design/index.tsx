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
import { createFileRoute } from '@tanstack/react-router'
import z from 'zod'

import { Design } from '@/features/design'

/**
 * Deep links hand one specific quote to the person who has to approve it, e.g.
 * `/design?project=42&rev=3`. `rev` is the plan revision the link was minted
 * for: re-planning bumps it server side, so a link that outlived its quote can
 * be reported as stale rather than silently showing a different price than the
 * one the reader was sent to approve.
 */
const designSearchSchema = z.object({
  project: z.number().int().positive().optional().catch(undefined),
  rev: z.number().int().nonnegative().optional().catch(undefined),
})

/**
 * Owns the URL so the feature component stays router-free and directly
 * renderable in tests. Selecting a project writes it back, which is what makes
 * a deep link survive a refresh instead of jumping to the newest task.
 */
function DesignRoute() {
  const search = Route.useSearch()
  const navigate = Route.useNavigate()

  return (
    <Design
      initialProjectId={search.project}
      initialPlanRevision={search.rev}
      onProjectSelect={(projectId) =>
        navigate({
          search: { project: projectId, rev: undefined },
          replace: true,
        })
      }
    />
  )
}

export const Route = createFileRoute('/_authenticated/design/')({
  validateSearch: designSearchSchema,
  component: DesignRoute,
})
