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

// Types for the AI design workbench (Phase 1). These mirror the backend
// contract exposed by /api/design/* (controller/design.go and
// service/design_capability.go).

export type DesignCapabilityPrice = {
  model_price: number
  group_ratio: number
  quota_per_call: number
}

export type DesignCapability = {
  id: string
  plugin_key: string
  plugin_name: string
  model: string
  media_type: 'image' | 'video'
  operations: string[]
  defer_schema: boolean
  parameter_schema?: DesignParameterSchema
  reference_limits?: Record<string, number>
  presets?: Record<string, unknown>[]
  delivery?: Record<string, unknown>
  price?: DesignCapabilityPrice
  available: boolean
  unavailable_reason?: string
}

/**
 * The constrained JSON Schema subset the backend accepts, plus pass-through
 * annotations. `x-hidden` hides a field from the form; `constraints` narrows
 * the candidate values of a string field.
 */
export type DesignParameterSchema = {
  type?: string
  required?: string[]
  properties?: Record<string, DesignParameterProperty>
  additionalProperties?: boolean
  'x-hidden'?: boolean
  [key: string]: unknown
}

export type DesignParameterProperty = {
  type?: string
  title?: string
  description?: string
  enum?: unknown[]
  default?: unknown
  minimum?: number
  maximum?: number
  minLength?: number
  maxLength?: number
  items?: DesignParameterProperty
  'x-hidden'?: boolean
  constraints?: string[]
  [key: string]: unknown
}

export type DesignProject = {
  id: number
  user_id: number
  name: string
  kind: 'image' | 'video'
  status:
    | 'draft'
    | 'awaiting_confirmation'
    | 'ready'
    | 'generating'
    | 'review'
    | 'completed'
    | 'partial'
  plan_revision: number
  brief: string
  role: string
  default_capability: string
  token_id: number
  parameters: string
  anchor_asset_id?: number | null
  anchor_prompt?: string
  anchor_invariants?: string
  created_at: number
  updated_at: number
}

export type DesignAsset = {
  id: number
  project_id: number
  step_id: number
  semantic_role: string
  candidate_index: number
  task_id: string
  artifact_key: string
  mime_type: string
  width: number
  height: number
  duration: number
  size: number
  sha256: string
  accepted: boolean
  selected: boolean
  url?: string
}

export type DesignStep = {
  id: number
  project_id: number
  role: string
  operation: string
  capability_id: string
  model: string
  parameters: string
  plan_revision: number
  confirm_revision: number
  attempt: number
  idempotency_key: string
  task_id: string
  status: 'pending' | 'submitted' | 'succeeded' | 'failed'
  failure_class: string
  estimate?: DesignPriceView
  assets?: DesignAsset[]
}

export type DesignPriceView = {
  model_price: number
  group_ratio: number
  quota_per_call: number
}

export type DesignStepWithAssets = DesignStep & {
  assets: DesignAsset[]
}

export type DesignProjectView = DesignProject & {
  steps: DesignStepWithAssets[]
  estimate?: DesignPriceView
}

export type DesignProjectListResponse = {
  items: DesignProject[]
  total: number
  page: number
  size: number
}

export type DesignProjectInput = {
  name: string
  kind: 'image' | 'video'
  brief?: string
  token_id?: number
  role?: string
  capability_id?: string
  parameters?: Record<string, unknown>
}
