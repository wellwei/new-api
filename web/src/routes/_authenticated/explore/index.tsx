import { createFileRoute, redirect } from '@tanstack/react-router'

import { EXPLORE_DEFAULT_SECTION } from '@/features/explore/section-registry'

export const Route = createFileRoute('/_authenticated/explore/')({
  beforeLoad: () => {
    throw redirect({
      to: '/explore/$section',
      params: { section: EXPLORE_DEFAULT_SECTION },
    })
  },
})
