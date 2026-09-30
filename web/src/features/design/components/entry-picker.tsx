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
import { ImageIcon, Video } from 'lucide-react'
import { useTranslation } from 'react-i18next'

import { Button } from '@/components/ui/button'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'

import { formatQuota } from '@/lib/format'

import { capabilityDisplayName, KIND_TEXT } from '../terminology'
import type { DesignCapability } from '../types'

type ApiKeyOption = { id: number; name: string }

type EntryPickerProps = {
  kind: 'image' | 'video'
  onKindChange: (kind: 'image' | 'video') => void
  capabilities: DesignCapability[]
  capabilityId: string
  onCapabilityChange: (id: string) => void
  tokenId: number
  onTokenChange: (id: number) => void
  keys: ApiKeyOption[]
  disabled?: boolean
}

/**
 * Step 1. Collapses the old "delivery form / capability / billing token" trio
 * into one screen: pick what you want, pick a model, pick who pays. Every
 * option carries a plain-language hint and a price, so no field requires
 * prior knowledge of the platform.
 */
export function EntryPicker(props: EntryPickerProps) {
  const { t } = useTranslation()
  const available = props.capabilities.filter((item) => item.available !== false)
  const forKind = available.filter((item) => item.media_type === props.kind)
  const models = forKind.length > 0 ? forKind : available

  return (
    <div className='space-y-5'>
      <div className='space-y-2'>
        <Label>{t('What do you want to create?')}</Label>
        <div className='grid grid-cols-2 gap-3'>
          {(['image', 'video'] as const).map((kind) => {
            const Icon = kind === 'image' ? ImageIcon : Video
            const active = props.kind === kind
            return (
              <Card
                key={kind}
                role='button'
                tabIndex={0}
                aria-pressed={active}
                onClick={() => props.onKindChange(kind)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault()
                    props.onKindChange(kind)
                  }
                }}
                className={`cursor-pointer transition-colors ${
                  active ? 'border-primary bg-accent' : 'hover:bg-accent/50'
                }`}
              >
                <CardHeader className='pb-2'>
                  <Icon className='mb-1 size-5' />
                  <CardTitle className='text-base'>
                    {t(KIND_TEXT[kind].label)}
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <CardDescription className='text-xs'>
                    {t(KIND_TEXT[kind].hint)}
                  </CardDescription>
                </CardContent>
              </Card>
            )
          })}
        </div>
      </div>

      <div className='space-y-2'>
        <Label htmlFor='design-model'>{t('Model')}</Label>
        <Select
          value={props.capabilityId}
          disabled={props.disabled || models.length === 0}
          onValueChange={(value) => {
            if (value) props.onCapabilityChange(value)
          }}
        >
          <SelectTrigger id='design-model' className='w-full'>
            <SelectValue placeholder={t('Please select')} />
          </SelectTrigger>
          <SelectContent>
            {models.map((item) => (
              <SelectItem key={item.id} value={item.id} title={item.model}>
                {capabilityDisplayName(item, models)}
                {item.price ? ` · ${formatQuota(item.price.quota_per_call)}` : ''}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <p className='text-muted-foreground text-xs'>
          {t('Leave the default unless you have a reason to change it.')}
        </p>
      </div>

      <div className='space-y-2'>
        <Label htmlFor='design-token'>{t('Billing account')}</Label>
        <Select
          value={props.tokenId === 0 ? '' : String(props.tokenId)}
          disabled={props.disabled || props.keys.length === 0}
          onValueChange={(value) => props.onTokenChange(Number(value))}
        >
          <SelectTrigger id='design-token' className='w-full'>
            <SelectValue placeholder={t('Please select')} />
          </SelectTrigger>
          <SelectContent>
            {props.keys.map((key) => (
              <SelectItem key={key.id} value={String(key.id)}>
                {key.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <p className='text-muted-foreground text-xs'>
          {t(
            'Design work is charged to this account. Its key stays on the server and is never shown here.'
          )}
        </p>
      </div>
    </div>
  )
}

/** Shown when the project list is empty: one action, no configuration. */
export function EntryEmptyState(props: { onStart: () => void; disabled?: boolean }) {
  const { t } = useTranslation()
  return (
    <Card>
      <CardHeader>
        <CardTitle className='text-base'>{t('Start your first design')}</CardTitle>
        <CardDescription>
          {t(
            'Describe what you want, pick a model, and get a result you can download. No setup needed.'
          )}
        </CardDescription>
      </CardHeader>
      <CardContent>
        <Button onClick={props.onStart} disabled={props.disabled}>
          {t('Create a design task')}
        </Button>
      </CardContent>
    </Card>
  )
}
