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
import { ImagePlus, X } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'

type ReferenceSlotsProps = {
  /** Schema field name, so each change is reported under its own key. */
  name: string
  label: string
  hint?: string
  /** Capability-declared ceiling; the slot counter turns red as it is reached. */
  max: number
  /** Current value. Always a string[]; never a joined string. */
  values: string[]
  onChange: (name: string, value: string[]) => void
  disabled?: boolean
  /** Counted against a shared budget across several reference keys. */
  usedElsewhere?: number
}

/**
 * Renders a capability's `type: 'array'` reference-image field.
 *
 * The workbuddy plugin declares `image` (maxItems 4) and `reference_images`
 * (maxItems 3) as arrays of image URLs. The generic schema renderer only knew
 * how to draw scalars, so these fell through to a single-line text input whose
 * value was `String(array)` — the user was asked to type `["a.png","b.png"]`
 * by hand. This component is the fix: the value stays a real array, and the
 * limit the plugin declares is visible before the user trips over it.
 *
 * Uploading is out of scope for Phase 1 (no upload endpoint in /api/design/*),
 * so the input takes an image URL — the same shape the upstream tools accept.
 */
export function ReferenceSlots(props: ReferenceSlotsProps) {
  const { t } = useTranslation()
  const [draftUrl, setDraftUrl] = useState('')
  const [rejected, setRejected] = useState('')

  const values = Array.isArray(props.values) ? props.values : []
  const used = values.length + (props.usedElsewhere ?? 0)
  const full = used >= props.max
  const listId = `design-refs-${props.name}`

  const commit = (next: string[]) => {
    setRejected('')
    props.onChange(props.name, next)
  }

  const addFromDraft = () => {
    const url = draftUrl.trim()
    if (url === '') return
    if (full) return
    if (!/^https?:\/\//i.test(url) && !url.startsWith('/')) {
      setRejected(
        t('Enter a full image URL starting with http:// or https://')
      )
      return
    }
    // Repeating the same reference adds nothing and would collide as a React
    // key, so treat it as a no-op the user can see.
    if (values.includes(url)) {
      setRejected(t('That image is already in the list.'))
      return
    }
    commit([...values, url])
    setDraftUrl('')
  }

  const removeAt = (index: number) => {
    commit(values.filter((_, i) => i !== index))
  }

  return (
    <div className='space-y-2'>
      <div className='flex items-center justify-between gap-2'>
        <Label htmlFor={`${listId}-input`}>{props.label}</Label>
        <span
          className={
            full
              ? 'text-destructive text-xs tabular-nums'
              : 'text-muted-foreground text-xs tabular-nums'
          }
        >
          {t('{{used}} / {{max}} used', { used, max: props.max })}
        </span>
      </div>

      {values.length > 0 ? (
        <ul className='space-y-2' id={listId}>
          {values.map((value, index) => (
            <li
              // The URL is the identity here: it is the user's own input, and
              // it is what removeAt compares on. A repeated URL is a no-op
              // rather than two independently-removable rows.
              key={value}
              className='flex items-center gap-2 rounded-md border p-2'
            >
              <img
                src={value}
                alt=''
                className='size-10 shrink-0 rounded object-cover'
                loading='lazy'
                // A remote URL that fails to load must not leave a broken icon.
                onError={(event) => {
                  event.currentTarget.style.visibility = 'hidden'
                }}
              />
              <span className='min-w-0 flex-1 truncate text-xs' title={value}>
                {value}
              </span>
              <Button
                type='button'
                variant='ghost'
                size='sm'
                disabled={props.disabled}
                onClick={() => removeAt(index)}
                aria-label={t('Remove reference image {{index}}', { index: index + 1 })}
              >
                <X className='size-4' />
              </Button>
            </li>
          ))}
        </ul>
      ) : null}

      <div className='flex items-center gap-2'>
        <Input
          id={`${listId}-input`}
          value={draftUrl}
          disabled={props.disabled || full}
          placeholder={
            full ? t('Reference limit reached') : t('Paste an image URL')
          }
          onChange={(event) => {
            setDraftUrl(event.target.value)
            setRejected('')
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault()
              addFromDraft()
            }
          }}
        />
        <Button
          type='button'
          variant='outline'
          size='sm'
          disabled={props.disabled || full || draftUrl.trim() === ''}
          onClick={addFromDraft}
        >
          <ImagePlus className='size-4' />
          {t('Add')}
        </Button>
      </div>

      {rejected ? (
        <p className='text-destructive text-xs'>{rejected}</p>
      ) : null}
      {props.hint ? (
        <p className='text-muted-foreground text-xs'>{props.hint}</p>
      ) : (
        <p className='text-muted-foreground text-xs'>
          {t(
            'Adding a reference image turns this into an edit of that image instead of a new one.'
          )}
        </p>
      )}
    </div>
  )
}
