// Security rules tests. Run with: npm run test:rules (starts the database emulator automatically).
import { test, before, after, beforeEach } from 'node:test';
import { readFileSync } from 'node:fs';
import { initializeTestEnvironment, assertFails, assertSucceeds } from '@firebase/rules-unit-testing';
import { setLogLevel } from 'firebase/app';

setLogLevel('error'); // the many expected "permission_denied" warnings are noise here

const PIN = '123456';
const HOST = 'host-uid';
const ALICE = 'alice-uid';
const BOB = 'bob-uid';
const TS = { '.sv': 'timestamp' }; // serverTimestamp() placeholder
const G = `games/${PIN}`;

let env;

before(async () => {
  const database = { rules: readFileSync(new URL('../database.rules.json', import.meta.url), 'utf8') };
  if (!process.env.FIREBASE_DATABASE_EMULATOR_HOST) Object.assign(database, { host: '127.0.0.1', port: 9000 });
  env = await initializeTestEnvironment({ projectId: 'demo-klasna-viktorina', database });
});

after(() => env?.cleanup());

const as = (uid) => env.authenticatedContext(uid).database();
const anon = () => env.unauthenticatedContext().database();

function gameData(phase = 'lobby', extra = {}) {
  return {
    hostUid: HOST,
    quizId: 'some-quiz',
    createdAt: Date.now(),
    state: { phase, qIndex: 0, answerCount: 4, duration: 20000, timed: true, ...extra },
  };
}

/** Seeds a game (rules disabled) with Alice already joined. */
async function seed(phase = 'question', stateExtra = {}, more = {}) {
  await env.withSecurityRulesDisabled(async (ctx) => {
    await ctx.database().ref(G).set({
      ...gameData(phase, { startedAt: Date.now(), ...stateExtra }),
      players: { [ALICE]: { name: 'Alice', joinedAt: Date.now(), online: true, score: 0, streak: 0, lastGain: 0 } },
      ...more,
    });
  });
}

beforeEach(() => env.clearDatabase());

// --- games/{pin} ---

test('host can create a new game', async () => {
  await assertSucceeds(as(HOST).ref(G).set({ ...gameData(), createdAt: TS }));
});

test('host can create a game with a transaction', async () => {
  const res = await assertSucceeds(as(HOST).ref(G).transaction((cur) => (cur === null ? { ...gameData(), createdAt: TS } : undefined)));
  if (!res.committed) throw new Error('transaction did not commit');
});

test('cannot create a game for someone else', async () => {
  await assertFails(as(ALICE).ref(G).set(gameData()));
});

test('cannot overwrite an existing game (not even its host)', async () => {
  await seed('lobby');
  await assertFails(as(BOB).ref(G).set({ ...gameData(), hostUid: BOB }));
  await assertFails(as(HOST).ref(G).set(gameData()));
});

test('game PIN must be 6 digits and a game needs all fields', async () => {
  await assertFails(as(HOST).ref('games/12ab56').set(gameData()));
  await assertFails(as(HOST).ref(G).set({ hostUid: HOST, quizId: 'q', createdAt: TS }));
  await assertFails(as(HOST).ref(G).set({ ...gameData(), extra: 1 }));
});

test('hostUid / quizId / createdAt are immutable', async () => {
  await seed('lobby');
  await assertFails(as(HOST).ref(`${G}/quizId`).set('other'));
  await assertFails(as(HOST).ref(`${G}/hostUid`).set(ALICE));
  await assertFails(as(HOST).ref(`${G}/createdAt`).set(1));
});

test('only the host can delete the game', async () => {
  await seed('ended');
  await assertFails(as(ALICE).ref(G).remove());
  await assertSucceeds(as(HOST).ref(G).remove());
});

test('unauthenticated access is denied', async () => {
  await seed('lobby');
  await assertFails(anon().ref(`${G}/state`).once('value'));
  await assertFails(anon().ref(`${G}/players`).once('value'));
  await assertFails(anon().ref('games/654321').set({ ...gameData(), hostUid: 'x' }));
  await assertFails(anon().ref(`${G}/players/x`).set({ name: 'X', joinedAt: TS, online: true }));
  await assertFails(anon().ref('/').once('value'));
});

test('reads: players see state and players, but not the game root or others\' answers', async () => {
  await seed('question', {}, { answers: { 0: { [BOB]: { choice: 1, at: Date.now() }, [ALICE]: { choice: 2, at: Date.now() } } } });
  await assertSucceeds(as(ALICE).ref(`${G}/state`).once('value'));
  await assertSucceeds(as(ALICE).ref(`${G}/players`).once('value'));
  await assertSucceeds(as(ALICE).ref(`${G}/answers/0/${ALICE}`).once('value'));
  await assertFails(as(ALICE).ref(`${G}/answers/0/${BOB}`).once('value'));
  await assertFails(as(ALICE).ref(`${G}/answers`).once('value'));
  await assertFails(as(ALICE).ref(G).once('value'));
  await assertSucceeds(as(HOST).ref(G).once('value'));
  await assertSucceeds(as(ALICE).ref('games/999999').once('value')); // non-existent PIN can be probed
});

// --- state ---

test('non-host cannot write state; host can', async () => {
  await seed('lobby');
  await assertFails(as(ALICE).ref(`${G}/state/phase`).set('ended'));
  await assertFails(as(ALICE).ref(`${G}/state/correct`).set(0));
  await assertSucceeds(as(HOST).ref(`${G}/state`).update({ phase: 'question', qIndex: 0, startedAt: TS, answerCount: 2, duration: 10000, correct: null }));
  await assertSucceeds(as(HOST).ref(`${G}/state`).update({ phase: 'reveal', correct: 1 }));
});

test('state values are validated', async () => {
  await seed('lobby');
  await assertFails(as(HOST).ref(`${G}/state/phase`).set('party'));
  await assertFails(as(HOST).ref(`${G}/state/answerCount`).set(5));
  await assertFails(as(HOST).ref(`${G}/state/answerCount`).set(1));
  await assertFails(as(HOST).ref(`${G}/state/correct`).set(4)); // answerCount is 4
  await assertFails(as(HOST).ref(`${G}/state/startedAt`).set(Date.now() + 3600_000));
  await assertFails(as(HOST).ref(`${G}/state/secret`).set('x'));
});

// --- players ---

test('player can join in the lobby and mid-game', async () => {
  await seed('lobby');
  await assertSucceeds(as(BOB).ref(`${G}/players/${BOB}`).set({ name: 'Bob', joinedAt: TS, online: true }));
  await env.clearDatabase();
  await seed('question');
  await assertSucceeds(as(BOB).ref(`${G}/players/${BOB}`).set({ name: 'Bob', joinedAt: TS, online: true }));
});

test('player cannot join an ended or missing game', async () => {
  await seed('ended');
  await assertFails(as(BOB).ref(`${G}/players/${BOB}`).set({ name: 'Bob', joinedAt: TS, online: true }));
  await assertFails(as(BOB).ref(`games/999999/players/${BOB}`).set({ name: 'Bob', joinedAt: TS, online: true }));
});

test('player join is validated', async () => {
  await seed('lobby');
  const p = as(BOB).ref(`${G}/players/${BOB}`);
  await assertFails(as(BOB).ref(`${G}/players/${ALICE}x`).set({ name: 'Imposter', joinedAt: TS, online: true }));
  await assertFails(p.set({ name: 'Bob', joinedAt: TS, online: true, score: 5000 }));
  await assertFails(p.set({ name: 'B'.repeat(17), joinedAt: TS, online: true }));
  await assertFails(p.set({ name: '', joinedAt: TS, online: true }));
  await assertFails(p.set({ name: ' Bob', joinedAt: TS, online: true }));
  await assertFails(p.set({ name: 'Bob', joinedAt: 12345, online: true }));
  await assertFails(p.set({ name: 'Bob', joinedAt: TS, online: 'yes' }));
  await assertFails(p.set({ name: 'Bob', joinedAt: TS, online: true, hacked: true }));
  await assertSucceeds(p.set({ name: 'Bob', joinedAt: TS, online: true }));
});

test('player cannot write own score, streak or lastGain; may update online and name', async () => {
  await seed('reveal');
  const me = as(ALICE).ref(`${G}/players/${ALICE}`);
  await assertFails(me.child('score').set(99999));
  await assertFails(me.child('streak').set(10));
  await assertFails(me.child('lastGain').set(1000));
  await assertFails(me.update({ score: null }));
  await assertSucceeds(me.child('online').set(false));
  await assertSucceeds(me.child('name').set('Alicia'));
  await assertFails(me.remove());
});

test('player cannot touch another player', async () => {
  await seed('lobby');
  await assertFails(as(BOB).ref(`${G}/players/${ALICE}/online`).set(false));
  await assertFails(as(BOB).ref(`${G}/players/${ALICE}`).remove());
});

test('host can write scores (multi-path) and kick players', async () => {
  await seed('question');
  await assertSucceeds(
    as(HOST).ref(G).update({
      'state/phase': 'reveal',
      'state/correct': 2,
      [`players/${ALICE}/score`]: 1000,
      [`players/${ALICE}/streak`]: 1,
      [`players/${ALICE}/lastGain`]: 1000,
    }),
  );
  await assertSucceeds(as(HOST).ref(`${G}/players/${ALICE}`).remove());
});

// --- answers ---

const answer = (uid, q = 0, choice = 1) => as(uid).ref(`${G}/answers/${q}/${uid}`).set({ choice, at: TS });

test('player can answer the current question once', async () => {
  await seed('question');
  await assertSucceeds(answer(ALICE));
  await assertFails(answer(ALICE, 0, 2));
  await assertFails(as(ALICE).ref(`${G}/answers/0/${ALICE}`).remove());
});

test('cannot answer the wrong qIndex', async () => {
  await seed('question', { qIndex: 3 });
  await assertFails(answer(ALICE, 2));
  await assertFails(answer(ALICE, 4));
  await assertSucceeds(answer(ALICE, 3));
});

test('cannot answer outside the "question" phase', async () => {
  for (const phase of ['lobby', 'reveal', 'leaderboard', 'ended']) {
    await env.clearDatabase();
    await seed(phase);
    await assertFails(answer(ALICE), phase);
  }
});

test('choice out of range is rejected', async () => {
  await seed('question', { answerCount: 2 });
  await assertFails(answer(ALICE, 0, 2));
  await assertFails(answer(ALICE, 0, -1));
  await assertFails(answer(ALICE, 0, 0.5));
  await assertFails(as(ALICE).ref(`${G}/answers/0/${ALICE}`).set({ choice: '1', at: TS }));
  await assertSucceeds(answer(ALICE, 0, 1));
});

test('answer time must be the server timestamp', async () => {
  await seed('question');
  await assertFails(as(ALICE).ref(`${G}/answers/0/${ALICE}`).set({ choice: 1, at: Date.now() - 5000 }));
  await assertFails(as(ALICE).ref(`${G}/answers/0/${ALICE}`).set({ choice: 1 }));
});

test('cannot answer for someone else or without joining', async () => {
  await seed('question');
  await assertFails(as(BOB).ref(`${G}/answers/0/${ALICE}`).set({ choice: 1, at: TS }));
  await assertFails(answer(BOB));
});
