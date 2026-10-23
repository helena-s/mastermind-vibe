import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scoreGuess, isValidGuess, pointsFor, newSecret, LOSS_SCORE } from '../src/game.js';

test('scoreGuess counts exact and misplaced pegs', () => {
  assert.deepEqual(scoreGuess([0, 1, 2, 3], [0, 1, 2, 3]), { black: 4, white: 0 });
  assert.deepEqual(scoreGuess([0, 1, 2, 3], [0, 2, 4, 4]), { black: 1, white: 1 });
  assert.deepEqual(scoreGuess([0, 1, 2, 3], [0, 1, 3, 2]), { black: 2, white: 2 });
  assert.deepEqual(scoreGuess([0, 1, 2, 3], [4, 5, 4, 5]), { black: 0, white: 0 });
});

test('scoreGuess does not double count repeated colours', () => {
  assert.deepEqual(scoreGuess([0, 0, 1, 1], [0, 0, 0, 0]), { black: 2, white: 0 });
  assert.deepEqual(scoreGuess([0, 1, 1, 1], [1, 0, 0, 0]), { black: 0, white: 2 });
  assert.deepEqual(scoreGuess([5, 5, 5, 0], [0, 5, 2, 2]), { black: 1, white: 1 });
});

test('isValidGuess rejects malformed input', () => {
  assert.ok(isValidGuess([0, 1, 2, 5]));
  for (const bad of [[0, 1, 2], [0, 1, 2, 6], [0, 1, 2, -1], [0, 1, 2, 1.5], ['0', 1, 2, 3], null, 'abcd']) {
    assert.equal(isValidGuess(bad), false, JSON.stringify(bad));
  }
});

test('points: first-guess win is 10, tenth-guess win is 1, loss is 0', () => {
  assert.equal(pointsFor(1), 10);
  assert.equal(pointsFor(10), 1);
  assert.equal(pointsFor(LOSS_SCORE), 0);
});

test('newSecret produces a valid code', () => {
  for (let i = 0; i < 100; i++) assert.ok(isValidGuess(newSecret()));
});
