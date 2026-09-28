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

import type {
  DesignParameterProperty,
  DesignParameterSchema,
} from './types'

type SchemaFormProps = {
  schema: DesignParameterSchema
  values: Record<string, unknown>
  onChange: (name: string, value: unknown) => void
  disabled?: boolean
}

function propertyTitle(
  name: string,
  property: DesignParameterProperty
): string {
  if (typeof property.title === 'string' && property.title !== '') {
    return property.title
  }
  return name
}

function isHidden(property: DesignParameterProperty): boolean {
  return property['x-hidden'] === true
}

function constraintsOf(property: DesignParameterProperty): string[] {
  const raw = property.constraints
  if (!Array.isArray(raw)) return []
  return raw.filter((item): item is string => typeof item === 'string')
}

function placeholderOf(property: DesignParameterProperty): string {
  if (typeof property.default === 'string') return property.default
  if (typeof property.description === 'string') return property.description
  return ''
}

/**
 * Renders the workbench capability's parameterSchema as a form. Only the
 * backend-vetted keywords drive behavior: enum -> select, constraints ->
 * narrowed candidates, x-hidden -> hidden, minimum/maximum/lengths ->
 * HTML attribute hints. The server re-evaluates every value before submit.
 */
export function SchemaForm({ schema, values, onChange, disabled }: SchemaFormProps) {
  const { t } = useTranslation()
  const properties = useMemo(() => {
    const entries = Object.entries(schema.properties ?? {})
    return entries.filter(([, property]) => !isHidden(property))
  }, [schema])

  if (properties.length === 0) {
    return (
      <p className="text-muted-foreground text-sm">
        {t('This capability has no configurable parameters')}
      </p>
    )
  }

  const required = new Set(schema.required ?? [])

  return (
    <div className="space-y-4">
      {properties.map(([name, property]) => {
        const constraints = constraintsOf(property)
        const candidates =
          constraints.length > 0
            ? constraints
            : (property.enum?.filter(
                (item): item is string => typeof item === 'string'
              ) ?? [])
        const title = propertyTitle(name, property)
        const value = values[name]
        const valueText = value == null ? '' : String(value)

        if (candidates.length > 0) {
          return (
            <div key={name} className="space-y-2">
              <Label htmlFor={`design-param-${name}`}>
                {title}
                {required.has(name) ? ' *' : ''}
              </Label>
              <Select
                value={valueText}
                disabled={disabled}
                onValueChange={(next) => onChange(name, next)}
              >
                <SelectTrigger id={`design-param-${name}`} className="w-full">
                  <SelectValue
                    placeholder={t('Please select')}
                  />
                </SelectTrigger>
                <SelectContent>
                  {candidates.map((candidate) => (
                    <SelectItem key={candidate} value={candidate}>
                      {candidate}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )
        }

        if (property.type === 'integer' || property.type === 'number') {
          return (
            <div key={name} className="space-y-2">
              <Label htmlFor={`design-param-${name}`}>
                {title}
                {required.has(name) ? ' *' : ''}
              </Label>
              <Input
                id={`design-param-${name}`}
                type="number"
                disabled={disabled}
                value={valueText}
                min={property.minimum}
                max={property.maximum}
                placeholder={placeholderOf(property)}
                onChange={(event) => {
                  const raw = event.target.value
                  if (raw === '') {
                    onChange(name, undefined)
                    return
                  }
                  const parsed = Number(raw)
                  onChange(
                    name,
                    Number.isNaN(parsed)
                      ? raw
                      : property.type === 'integer'
                        ? Math.trunc(parsed)
                        : parsed
                  )
                }}
              />
            </div>
          )
        }

        if (property.type === 'boolean') {
          return (
            <div key={name} className="flex items-center gap-2">
              <Label htmlFor={`design-param-${name}`}>{title}</Label>
              <Select
                value={value === true ? 'true' : value === false ? 'false' : ''}
                disabled={disabled}
                onValueChange={(next) =>
                  onChange(name, next === 'true' ? true : next === 'false' ? false : undefined)
                }
              >
                <SelectTrigger id={`design-param-${name}`} className="w-28">
                  <SelectValue placeholder={t('Please select')} />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="true">{t('On')}</SelectItem>
                  <SelectItem value="false">{t('Off')}</SelectItem>
                </SelectContent>
              </Select>
            </div>
          )
        }

        // String (or untyped) fields render as textarea when long-form by
        // convention (prompt-like names) or input otherwise.
        const isLongForm =
          name === 'prompt' || name === 'negative_prompt' || name === 'brief'
        return (
          <div key={name} className="space-y-2">
            <Label htmlFor={`design-param-${name}`}>
              {title}
              {required.has(name) ? ' *' : ''}
            </Label>
            {isLongForm ? (
              <Textarea
                id={`design-param-${name}`}
                disabled={disabled}
                value={valueText}
                rows={4}
                maxLength={property.maxLength}
                placeholder={placeholderOf(property)}
                onChange={(event) => onChange(name, event.target.value)}
              />
            ) : (
              <Input
                id={`design-param-${name}`}
                disabled={disabled}
                value={valueText}
                maxLength={property.maxLength}
                placeholder={placeholderOf(property)}
                onChange={(event) => onChange(name, event.target.value)}
              />
            )}
            {property.description && !isLongForm ? (
              <p className="text-muted-foreground text-xs">
                {property.description}
              </p>
            ) : null}
          </div>
        )
      })}
    </div>
  )
}
