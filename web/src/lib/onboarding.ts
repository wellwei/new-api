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
/**
 * Whether the onboarding wizard has been dealt with for a user.
 *
 * A freshly registered account lands in the console with nothing to point it
 * at, so the sign-in landing sends accounts that have never sent a request to
 * `/onboarding`. That decision has to stop nagging once the reader has either
 * finished the wizard or deliberately skipped it — hence a marker in
 * `localStorage`, not a server field: it is a UI preference, and losing it
 * (another browser, cleared site data) only means the wizard is offered once
 * more. It is keyed per user so a shared browser does not leak one person's
 * decision onto the next.
 */
const ONBOARDING_MARKER_PREFIX = 'onboarding:v1:'

function markerKey(userId?: number | null): string | null {
  if (userId === undefined || userId === null) return null
  return `${ONBOARDING_MARKER_PREFIX}${userId}`
}

export function isOnboardingDone(userId?: number | null): boolean {
  const key = markerKey(userId)
  if (!key) return false
  try {
    return window.localStorage.getItem(key) !== null
  } catch {
    // Private-mode storage failures mean "unknown"; treat it as not done so
    // the wizard is offered rather than silently skipped.
    return false
  }
}

export function markOnboardingDone(userId?: number | null): void {
  const key = markerKey(userId)
  if (!key) return
  try {
    window.localStorage.setItem(key, String(Date.now()))
  } catch {
    // Nothing to do: the marker is an optimization, not state the app needs.
  }
}
