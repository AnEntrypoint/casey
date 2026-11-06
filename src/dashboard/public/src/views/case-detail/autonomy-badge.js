import { brandName } from '../../vocabulary.js';
import { word } from '../../words.js';

const AUTONOMY_KEY = {
    auto: 'ui.autonomy_badge_auto',
    assisted: 'ui.autonomy_badge_assisted',
    observe: 'ui.autonomy_badge_observe',
};

export function autonomyExplanation(autonomy) {
    const key = AUTONOMY_KEY[autonomy];
    return key ? word(key, { brand: brandName() }) : word('ui.autonomy_badge_fallback');
}
