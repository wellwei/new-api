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
import { WikiReader } from './wiki-reader'

/**
 * Documentation tab: the console's own manual.
 *
 * The pages are markdown files under `features/explore/wiki/`, bundled at build
 * time and rendered in place, so the manual ships with the version the reader
 * is actually using and nobody is sent to another site. The `docs_link`
 * setting that used to power an external link is deliberately not read here —
 * see `docs/技术结论.md`「站内单页化」for why.
 */
export function DocsTab() {
  return (
    <div className='h-full min-h-0'>
      <WikiReader />
    </div>
  )
}
