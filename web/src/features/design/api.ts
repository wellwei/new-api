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
import { api } from '@/lib/api'
import { requireServerSuccess } from '@/lib/server-error-message'

import type {
  DesignCapability,
  DesignParameterSchema,
  DesignProject,
  DesignProjectInput,
  DesignProjectListResponse,
  DesignProjectView,
} from './types'

// ============================================================================
// AI Design Workbench (Phase 1) — /api/design/*
// ============================================================================

export async function getDesignCapabilities(): Promise<DesignCapability[]> {
  const res = await api.get('/api/design/capabilities')
  const data = requireServerSuccess(res.data)?.data
  return Array.isArray(data) ? data : []
}

export async function getDesignCapabilitySchema(
  capabilityId: string
): Promise<DesignParameterSchema> {
  const res = await api.get(
    `/api/design/capabilities/${encodeURIComponent(capabilityId)}/schema`
  )
  return requireServerSuccess(res.data)?.data ?? {}
}

export async function listDesignProjects(params: {
  p?: number
  size?: number
} = {}): Promise<DesignProjectListResponse> {
  const { p = 1, size = 50 } = params
  const res = await api.get(`/api/design/projects?p=${p}&size=${size}`)
  const data = requireServerSuccess(res.data)?.data
  return {
    items: Array.isArray(data?.items) ? data.items : [],
    total: typeof data?.total === 'number' ? data.total : 0,
    page: typeof data?.page === 'number' ? data.page : p,
    size: typeof data?.size === 'number' ? data.size : size,
  }
}

export async function getDesignProject(
  id: number
): Promise<DesignProjectView> {
  const res = await api.get(`/api/design/projects/${id}`)
  return requireServerSuccess(res.data).data
}

export async function createDesignProject(
  input: DesignProjectInput
): Promise<DesignProject> {
  const res = await api.post('/api/design/projects', input)
  return requireServerSuccess(res.data).data
}

export async function updateDesignProject(
  id: number,
  input: Partial<DesignProjectInput>
): Promise<DesignProject> {
  const res = await api.patch(`/api/design/projects/${id}`, input)
  return requireServerSuccess(res.data).data
}

export async function deleteDesignProject(id: number): Promise<void> {
  const res = await api.delete(`/api/design/projects/${id}`)
  requireServerSuccess(res.data)
}

export async function planDesignProject(
  id: number
): Promise<DesignProjectView> {
  const res = await api.post(`/api/design/projects/${id}/plan`, {})
  return requireServerSuccess(res.data).data
}

export async function confirmDesignProject(
  id: number
): Promise<DesignProjectView> {
  const res = await api.post(`/api/design/projects/${id}/confirm`, {})
  return requireServerSuccess(res.data).data
}

export async function runDesignProject(
  id: number
): Promise<{ project: DesignProjectView; submitError: string }> {
  const res = await api.post(`/api/design/projects/${id}/run`, {})
  const payload = requireServerSuccess<{
    data: DesignProjectView
    message?: string
  }>(res.data)
  // A submission failure inside a run is reported in the message field while
  // the refreshed project view still comes back, so the UI can show both.
  return {
    project: payload.data,
    submitError: payload.message ?? '',
  }
}

export async function retryDesignStep(
  projectId: number,
  stepId: number
): Promise<DesignProjectView> {
  const res = await api.post(
    `/api/design/projects/${projectId}/steps/${stepId}/retry`,
    {}
  )
  return requireServerSuccess(res.data).data
}
