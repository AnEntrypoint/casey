import * as webjsx from '/design/vendor/webjsx/index.js';
import { Tooltip } from '/design/src/components/overlay-primitives.js';
import { glossaryLookup } from '../glossary.js';
const h = webjsx.createElement;

export function Term({ term, children } = {}) {
    const label = children != null ? children : term;
    const explain = glossaryLookup(term);
    if (!explain) return h('span', { key: term }, label);
    return Tooltip({
        label: explain,
        placement: 'top',
        children: h('span', { class: 'ds-term', tabindex: '0' }, label),
    });
}
