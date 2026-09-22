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
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { markOnboardingDone } from '@/lib/onboarding'

// The hook reads `window.location.origin` while resolving a redirect, so the
// jsdom origin is the baseline every expectation is written against.
const ORIGIN = window.location.origin

async function loadResolve() {
  const module = await import('../use-auth-redirect')
  return module.resolvePostLoginPath
}

let store: Map<string, string>

beforeEach(() => {
  store = new Map()
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
    removeItem: (key: string) => void store.delete(key),
    clear: () => store.clear(),
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('post-login landing', () => {
  it('honours an explicit redirect for any account', async () => {
    const resolvePostLoginPath = await loadResolve()

    expect(resolvePostLoginPath({ id: 7 }, '/usage-logs')).toBe('/usage-logs')
  })

  it('sends a brand-new account to onboarding', async () => {
    const resolvePostLoginPath = await loadResolve()

    expect(resolvePostLoginPath({ id: 7, request_count: 0 })).toBe('/onboarding')
  })

  it('sends an account that already used the API to the console', async () => {
    const resolvePostLoginPath = await loadResolve()

    expect(resolvePostLoginPath({ id: 7, request_count: 42 })).toBe('/dashboard')
  })

  it('stops offering onboarding once it has been dismissed', async () => {
    const resolvePostLoginPath = await loadResolve()
    markOnboardingDone(7)

    expect(resolvePostLoginPath({ id: 7, request_count: 0 })).toBe('/dashboard')
  })

  it('keeps the marker per user so one account does not silence another', async () => {
    const resolvePostLoginPath = await loadResolve()
    markOnboardingDone(7)

    expect(resolvePostLoginPath({ id: 8, request_count: 0 })).toBe('/onboarding')
  })

  it('ignores a redirect that points off this origin', async () => {
    const resolvePostLoginPath = await loadResolve()

    // Falling back rather than navigating keeps an attacker-supplied
    // `redirect` from turning the login page into an open redirect.
    expect(
      resolvePostLoginPath({ id: 7, request_count: 42 }, 'https://evil.invalid/')
    ).toBe('/dashboard')
    expect(ORIGIN).not.toContain('evil.invalid')
  })
})
