// Term -- contextual-help wrapper for casey's own internal-jargon words.
// Wraps a label in a dotted-underline <span> (never a raw color literal --
// the underline rides an existing SDK border-token via app.css) and attaches
// the SDK's Tooltip with the glossary's plain-words explanation, so the
// meaning is available in place (hover/focus) rather than only inside the
// static help card (ux-onboarding-contextual-help). Falls back to a plain,
// unwrapped label when the term has no glossary entry, so a Term() call
// with a mistyped key degrades to visible-but-unexplained rather than an
// empty/broken node.

import * as webjsx from '/design/vendor/webjsx/index.js';
import { Tooltip } from '/design/src/components/overlay-primitives.js';
import { glossaryLookup } from '../glossary.js';
const h = webjsx.createElement;

/**
 * @param {Object} props
 * @param {string} props.term - a glossary.js key.
 * @param {*} [props.children] - the visible label; defaults to `term` itself.
 */
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
