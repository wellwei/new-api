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
import { describe, expect, it } from 'vitest'

import { resolveVisibleExploreSections } from '../lib/visible-sections'

const enabled = {
  announcements_enabled: true,
} as const

describe('explore tab visibility', () => {
  it('shows every tab when nothing is switched off', () => {
    expect(resolveVisibleExploreSections({ ...enabled })).toEqual([
      'models',
      'announcements',
      'docs',
    ])
  })

  it('drops the model square when the pricing module is disabled', () => {
    const status = {
      ...enabled,
      HeaderNavModules: JSON.stringify({ pricing: { enabled: false } }),
    }

    expect(resolveVisibleExploreSections(status)).toEqual([
      'announcements',
      'docs',
    ])
  })

  it('drops announcements when announcements are disabled', () => {
    const status = { ...enabled, announcements_enabled: false }

    expect(resolveVisibleExploreSections(status)).toEqual(['models', 'docs'])
  })

  it('drops docs when the docs module is disabled', () => {
    const status = {
      ...enabled,
      HeaderNavModules: JSON.stringify({ docs: false }),
    }

    expect(resolveVisibleExploreSections(status)).toEqual([
      'models',
      'announcements',
    ])
  })

  it('returns nothing when every tab is switched off', () => {
    const status = {
      announcements_enabled: false,
      HeaderNavModules: JSON.stringify({
        pricing: { enabled: false },
        docs: false,
      }),
    }

    expect(resolveVisibleExploreSections(status)).toEqual([])
  })

  it('keeps every tab while the status payload has not arrived', () => {
    expect(resolveVisibleExploreSections(null)).toEqual([
      'models',
      'announcements',
      'docs',
    ])
  })
})
