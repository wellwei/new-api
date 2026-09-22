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
/**
 * In-site documentation.
 *
 * The pages are markdown files in this directory, bundled at build time
 * (`?raw`), so the console renders its own manual instead of sending readers to
 * an external site. Adding a page means dropping a `.md` file here and listing
 * it below — the reader, navigation and rendering need no changes.
 *
 * Write for the person using the API, not for someone maintaining it: model
 * names and prices drift, so point at the model square instead of restating
 * values that will go stale here.
 */
import clients from './clients.md?raw'
import faq from './faq.md?raw'
import pricing from './pricing.md?raw'
import quickStart from './quick-start.md?raw'

export type WikiPageId = 'quick-start' | 'clients' | 'pricing' | 'faq'

export interface WikiPage {
  id: WikiPageId
  /** Sidebar label; kept short so the list stays scannable. */
  title: string
  /** One-line summary shown under the active page's heading. */
  summary: string
  content: string
}

export const WIKI_PAGES: readonly WikiPage[] = [
  {
    id: 'quick-start',
    title: '快速开始',
    summary: '从创建密钥到发出第一个请求',
    content: quickStart,
  },
  {
    id: 'clients',
    title: '客户端配置',
    summary: '把密钥填进 Codex、Chatbox 等常用客户端',
    content: clients,
  },
  {
    id: 'pricing',
    title: '模型与计费',
    summary: '价格怎么算、免费档与 VIP 的区别',
    content: pricing,
  },
  {
    id: 'faq',
    title: '常见问题',
    summary: '报错与异常的排查办法',
    content: faq,
  },
]

export const DEFAULT_WIKI_PAGE_ID: WikiPageId = 'quick-start'

export function isWikiPageId(value: string): value is WikiPageId {
  return WIKI_PAGES.some((page) => page.id === value)
}
