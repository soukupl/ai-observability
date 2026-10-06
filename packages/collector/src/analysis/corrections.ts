/**
 * "Was the next prompt a correction?" heuristics (BRIEF §5.5), EN + CZ. Runs locally; the prompt is
 * never sent or stored. Czech phrases are written without diacritics because input is folded
 * (`špatně` → `spatne`). Extend the lists (and the test table) for more languages.
 */

/** Phrases that mark a correction when the prompt STARTS with them. */
export const CORRECTION_START_PHRASES = {
  en: [
    'no', 'nope', 'nah', 'wrong', 'incorrect', 'not right', 'revert', 'undo', 'rollback', 'roll back',
    "don't", 'dont', 'do not', 'not like that', 'not what', "that's not", 'thats not', 'that is not',
    "this isn't", "that isn't", 'this is not', "it's broken", 'its broken', 'still broken', 'still failing',
    'still fails', 'still not', "still doesn't", 'still does not', "doesn't work", 'does not work',
    "didn't work", 'did not work', 'not working', 'try again', 'you misunderstood', 'why did you',
    'put it back', 'go back', 'actually no', 'stop', 'you broke', 'it broke', 'it is broken',
  ],
  cs: [
    'ne', 'nee', 'neee', 'spatne', 'to je spatne', 'je to spatne', 'to neni', 'tohle neni', 'neni to',
    'nefunguje', 'porad nefunguje', 'porad to nefunguje', 'stale nefunguje', 'stale to nefunguje',
    'vrat', 'vratit', 'zrus', 'zrusit', 'nedelej', 'proc jsi', 'nespravne', 'to nechci', 'tohle nechci',
    'to jsem nechtel', 'to jsem nechtela', 'tak ne', 'zase spatne', 'opet spatne', 'zkus to znovu', 'rozbil',
  ],
} as const;

/** Phrases that mark a correction ANYWHERE in the first 200 characters. */
export const CORRECTION_ANYWHERE_PHRASES = {
  en: [
    "that's wrong", 'thats wrong', 'that is wrong', 'this is wrong', "it's wrong", 'is still broken',
    'still failing', 'still fails', "still doesn't work", 'still does not work', "that's not right",
    'not what i asked', 'not what i wanted', 'not what i meant', 'revert that', 'revert this', 'revert it',
    'revert your', 'revert the change', 'revert those', 'revert everything', 'undo that', 'undo this',
    'undo your', 'undo the change', 'undo those', 'undo everything', 'roll it back', 'roll that back',
    'roll this back', 'you broke', 'broke the build', 'you misunderstood', 'put it back', 'that broke',
    'why did you delete', 'why did you remove', 'why did you change',
  ],
  cs: [
    'to je spatne', 'je to spatne', 'udelal jsi to spatne', 'udelals to spatne', 'delas to spatne',
    'nefunguje to', 'porad nefunguje', 'porad to nefunguje', 'stale nefunguje', 'stale to nefunguje',
    'vrat to', 'vrat zpet', 'vrat zmeny', 'vrat to zpatky', 'zrus to', 'zrus zmeny', 'rozbil jsi',
    'rozbils', 'to jsem nechtel', 'to jsem nechtela', 'nechtel jsem', 'tohle jsem nechtel', 'neni to spravne',
    'to neni spravne', 'to neni ono', 'proc jsi smazal', 'proc jsi odstranil', 'proc jsi zmenil',
  ],
} as const;

/** "no" openers that are not corrections. */
const NOT_CORRECTION_AFTER_NO = ['problem', 'worries', 'rush', 'need', 'thanks', 'pressure'];
/** Openers that mean the previous turn was fine. */
const POSITIVE_START = [
  'thanks', 'thank you', 'great', 'perfect', 'nice', 'good', 'awesome', 'cool', 'lgtm', 'looks good', 'ok great',
  'diky', 'dekuji', 'super', 'vyborne', 'skvele', 'paradni', 'perfektni', 'dobre', 'v poradku', 'funguje',
];

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const BOUNDARY_AFTER = `(?=$|[\\s,.!?:;…"')\\-])`;
const phraseAlt = (list: readonly string[]) => list.map(escape).sort((a, b) => b.length - a.length).join('|');

const START_RE = new RegExp(
  `^(?:${phraseAlt([...CORRECTION_START_PHRASES.en, ...CORRECTION_START_PHRASES.cs])})${BOUNDARY_AFTER}`,
);
const ANYWHERE_RE = new RegExp(
  `(?:^|[\\s,.!?:;"'(])(?:${phraseAlt([...CORRECTION_ANYWHERE_PHRASES.en, ...CORRECTION_ANYWHERE_PHRASES.cs])})${BOUNDARY_AFTER}`,
);
const POSITIVE_RE = new RegExp(`^(?:${phraseAlt(POSITIVE_START)})${BOUNDARY_AFTER}`);
const BENIGN_NO_RE = new RegExp(`^no,?\\s+(?:${NOT_CORRECTION_AFTER_NO.join('|')})\\b`);
/** "stop" as a correction only when it stands alone ("stop!", "stop, that's…"), not "stop the server". */
const STOP_TASK_RE = /^stop\s+(?!it\b|that\b|this\b)[a-z]/;

/** Lowercase, strip diacritics, unify apostrophes, collapse whitespace, drop leading quotes/markup. */
export function foldPrompt(prompt: string): string {
  return prompt
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[‘’ʼ`]/g, "'")
    .replace(/\s+/g, ' ')
    .replace(/^[\s>*_#"'(\-]+/, '')
    .slice(0, 200)
    .trim();
}

/** True when the prompt looks like the user correcting the previous turn. */
export function looksLikeCorrection(prompt: string): boolean {
  const p = foldPrompt(prompt);
  if (!p) return false;
  if (POSITIVE_RE.test(p) || BENIGN_NO_RE.test(p) || STOP_TASK_RE.test(p)) return false;
  return START_RE.test(p) || ANYWHERE_RE.test(p);
}
