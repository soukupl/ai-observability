import { describe, expect, it } from 'vitest';
import { foldPrompt, looksLikeCorrection } from '../src/analysis/corrections.js';

describe('looksLikeCorrection', () => {
  it.each([
    // EN
    'no',
    'No, that is not what I meant',
    'nope',
    'wrong file',
    "That's not right",
    "that's wrong, use the other API",
    'This is wrong.',
    'revert that',
    'Please revert the change to the parser',
    'undo',
    'undo this please',
    "don't change the tests",
    'Do not touch the config',
    "it still doesn't work",
    'still failing',
    'the build is still broken',
    'you broke the login page',
    'try again',
    'Not what I asked for',
    'why did you delete the migration?',
    'stop!',
    'stop, that is enough',
    // CZ
    'ne',
    'Ne, to je špatně',
    'špatně',
    'to je špatně',
    'Pořád to nefunguje',
    'nefunguje to',
    'vrať to',
    'Vrať změny v parseru',
    'zruš to',
    'to jsem nechtěl',
    'tohle není ono',
    'rozbil jsi přihlášení',
    'proč jsi smazal ten test?',
    'nedělej to',
  ])('correction: %j', (p) => {
    expect(looksLikeCorrection(p)).toBe(true);
  });

  it.each([
    'now add tests for the parser',
    'note: the API is v2',
    'no problem, next add the export',
    'No worries. Now do the docs',
    'thanks, now update the README',
    'great, ship it',
    'perfect',
    'stop the dev server and run the build',
    'Add an undo button to the editor',
    'nothing else, just the docs',
    'notify the user on failure',
    'nejdřív přidej test',
    'nefunkční odkaz v patičce oprav prosím',
    'díky, teď přidej export',
    'super, funguje to',
    'Next, implement the revert endpoint',
    'Implement the "wrong password" error message',
    '',
  ])('not a correction: %j', (p) => {
    expect(looksLikeCorrection(p)).toBe(false);
  });

  it('folds diacritics, case and apostrophes', () => {
    expect(foldPrompt('  ŠPATNĚ – That’s   it')).toBe("spatne – that's it");
  });
});
