import { randomInt } from 'node:crypto';

export const CODE_LENGTH = 4;
export const COLOURS = 6;
export const MAX_GUESSES = 10;
// A loss (or an abandoned game) is recorded as one guess more than allowed,
// so it can sit in averages next to wins and be converted later if needed.
export const LOSS_SCORE = MAX_GUESSES + 1;

export function newSecret() {
  return Array.from({ length: CODE_LENGTH }, () => randomInt(COLOURS));
}

export function isValidGuess(guess) {
  return (
    Array.isArray(guess) &&
    guess.length === CODE_LENGTH &&
    guess.every((c) => Number.isInteger(c) && c >= 0 && c < COLOURS)
  );
}

/** Black = right colour, right place. White = right colour, wrong place. */
export function scoreGuess(secret, guess) {
  let black = 0;
  const secretCounts = new Array(COLOURS).fill(0);
  const guessCounts = new Array(COLOURS).fill(0);
  for (let i = 0; i < CODE_LENGTH; i++) {
    if (secret[i] === guess[i]) black++;
    secretCounts[secret[i]]++;
    guessCounts[guess[i]]++;
  }
  let common = 0;
  for (let c = 0; c < COLOURS; c++) common += Math.min(secretCounts[c], guessCounts[c]);
  return { black, white: common - black };
}

/** Points for a finished game: 10 for a first-guess win, down to 0 for a loss. */
export function pointsFor(score) {
  return LOSS_SCORE - score;
}
