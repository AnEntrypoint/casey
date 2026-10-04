import { brandName } from '../../vocabulary.js';

const AUTONOMY_COPY = {
    auto: '{brand} replies to the contact on its own, no review needed.',
    assisted: '{brand} drafts a reply and waits for a person to approve or discard it before it sends.',
    observe: '{brand} only logs what happens. It never replies; a person must reply by hand.',
};

export function autonomyExplanation(autonomy) {
    const brand = brandName();
    return (AUTONOMY_COPY[autonomy] || 'Sets who answers the contact.').replace(/\{brand\}/g, brand);
}
