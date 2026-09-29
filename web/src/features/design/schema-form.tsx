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
import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'

import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'

import { ReferenceSlots } from './components/reference-slots'
import {
  hasReferenceImage,
  humanParamLabel,
  humanParamValue,
  isAdvancedParam,
  isRecommendedValue,
  promptAppendHint,
  referenceLimit,
  REFERENCE_PARAM_KEYS,
} from './terminology'
import type {
  DesignParameterProperty,
  DesignParameterSchema,
} from './types'

type SchemaFormProps = {
  schema: DesignParameterSchema
  values: Record<string, unknown>
  onChange: (name: string, value: unknown) => void
  disabled?: boolean
  /** Hides fields listed in terminology.isAdvancedParam behind a disclosure. */
  collapseAdvanced?: boolean
  /** Delivery form, so aspect_ratio can be locked when a frame already fixes it. */
  kind?: 'image' | 'video'
  /** True once any reference image is set, which switches tools to img2img. */
  hasReference?: boolean
  /** Capability-declared reference ceiling (`referenceLimits.maxImages`). */
  referenceLimits?: Record<string, number>
}

function isHidden(property: DesignParameterProperty): boolean {
  return property['x-hidden'] === true
}

function constraintsOf(property: DesignParameterProperty): string[] {
  const raw = property.constraints
  if (!Array.isArray(raw)) return []
  return raw.filter((item): item is string => typeof item === 'string')
}

/**
 * Candidate values for a select, as display strings.
 *
 * Numbers count. `duration: {type: 'integer', enum: [5, 6, 10]}` is a closed
 * set the model actually accepts, and dropping the numbers (as an
 * `isString` filter would) silently downgraded it to a free number box that
 * lets the user submit a value the upstream then rejects.
 */
function candidatesOf(property: DesignParameterProperty): string[] {
  const constraints = constraintsOf(property)
  if (constraints.length > 0) return constraints
  const enums = property.enum
  if (!Array.isArray(enums)) return []
  return enums
    .filter(
      (item): item is string | number =>
        typeof item === 'string' || typeof item === 'number'
    )
    .map((item) => String(item))
}

function isNumeric(property: DesignParameterProperty): boolean {
  return property.type === 'integer' || property.type === 'number'
}

/** Parses a select value back into the type the schema declares. */
function parseNumericValue(
  property: DesignParameterProperty,
  raw: string
): number | string {
  const parsed = Number(raw)
  if (Number.isNaN(parsed)) return raw
  return property.type === 'integer' ? Math.trunc(parsed) : parsed
}

function placeholderOf(property: DesignParameterProperty): string {
  if (typeof property.description === 'string' && property.description !== '') {
    return property.description
  }
  if (typeof property.default === 'string') return property.default
  return ''
}

/** Maps a boolean parameter to the string form the Select expects. */
function booleanSelectValue(value: unknown): string {
  if (value === true) return 'true'
  if (value === false) return 'false'
  return ''
}

/** Maps a Select value back to a boolean parameter, or undefined when unset. */
function parseBoolean(next: string | null): boolean | undefined {
  if (next === 'true') return true
  if (next === 'false') return false
  return undefined
}

export function defaultValuesFromSchema(
  schema: DesignParameterSchema | null | undefined
): Record<string, unknown> {
  if (!schema?.properties) return {}
  const defaults: Record<string, unknown> = {}
  for (const [key, prop] of Object.entries(schema.properties)) {
    if (prop && !isHidden(prop) && prop.default !== undefined) {
      defaults[key] = prop.default
    }
  }
  return defaults
}

/** Renders one schema field, labelled in plain language. */
function SchemaField(props: {
  name: string
  property: DesignParameterProperty
  value: unknown
  required: boolean
  disabled?: boolean
  /** Set when a delivery rule makes this field meaningless right now. */
  lockedReason?: string
  /** Ceiling for array-typed reference fields. */
  referenceMax?: number
  /** Reference images already claimed by sibling keys, for a shared budget. */
  usedElsewhere?: number
  onChange: (name: string, value: unknown) => void
}) {
  const { t } = useTranslation()
  const candidates = candidatesOf(props.property)
  const numeric = isNumeric(props.property)
  const label = humanParamLabel(props.name, props.property.title)
  const fieldId = `design-param-${props.name}`
  const valueText = props.value == null ? '' : String(props.value)
  const isLongForm =
    props.name === 'prompt' || props.name === 'negative_prompt' || props.name === 'brief'
  const helpText =
    typeof props.property.description === 'string' ? props.property.description : ''
  // The plugin states these as requirements in its own voice ("保持主体清晰、构图完整").
  // They are not enforced server-side, which is exactly why a user needs to read them.
  const appendText = promptAppendHint(props.property)
  const locked = Boolean(props.lockedReason)
  const disabled = props.disabled || locked

  /**
   * Reference images arrive as `string[]`. They must never be flattened to a
   * string for display: the value written back has to stay an array or the
   * upstream tool receives a single broken URL.
   */
  if (props.property.type === 'array') {
    const items = Array.isArray(props.value)
      ? props.value.filter((item): item is string => typeof item === 'string')
      : []
    const max = referenceLimit(
      props.referenceMax !== undefined ? { maxImages: props.referenceMax } : undefined,
      typeof props.property.maxItems === 'number' ? props.property.maxItems : undefined
    )
    return (
      <ReferenceSlots
        name={props.name}
        label={label}
        hint={helpText || undefined}
        max={max}
        values={items}
        usedElsewhere={props.usedElsewhere}
        disabled={props.disabled}
        onChange={props.onChange}
      />
    )
  }

  // Enum-like fields become a select so the user picks from valid values only.
  // This covers numeric enums too — a closed set stays a closed set.
  if (candidates.length > 0) {
    return (
      <div className='space-y-2'>
        <Label htmlFor={fieldId}>
          {label}
          {props.required ? ' *' : ''}
        </Label>
        <Select
          value={valueText}
          disabled={disabled}
          onValueChange={(next) =>
            props.onChange(
              props.name,
              numeric
                ? parseNumericValue(props.property, next ?? '')
                : (next ?? '')
            )
          }
        >
          <SelectTrigger id={fieldId} className='w-full'>
            <SelectValue placeholder={t('Please select')} />
          </SelectTrigger>
          <SelectContent>
            {candidates.map((candidate) => (
              <SelectItem key={candidate} value={candidate}>
                <span className='flex items-center gap-2'>
                  {humanParamValue(candidate)}
                  {isRecommendedValue(candidate) ? (
                    <span className='text-muted-foreground text-xs'>
                      {t('Recommended')}
                    </span>
                  ) : null}
                </span>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {locked ? (
          <p className='text-muted-foreground text-xs'>{props.lockedReason}</p>
        ) : null}
        {appendText ? (
          <p className='text-muted-foreground text-xs'>{appendText}</p>
        ) : null}
        {helpText ? (
          <p className='text-muted-foreground text-xs'>{helpText}</p>
        ) : null}
      </div>
    )
  }

  if (numeric) {
    return (
      <div className='space-y-2'>
        <Label htmlFor={fieldId}>
          {label}
          {props.required ? ' *' : ''}
        </Label>
        <Input
          id={fieldId}
          type='number'
          disabled={disabled}
          value={valueText}
          min={props.property.minimum}
          max={props.property.maximum}
          placeholder={placeholderOf(props.property)}
          onChange={(event) => {
            const raw = event.target.value
            if (raw === '') {
              props.onChange(props.name, undefined)
              return
            }
            props.onChange(
              props.name,
              parseNumericValue(props.property, raw)
            )
          }}
        />
        {appendText ? (
          <p className='text-muted-foreground text-xs'>{appendText}</p>
        ) : null}
        {helpText ? (
          <p className='text-muted-foreground text-xs'>{helpText}</p>
        ) : null}
      </div>
    )
  }

  if (props.property.type === 'boolean') {
    const boolValue = booleanSelectValue(props.value)
    return (
      <div className='space-y-2'>
        <div className='flex items-center gap-2'>
          <Label htmlFor={fieldId}>{label}</Label>
          <Select
            value={boolValue}
            disabled={disabled}
            onValueChange={(next) => props.onChange(props.name, parseBoolean(next))}
          >
            <SelectTrigger id={fieldId} className='w-28'>
              <SelectValue placeholder={t('Please select')} />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value='true'>{t('On')}</SelectItem>
              <SelectItem value='false'>{t('Off')}</SelectItem>
            </SelectContent>
          </Select>
        </div>
        {locked ? (
          <p className='text-muted-foreground text-xs'>{props.lockedReason}</p>
        ) : null}
        {appendText ? (
          <p className='text-muted-foreground text-xs'>{appendText}</p>
        ) : null}
        {helpText ? (
          <p className='text-muted-foreground text-xs'>{helpText}</p>
        ) : null}
      </div>
    )
  }

  return (
    <div className='space-y-2'>
      <Label htmlFor={fieldId}>
        {label}
        {props.required ? ' *' : ''}
      </Label>
      {isLongForm ? (
        <Textarea
          id={fieldId}
          disabled={disabled}
          value={valueText}
          rows={props.name === 'prompt' ? 5 : 3}
          maxLength={props.property.maxLength}
          placeholder={placeholderOf(props.property)}
          onChange={(event) => props.onChange(props.name, event.target.value)}
        />
      ) : (
        <Input
          id={fieldId}
          disabled={disabled}
          value={valueText}
          maxLength={props.property.maxLength}
          placeholder={placeholderOf(props.property)}
          onChange={(event) => props.onChange(props.name, event.target.value)}
        />
      )}
      {locked ? (
        <p className='text-muted-foreground text-xs'>{props.lockedReason}</p>
      ) : null}
      {appendText ? (
        <p className='text-muted-foreground text-xs'>{appendText}</p>
      ) : null}
      {helpText ? <p className='text-muted-foreground text-xs'>{helpText}</p> : null}
    </div>
  )
}

/**
 * Renders the workbench capability's parameterSchema as a form. Only the
 * backend-vetted keywords drive behavior: enum -> select, constraints ->
 * narrowed candidates, x-hidden -> hidden, minimum/maximum/lengths ->
 * HTML attribute hints. The server re-evaluates every value before submit.
 *
 * Labels go through terminology.ts so a raw key such as `aspect_ratio` never
 * reaches the page.
 */
export function SchemaForm(props: SchemaFormProps) {
  const { t } = useTranslation()
  const entries = useMemo(
    () =>
      Object.entries(props.schema.properties ?? {}).filter(
        ([, property]) => !isHidden(property)
      ),
    [props.schema]
  )

  const required = useMemo(
    () => new Set(props.schema.required ?? []),
    [props.schema]
  )

  const primary = useMemo(() => {
    if (!props.collapseAdvanced) return entries
    return entries.filter(([name]) => !isAdvancedParam(name))
  }, [entries, props.collapseAdvanced])

  const advanced = useMemo(() => {
    if (!props.collapseAdvanced) return []
    return entries.filter(([name]) => isAdvancedParam(name))
  }, [entries, props.collapseAdvanced])

  /**
   * Whether a reference image is already set, derived from the values actually
   * in the form rather than trusting the caller to keep it in sync.
   */
  const withReference =
    props.hasReference ?? hasReferenceImage(props.values)

  /**
   * Image-to-video fixes the frame from the input image, so offering a ratio
   * would be a contradiction the upstream then rejects. The workbuddy
   * VideoGen schema says the same: aspect_ratio is "Text-to-video only".
   */
  const lockedReasonFor = (name: string): string | undefined => {
    if (name === 'aspect_ratio' && props.kind === 'video' && withReference) {
      return t('The reference image already determines the frame ratio.')
    }
    return undefined
  }

  /** Reference budget already spoken for by the sibling reference keys. */
  const usedElsewhereFor = (name: string): number => {
    let used = 0
    for (const [otherKey, otherValue] of Object.entries(props.values)) {
      if (otherKey === name) continue
      if (!REFERENCE_PARAM_KEYS.has(otherKey)) continue
      if (Array.isArray(otherValue)) {
        used += otherValue.filter(
          (item) => typeof item === 'string' && item.trim() !== ''
        ).length
      } else if (typeof otherValue === 'string' && otherValue.trim() !== '') {
        used += 1
      }
    }
    return used
  }

  const renderField = (name: string, property: DesignParameterProperty) => (
    <SchemaField
      key={name}
      name={name}
      property={property}
      value={props.values[name] ?? property.default}
      required={required.has(name)}
      disabled={props.disabled}
      lockedReason={lockedReasonFor(name)}
      referenceMax={props.referenceLimits?.maxImages}
      usedElsewhere={usedElsewhereFor(name)}
      onChange={props.onChange}
    />
  )

  if (entries.length === 0) {
    return (
      <p className='text-muted-foreground text-sm'>
        {t('This model has no adjustable parameters')}
      </p>
    )
  }

  return (
    <div className='space-y-4'>
      {primary.map(([name, property]) => renderField(name, property))}

      {advanced.length > 0 ? (
        <details className='group'>
          <summary className='text-muted-foreground hover:text-foreground cursor-pointer text-sm'>
            {t('More options')}
          </summary>
          <div className='mt-4 space-y-4'>{advanced.map(([name, property]) => renderField(name, property))}</div>
        </details>
      ) : null}
    </div>
  )
}
