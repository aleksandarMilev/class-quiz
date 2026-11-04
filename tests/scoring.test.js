import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pointsFor, streakBonus, applyQuestion, rank, isLate, validateQuiz, GRACE_MS } from '../js/scoring.js';
import registry from '../quizzes/index.js';
import testQuiz from './fixtures/test-quiz.js';

const timed = (elapsedMs, durationMs = 20000) => ({ correct: true, elapsedMs, durationMs, timed: true });

test('wrong answer scores 0', () => {
  assert.equal(pointsFor({ correct: false, elapsedMs: 0, durationMs: 20000, timed: true }), 0);
  assert.equal(pointsFor({ correct: false, elapsedMs: 0, durationMs: 20000, timed: false }), 0);
});

test('instant correct answer scores 1000', () => {
  assert.equal(pointsFor(timed(0)), 1000);
  assert.equal(pointsFor(timed(-50)), 1000, 'negative elapsed (clock jitter) is clamped');
});

test('last-moment correct answer scores 500', () => {
  assert.equal(pointsFor(timed(20000)), 500);
  assert.equal(pointsFor(timed(20400)), 500, 'within grace is clamped to the minimum');
});

test('correct answer halfway scores 750', () => {
  assert.equal(pointsFor(timed(10000)), 750);
  assert.equal(pointsFor(timed(3333)), Math.round(1000 * (1 - 3333 / 20000 / 2)));
});

test('untimed correct answer scores 1000', () => {
  assert.equal(pointsFor({ correct: true, elapsedMs: 99999, durationMs: 0, timed: false }), 1000);
});

test('streak bonus', () => {
  assert.equal(streakBonus(0), 0);
  assert.equal(streakBonus(1), 0);
  assert.equal(streakBonus(2), 100);
  assert.equal(streakBonus(3), 200);
  assert.equal(streakBonus(6), 500);
  assert.equal(streakBonus(20), 500);
});

test('late answer scores 0 and resets streak', () => {
  const state = { startedAt: 1_000_000, duration: 20000, timed: true };
  const deadline = state.startedAt + state.duration;
  assert.equal(isLate({ at: deadline + GRACE_MS }, state), false);
  assert.equal(isLate({ at: deadline + GRACE_MS + 1 }, state), true);
  assert.equal(isLate({ at: deadline + 10 * GRACE_MS }, { ...state, timed: false }), false, 'untimed is never late');

  const players = { a: { name: 'A', score: 1000, streak: 3 }, b: { name: 'B', score: 0, streak: 0 } };
  const answers = { a: { choice: 1, at: deadline + GRACE_MS + 1 }, b: { choice: 1, at: deadline + GRACE_MS } };
  const out = applyQuestion(players, answers, { correct: 1 }, state);
  assert.deepEqual(out.a, { score: 1000, streak: 0, lastGain: 0 });
  assert.deepEqual(out.b, { score: 500, streak: 1, lastGain: 500 });
});

test('applyQuestion: scores, streaks, no answer, wrong answer', () => {
  const state = { startedAt: 5000, duration: 10000, timed: true };
  const players = {
    fast: { name: 'Fast', score: 2000, streak: 1 },
    slow: { name: 'Slow', score: 100, streak: 0 },
    wrong: { name: 'Wrong', score: 900, streak: 4 },
    none: { name: 'None', score: 300, streak: 2 },
  };
  const answers = {
    fast: { choice: 0, at: 5000 },
    slow: { choice: 0, at: 10000 },
    wrong: { choice: 3, at: 6000 },
    ghost: { choice: 0, at: 5000 }, // answer from a kicked player is ignored
  };
  const out = applyQuestion(players, answers, { correct: 0 }, state);
  assert.deepEqual(out.fast, { score: 2000 + 1000 + 100, streak: 2, lastGain: 1100 });
  assert.deepEqual(out.slow, { score: 100 + 750, streak: 1, lastGain: 750 });
  assert.deepEqual(out.wrong, { score: 900, streak: 0, lastGain: 0 });
  assert.deepEqual(out.none, { score: 300, streak: 0, lastGain: 0 });
  assert.equal(out.ghost, undefined);
});

test('applyQuestion: untimed and missing fields', () => {
  const out = applyQuestion({ p: { name: 'P' } }, { p: { choice: 2, at: 999999 } }, { correct: 2 }, { startedAt: 0, duration: 0, timed: false });
  assert.deepEqual(out.p, { score: 1000, streak: 1, lastGain: 1000 });
  assert.deepEqual(applyQuestion({ p: { name: 'P' } }, null, { correct: 0 }, { timed: false }).p, { score: 0, streak: 0, lastGain: 0 });
});

test('rank: sorted by score, ties share a rank', () => {
  const ranked = rank({
    u1: { name: 'Вера', score: 500 },
    u2: { name: 'Ани', score: 900 },
    u3: { name: 'Боби', score: 500 },
    u4: { name: 'Гого', score: 100 },
    u5: { name: 'Дани' },
  });
  assert.deepEqual(ranked.map((p) => [p.uid, p.rank]), [['u2', 1], ['u3', 2], ['u1', 2], ['u4', 4], ['u5', 5]]);
  assert.deepEqual(rank([{ name: 'X', score: 0 }, { name: 'Y', score: 0 }]).map((p) => p.rank), [1, 1]);
  assert.deepEqual(rank({}), []);
});

test('validateQuiz flags malformed quizzes', () => {
  assert.deepEqual(validateQuiz(testQuiz), []);
  assert.ok(validateQuiz(null).length > 0);
  const bad = { id: 'x', title: 'X', questions: [{ q: 'Q', answers: ['only one'], correct: 3, time: 0 }] };
  assert.equal(validateQuiz(bad).length, 3);
});

test('every quiz in the registry loads and is valid', async () => {
  assert.ok(registry.length > 0, 'registry is not empty');
  const ids = new Set();
  for (const entry of registry) {
    assert.ok(!ids.has(entry.id), `duplicate id ${entry.id}`);
    ids.add(entry.id);
    const quiz = (await entry.load()).default;
    assert.deepEqual(validateQuiz(quiz), [], `quiz ${entry.id}`);
    assert.equal(quiz.id, entry.id, `id in registry matches the quiz file (${entry.id})`);
  }
});
