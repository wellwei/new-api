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
import type { SVGProps } from 'react'

type IconStealthProps = SVGProps<SVGSVGElement> & {
  size?: number
}

/**
 * Stealth — placeholder brand for models whose upstream never discloses a
 * vendor (config-model-metadata.py maps every `space-bunny-*` name here, and
 * new anonymous models join the same prefix entry rather than guessing a real
 * vendor). The mark is a B-2 planform, drawn as an inline SVG so `currentColor`
 * resolves against the surrounding text color: the same file loaded through
 * `<img src>` would ignore it and render black on black in dark mode.
 */
export function IconStealth({ size = 20, ...props }: IconStealthProps) {
  return (
    <svg
      xmlns='http://www.w3.org/2000/svg'
      viewBox='0 0 24 24'
      width={size}
      height={size}
      fill='none'
      // 装饰性图标：自定义图标这条路拿不到调用方传的 role/aria-label
      // （CUSTOM_ICONS 分支只透传 size），不给它可访问名会被读屏念出来。
      aria-hidden='true'
      {...props}
    >
      <path
        d='M12 3.5 5.4 13.1 2.6 15.4l1.6 1.1L12 12.4l7.8 4.1 1.6-1.1-2.8-2.3L12 3.5Z'
        fill='currentColor'
      />
      <path d='M9.2 13.6 12 17.6l2.8-4' fill='currentColor' />
    </svg>
  )
}
