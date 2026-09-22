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
import type { ApiInfoItem, PingStatus } from '@/features/dashboard/types'

/**
 * Get color class for latency status
 */
export function getLatencyColorClass(latency: number): string {
  if (latency < 200) {
    return 'text-green-600 dark:text-green-400'
  }
  if (latency < 500) {
    return 'text-yellow-600 dark:text-yellow-400'
  }
  return 'text-red-600 dark:text-red-400'
}

/**
 * Result of probing one endpoint of this gateway.
 *
 * `status` is what the gateway itself answered, which is the useful part: the
 * relay routes answer 401 to an unauthenticated probe precisely when they
 * exist, so "401" is a healthy answer here and a 404 is the broken one.
 */
export interface EndpointProbe extends PingStatus {
  status: number | null
}

/**
 * Probe one gateway endpoint and time the round trip.
 *
 * A real request is issued against the configured address, so the number is
 * the reader's own path to this gateway rather than a third-party estimate.
 * It is an unauthenticated `POST` on purpose, in both directions:
 *
 * - These routes authenticate before doing anything else, so an unauthenticated
 *   call answers 401 exactly when the path exists. 401 is a healthy answer here
 *   and 404 is the broken one — which is why the status code, not the body, is
 *   what gets judged.
 * - `POST` is the method they are registered under. A `HEAD` probe 404s on
 *   every one of them (no HEAD route exists), so it reports a working gateway
 *   as broken — measured, not assumed.
 */
export async function probeEndpoint(url: string): Promise<EndpointProbe> {
  const startTime = performance.now()
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
      cache: 'no-store',
      credentials: 'omit',
    })
    const latency = Math.round(performance.now() - startTime)
    return { latency, testing: false, error: false, status: response.status }
  } catch {
    return { latency: null, testing: false, error: true, status: null }
  }
}

/**
 * Whether a probe's status code means "this route is served here".
 *
 * Anything but 404 counts: the relay routes authenticate first, so a 401 is the
 * expected answer to this unauthenticated probe. 405 and 5xx mean the path is
 * known but misbehaving, which is not something to present as a missing route.
 */
export function isRouteServed(status: number | null): boolean {
  if (status === null) return false
  return status !== 404
}

/**
 * Open external speed test link
 */
export function openExternalSpeedTest(url: string): void {
  const encodedUrl = encodeURIComponent(url)
  const speedTestUrl = `https://www.tcptest.cn/http/${encodedUrl}`
  window.open(speedTestUrl, '_blank', 'noopener,noreferrer')
}

/**
 * Get default ping status
 */
export function getDefaultPingStatus(): PingStatus {
  return {
    latency: null,
    testing: false,
    error: false,
  }
}

/**
 * Endpoints this gateway always serves, for when the operator has not filled
 * in the "API addresses" setting.
 *
 * These are facts about the deployment rather than configuration: the three
 * relay protocols are registered by the router, so listing them is honest even
 * with an empty option — and far more useful than the empty panel this used to
 * be. The operator's own list still wins when it exists, because only they
 * know about mirrors and alternate hostnames.
 */
export function defaultApiInfoItems(baseUrl: string): ApiInfoItem[] {
  const origin = baseUrl.replace(/\/+$/, '')
  return [
    {
      url: `${origin}/v1/chat/completions`,
      route: '/v1/chat/completions',
      description: 'OpenAI 兼容对话接口（Chatbox、Cherry Studio 等）',
      color: 'green',
    },
    {
      url: `${origin}/v1/responses`,
      route: '/v1/responses',
      description: 'OpenAI Responses 接口（Codex 等）',
      color: 'blue',
    },
    {
      url: `${origin}/v1/messages`,
      route: '/v1/messages',
      description: 'Anthropic Messages 接口（Claude Code、Anthropic SDK）',
      color: 'orange',
    },
  ]
}

/**
 * Resolve the endpoint list to display.
 *
 * The operator's configured list wins when it exists (they know about mirrors
 * and extra hostnames). With none configured the panel still lists the three
 * relay routes this deployment always serves, so the reader gets an address to
 * paste into a client instead of an empty state.
 */
export function resolveApiInfoItems(
  configured: ApiInfoItem[],
  baseUrl: string
): { items: ApiInfoItem[]; fromConfig: boolean } {
  if (configured.length > 0) return { items: configured, fromConfig: true }
  return { items: defaultApiInfoItems(baseUrl), fromConfig: false }
}

/**
 * Resolve the address this console talks to.
 *
 * `server_address` is the operator's canonical public address when they set
 * one; otherwise the browser's own origin is the address that just worked.
 */
export function resolveGatewayBaseUrl(serverAddress: unknown): string {
  const configured =
    typeof serverAddress === 'string' ? serverAddress.trim() : ''
  return (configured || window.location.origin).replace(/\/+$/, '')
}
