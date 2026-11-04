// Pure game logic: scoring, ranking and quiz validation.
// No Firebase or DOM imports, so it runs unchanged in the browser and in `node --test`.

export const MAX_POINTS = 1000;
export const MIN_POINTS = 500;
// Answers that reach the server up to this long after the deadline still count.
export const GRACE_MS = 500;

/** Points for one answer (without streak bonus). */
export function pointsFor({ correct, elapsedMs, durationMs, timed }) {
  if (!correct) return 0;
  if (!timed || !(durationMs > 0)) return MAX_POINTS;
  const elapsed = Math.max(0, elapsedMs);
  const raw = Math.round(MAX_POINTS * (1 - elapsed / durationMs / 2));
  return Math.min(MAX_POINTS, Math.max(MIN_POINTS, raw));
}

/** Bonus for `streak` correct answers in a row (streak includes the current answer). */
export function streakBonus(streak) {
  if (!(streak >= 2)) return 0;
  return Math.min(100 * (streak - 1), 500);
}

/** True when a timed answer arrived after the deadline plus grace. */
export function isLate(answer, state) {
  if (!state || !state.timed) return false;
  return answer.at > state.startedAt + state.duration + GRACE_MS;
}

/**
 * Scores one question.
 * @param players  { uid: { score, streak, ... } }
 * @param answers  { uid: { choice, at } } for this question (may be null)
 * @param question { correct, ... } from the quiz file
 * @param state    { startedAt, duration, timed } of this question
 * @returns        { uid: { score, streak, lastGain } } for every player
 */
export function applyQuestion(players, answers, question, state) {
  const result = {};
  for (const [uid, player] of Object.entries(players || {})) {
    const prevScore = Number(player?.score) || 0;
    const prevStreak = Number(player?.streak) || 0;
    const answer = answers?.[uid];
    const counts = answer && typeof answer.choice === 'number' && typeof answer.at === 'number' && !isLate(answer, state);
    const correct = Boolean(counts && answer.choice === question.correct);
    if (!correct) {
      result[uid] = { score: prevScore, streak: 0, lastGain: 0 };
      continue;
    }
    const streak = prevStreak + 1;
    const gain =
      pointsFor({ correct, elapsedMs: answer.at - state.startedAt, durationMs: state.duration, timed: state.timed }) +
      streakBonus(streak);
    result[uid] = { score: prevScore + gain, streak, lastGain: gain };
  }
  return result;
}

/**
 * Sorts players by score (desc, then name) and assigns ranks; ties share a rank (1, 1, 3).
 * Accepts { uid: player } or an array of players.
 */
export function rank(players) {
  const list = Array.isArray(players)
    ? players.map((p) => ({ ...p }))
    : Object.entries(players || {}).map(([uid, p]) => ({ uid, ...p }));
  for (const p of list) p.score = Number(p.score) || 0;
  list.sort((a, b) => b.score - a.score || String(a.name ?? '').localeCompare(String(b.name ?? ''), 'bg'));
  list.forEach((p, i) => {
    p.rank = i > 0 && p.score === list[i - 1].score ? list[i - 1].rank : i + 1;
  });
  return list;
}

/** Checks a quiz object against the documented format. Returns a list of problems (empty = valid). */
export function validateQuiz(quiz) {
  const errors = [];
  if (!quiz || typeof quiz !== 'object') return ['Файлът не експортира обект (export default { ... }).'];
  if (typeof quiz.id !== 'string' || !/^[a-z0-9-]+$/.test(quiz.id)) errors.push('Липсва "id" (малки латински букви, цифри и тирета).');
  if (typeof quiz.title !== 'string' || !quiz.title.trim()) errors.push('Липсва "title".');
  if (!Array.isArray(quiz.questions) || quiz.questions.length === 0) {
    errors.push('Липсват въпроси ("questions").');
    return errors;
  }
  quiz.questions.forEach((q, i) => {
    const n = `Въпрос ${i + 1}`;
    if (typeof q?.q !== 'string' || !q.q.trim()) errors.push(`${n}: липсва текст ("q").`);
    if (!Array.isArray(q?.answers) || q.answers.length < 2 || q.answers.length > 4) {
      errors.push(`${n}: трябва да има от 2 до 4 отговора ("answers").`);
    } else if (q.answers.some((a) => typeof a !== 'string' || !a.trim())) {
      errors.push(`${n}: има празен отговор.`);
    }
    if (!Number.isInteger(q?.correct) || q.correct < 0 || q.correct >= (q?.answers?.length ?? 0)) {
      errors.push(`${n}: "correct" трябва да е номер на отговор (от 0).`);
    }
    if (typeof q?.time !== 'number' || !(q.time >= 3 && q.time <= 600)) errors.push(`${n}: "time" трябва да е секунди (3–600).`);
    if (q?.explain !== undefined && typeof q.explain !== 'string') errors.push(`${n}: "explain" трябва да е текст.`);
  });
  return errors;
}
