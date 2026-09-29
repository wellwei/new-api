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
import { Check } from 'lucide-react'
import { useTranslation } from 'react-i18next'

import { cn } from '@/lib/utils'

import { STEPS, type StepKey } from '../terminology'

type StepBarProps = {
  current: StepKey
  /** Highest step the user has unlocked; earlier ones stay clickable. */
  reached: StepKey
  onStepClick: (step: StepKey) => void
}

function stepIndex(key: StepKey): number {
  return STEPS.findIndex((step) => step.key === key)
}

/**
 * Horizontal progress rail. Completed steps are clickable so a user who
 * over-configured can step back without losing state; future steps are not
 * interactive, which keeps the "one thing to do now" signal unambiguous.
 */
export function StepBar(props: StepBarProps) {
  const { t } = useTranslation()
  const currentIndex = stepIndex(props.current)
  const reachedIndex = stepIndex(props.reached)

  return (
    <ol className='flex w-full items-center gap-1'>
      {STEPS.map((step, index) => {
        const isDone = index < currentIndex
        const isCurrent = step.key === props.current
        const isReachable = index <= reachedIndex
        const isLast = index === STEPS.length - 1

        return (
          <li
            key={step.key}
            className={cn('flex items-center', !isLast && 'flex-1')}
          >
            <button
              type='button'
              disabled={!isReachable}
              onClick={() => props.onStepClick(step.key)}
              className={cn(
                'flex items-center gap-2 rounded-md px-2 py-1.5 text-sm transition',
                isCurrent && 'bg-accent text-accent-foreground',
                !isCurrent && isReachable && 'hover:bg-accent/50 cursor-pointer',
                !isReachable && 'cursor-default opacity-50'
              )}
            >
              <span
                className={cn(
                  'flex size-5 shrink-0 items-center justify-center rounded-full text-xs',
                  isDone && 'bg-primary text-primary-foreground',
                  isCurrent && 'bg-primary text-primary-foreground',
                  !isDone && !isCurrent && 'border bg-transparent'
                )}
              >
                {isDone ? <Check className='size-3' /> : index + 1}
              </span>
              <span className={cn(isCurrent && 'font-medium')}>
                {t(step.label)}
              </span>
            </button>
            {!isLast ? (
              <span
                className={cn(
                  'mx-1 h-px flex-1',
                  index < currentIndex ? 'bg-primary' : 'bg-border'
                )}
              />
            ) : null}
          </li>
        )
      })}
    </ol>
  )
}
