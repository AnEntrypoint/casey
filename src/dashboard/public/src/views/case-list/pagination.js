// Real pagination controls (ux-case-list-real-pagination): page-size
// selector + prev/next + page-jump, replacing the old unbounded ?limit=200
// client render. Talks to the SAME /api/cases endpoint via offset/limit --
// no new API surface.

import * as ds from '/design/dist/247420.js';
import { state, setPage, setPageSize } from '../../state.js';
const { Btn, Select } = ds.components;
const h = ds.h;

const PAGE_SIZES = [25, 50, 100, 200];

export function Pagination() {
  const total = state.allCasesTotal;
  const pageSize = state.pageSize;
  const page = state.page;
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  const from = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const to = Math.min(total, page * pageSize);

  if (total <= pageSize && page === 1) {
    // Nothing to paginate yet -- still show the count so the row never
    // silently vanishes between "loading" and "many pages".
    return h('div', { class: 'ds-pagination ds-pagination-single' },
      h('span', { class: 'ds-pagination-count' }, total + ' case' + (total === 1 ? '' : 's')));
  }

  return h('div', { class: 'ds-pagination', role: 'navigation', 'aria-label': 'Case list pagination' },
    h('span', { key: 'range', class: 'ds-pagination-count' }, from + '-' + to + ' of ' + total),
    Btn({ key: 'prev', variant: 'ghost', size: 'sm', disabled: page <= 1, 'aria-label': 'Previous page', onClick: () => setPage(page - 1), children: 'Prev' }),
    h('span', { key: 'jump', class: 'ds-pagination-jump' },
      h('span', {}, 'Page ' + page + ' of ' + pageCount)),
    Btn({ key: 'next', variant: 'ghost', size: 'sm', disabled: page >= pageCount, 'aria-label': 'Next page', onClick: () => setPage(page + 1), children: 'Next' }),
    Select({
      key: 'size', value: String(pageSize), size: 'sm', ariaLabel: 'Rows per page',
      options: PAGE_SIZES.map((n) => ({ value: String(n), label: n + ' / page' })),
      onChange: (v) => setPageSize(parseInt(v, 10) || 50),
    })
  );
}
