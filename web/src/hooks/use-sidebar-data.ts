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
import {
  Activity,
  BookOpen,
  Box,
  ClipboardList,
  CreditCard,
  FileText,
  Key,
  LayoutDashboard,
  LayoutGrid,
  ListTodo,
  PlugZap,
  Radio,
  ServerCog,
  Settings,
  ShieldCheck,
  Ticket,
  User,
  Users,
  Wallet,
} from 'lucide-react'
import { useTranslation } from 'react-i18next'

import type { NavGroup, NavItem, SidebarData } from '@/components/layout/types'
import { getDocsNavItems } from '@/features/docs/wiki'
import { parseHeaderNavModulesFromStatus } from '@/lib/nav-modules'
import { ROLE } from '@/lib/roles'
import { useAuthStore } from '@/stores/auth-store'

import { useStatus } from './use-status'

/**
 * Narrow navigation groups to what the signed-in role may see.
 *
 * Applied here rather than at each rendering site because every consumer of
 * this data — the sidebar and the command palette — must agree on who sees
 * what; an admin-only entry leaking into search would be just as wrong as one
 * leaking into the sidebar.
 */
export function filterNavGroupsByRole(
  navGroups: NavGroup[],
  role: number
): NavGroup[] {
  const isAdmin = role >= ROLE.ADMIN

  return navGroups
    .filter((group) => (group.id === 'admin' ? isAdmin : true))
    .map((group) => {
      const items = group.items.filter(
        (item) => item.requiredRole === undefined || role >= item.requiredRole
      )
      return items.length === group.items.length ? group : { ...group, items }
    })
}

/**
 * Root navigation groups for the application sidebar.
 *
 * These are shown when the URL does not match any nested sidebar view
 * registered in `layout/lib/sidebar-view-registry.ts`, narrowed to the
 * signed-in role and to the site's `HeaderNavModules` switches: the model
 * square and the docs entry disappear when the administrator turned that
 * surface off, so the sidebar never offers a page whose data the backend
 * refuses to serve.
 */
export function useSidebarData(): SidebarData {
  const { t } = useTranslation()
  const { status } = useStatus()
  const userRole = useAuthStore((s) => s.auth.user?.role) ?? ROLE.GUEST
  const modules = parseHeaderNavModulesFromStatus(
    status as Record<string, unknown> | null
  )

  const generalItems: NavItem[] = [
    {
      title: t('Overview'),
      url: '/dashboard/overview',
      icon: Activity,
    },
    ...(modules.pricing.enabled
      ? [
          {
            title: t('Model Square'),
            url: '/pricing',
            icon: LayoutGrid,
          },
        ]
      : []),
    ...(modules.docs !== false
      ? [
          {
            title: t('Docs'),
            icon: BookOpen,
            items: getDocsNavItems(),
          },
        ]
      : []),
    {
      title: t('Dashboard'),
      url: '/dashboard/models',
      icon: LayoutDashboard,
    },
    {
      title: t('API Keys'),
      url: '/keys',
      icon: Key,
    },
    {
      title: t('Usage Logs'),
      url: '/usage-logs/common',
      icon: FileText,
    },
    {
      title: t('Audit Logs'),
      url: '/usage-logs/audit',
      icon: ClipboardList,
      requiredRole: ROLE.ADMIN,
    },
    {
      title: t('Task Logs'),
      url: '/usage-logs/task',
      activeUrls: ['/usage-logs/drawing'],
      configUrls: ['/usage-logs/drawing', '/usage-logs/task'],
      icon: ListTodo,
      requiredRole: ROLE.ADMIN,
    },
  ]

  const navGroups: NavGroup[] = [
    {
      id: 'general',
      title: t('General'),
      items: generalItems,
    },
    {
      id: 'personal',
      title: t('Personal'),
      items: [
        {
          title: t('Wallet'),
          url: '/wallet',
          icon: Wallet,
        },
        {
          title: t('Profile'),
          url: '/profile',
          icon: User,
        },
        {
          title: t('Security & Access'),
          url: '/security',
          icon: ShieldCheck,
        },
      ],
    },
    {
      id: 'admin',
      title: t('Admin'),
      items: [
        {
          title: t('Channels'),
          url: '/channels',
          icon: Radio,
        },
        {
          title: t('Models'),
          url: '/models/metadata',
          icon: Box,
        },
        {
          title: t('Users'),
          url: '/users',
          icon: Users,
        },
        {
          title: t('Redemption Codes'),
          url: '/redemption-codes',
          icon: Ticket,
        },
        {
          title: t('Subscriptions'),
          url: '/subscriptions',
          icon: CreditCard,
        },
        {
          title: t('System Info'),
          url: '/system-info',
          icon: ServerCog,
          requiredRole: ROLE.SUPER_ADMIN,
        },
        {
          title: t('Task Plugins'),
          url: '/task-plugins',
          icon: PlugZap,
          requiredRole: ROLE.SUPER_ADMIN,
        },
        {
          title: t('System Settings'),
          url: '/system-settings/site',
          activeUrls: ['/system-settings'],
          icon: Settings,
        },
      ],
    },
  ]

  return { navGroups: filterNavGroupsByRole(navGroups, userRole) }
}
