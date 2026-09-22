import { createFileRoute, redirect } from '@tanstack/react-router'

import { Explore } from '@/features/explore'
import {
  isExploreSectionId,
  EXPLORE_DEFAULT_SECTION,
} from '@/features/explore/section-registry'
import { pricingSearchSchema } from '@/features/pricing/search'

export const Route = createFileRoute('/_authenticated/explore/$section')({
  beforeLoad: ({ params }) => {
    if (!isExploreSectionId(params.section)) {
      throw redirect({
        to: '/explore/$section',
        params: { section: EXPLORE_DEFAULT_SECTION },
      })
    }
  },
  validateSearch: pricingSearchSchema,
  component: Explore,
})
