// Host (projector) logic. The database `state` node is the single source of truth:
// host actions write to it and the screen re-renders from it, which makes refresh/resume free.
import {
  db,
  ref,
  get,
  update,
  remove,
  onValue,
  onDisconnect,
  runTransaction,
  serverTimestamp,
  signIn,
  serverNow,
  watchConnection,
  isLocal,
  configMissing,
} from './firebase.js';
import { applyQuestion, rank, validateQuiz, GRACE_MS } from './scoring.js';
import { $, esc, shapeSvg, showScreen, fmt, connectionBanner, prefersReducedMotion, errorText } from './ui.js';
import registry from '../quizzes/index.js';

const params = new URLSearchParams(location.search);
// Test-only quiz, injected on localhost with ?testQuiz=1 so e2e tests never depend on real quizzes.
const TEST_QUIZ = { id: 'test-quiz', title: 'Тестова викторина', load: () => import('../tests/fixtures/test-quiz.js') };
const quizzes = isLocal && params.get('testQuiz') === '1' ? [TEST_QUIZ, ...registry] : registry;

const PIN_KEY = 'klasna-viktorina:host-pin';
const LAST_QUIZ_KEY = 'klasna-viktorina:last-quiz';
const RING_LENGTH = 2 * Math.PI * 52;

let uid = null;
let pin = null;
let gameRef = null;
let quiz = null;
let state = null;
let players = {};
let answers = {}; // answers of question `answersQ`
let answersQ = null;
let stopAnswers = null;
let listeners = [];
let shown = ''; // "phase:qIndex" currently on screen
let selectedUid = null; // lobby: chip showing the "Премахни" button
let ending = false; // guards endQuestion() against double runs
let busy = false; // guards the next-step buttons against double clicks
let questionTimer = null;
let frame = null;
let stopConfetti = null;
let wakeLock = null;

init();

async function init() {
  wireUi();
  if (configMissing) return fail('Сайтът не е настроен', 'Попълни js/firebase-config.js с данните от твоя Firebase проект (виж README).');
  try {
    uid = (await signIn()).uid;
  } catch (err) {
    return fail('Неуспешен вход', errorText(err));
  }
  watchConnection(connectionBanner);
  requestWakeLock();

  const resumePin = params.get('pin') || sessionStorage.getItem(PIN_KEY);
  if (resumePin && (await resume(resumePin))) return;
  showSetup();
}

// ---------- Setup ----------

function showSetup(notice = '') {
  const select = $('#quiz-select');
  select.innerHTML = quizzes.map((q) => `<option value="${esc(q.id)}">${esc(q.title)}</option>`).join('');
  const last = safeStorage(() => localStorage.getItem(LAST_QUIZ_KEY));
  if (last && quizzes.some((q) => q.id === last)) select.value = last;
  $('#setup-error').textContent = notice;
  showScreen('setup');
  describeQuiz();
}

async function describeQuiz() {
  const entry = quizzes.find((q) => q.id === $('#quiz-select').value);
  $('#quiz-meta').textContent = '';
  if (!entry) return;
  try {
    const q = (await entry.load()).default;
    const n = q?.questions?.length ?? 0;
    if ($('#quiz-select').value === entry.id) $('#quiz-meta').textContent = `${n} ${n === 1 ? 'въпрос' : 'въпроса'}`;
  } catch {
    /* reported on create */
  }
}

async function loadQuiz(entry) {
  let q;
  try {
    q = (await entry.load()).default;
  } catch (err) {
    throw new Error(`Файлът на викторината не се зарежда: ${err.message}`);
  }
  const errors = validateQuiz(q);
  if (errors.length) throw new Error(`Грешка във викторината „${entry.title}“: ${errors.slice(0, 3).join(' ')}`);
  return q;
}

async function createGame(event) {
  event.preventDefault();
  const button = $('#create-btn');
  const entry = quizzes.find((q) => q.id === $('#quiz-select').value);
  if (!entry || button.disabled) return;
  button.disabled = true;
  $('#setup-error').textContent = '';
  try {
    const q = await loadQuiz(entry);
    const timed = $('#timer-toggle').checked;
    const newPin = await reservePin(entry.id, q, timed);
    safeStorage(() => localStorage.setItem(LAST_QUIZ_KEY, entry.id));
    quiz = q;
    attach(newPin);
  } catch (err) {
    $('#setup-error').textContent = err.code ? errorText(err) : err.message;
  } finally {
    button.disabled = false;
  }
}

/** Creates games/{pin} with a transaction so an existing game is never overwritten. */
async function reservePin(quizId, q, timed) {
  for (let attempt = 0; attempt < 20; attempt++) {
    const candidate = String(100000 + (crypto.getRandomValues(new Uint32Array(1))[0] % 900000));
    const game = {
      hostUid: uid,
      quizId,
      createdAt: serverTimestamp(),
      state: { phase: 'lobby', qIndex: 0, answerCount: q.questions[0].answers.length, duration: 0, timed },
    };
    try {
      const result = await runTransaction(ref(db, `games/${candidate}`), (current) => (current === null ? game : undefined), {
        applyLocally: false,
      });
      if (result.committed && result.snapshot.child('hostUid').val() === uid) return candidate;
    } catch (err) {
      // Someone else's game lives at this PIN (we can't even read it) → try another PIN.
      if (!String(err?.code || err?.message).toLowerCase().includes('permission')) throw err;
    }
  }
  throw new Error('Не успях да създам игра. Опитай пак.');
}

// ---------- Attach / resume ----------

async function resume(candidate) {
  if (!/^\d{6}$/.test(candidate)) return false;
  let game = null;
  try {
    game = (await get(ref(db, `games/${candidate}`))).val();
  } catch {
    game = null; // permission denied: not our game
  }
  if (!game || game.hostUid !== uid) {
    forgetPin();
    return false;
  }
  const entry = quizzes.find((q) => q.id === game.quizId);
  if (!entry) {
    fail('Викторината липсва', `Играта използва викторина „${game.quizId}“, която я няма в quizzes/index.js.`);
    return true;
  }
  try {
    quiz = await loadQuiz(entry);
  } catch (err) {
    fail('Грешка във викторината', err.message);
    return true;
  }
  attach(candidate);
  return true;
}

function attach(newPin) {
  detach();
  pin = newPin;
  gameRef = ref(db, `games/${pin}`);
  safeStorage(() => sessionStorage.setItem(PIN_KEY, pin));
  setUrlPin(pin);
  renderJoinInfo();
  listeners.push(
    onValue(ref(db, `games/${pin}/players`), (snap) => {
      players = snap.val() || {};
      if (selectedUid && !players[selectedUid]) selectedUid = null;
      render();
    }),
  );
  listeners.push(
    onValue(
      ref(db, `games/${pin}/state`),
      (snap) => onState(snap.val()),
      () => onState(null),
    ),
  );
}

function detach() {
  listeners.forEach((stop) => stop());
  listeners = [];
  watchAnswers(null);
  clearTimers();
  stopConfetti?.();
  pin = null;
  gameRef = null;
  state = null;
  players = {};
  shown = '';
  selectedUid = null;
  ending = false;
}

function forgetPin() {
  safeStorage(() => sessionStorage.removeItem(PIN_KEY));
  setUrlPin(null);
}

function onState(next) {
  if (!next) {
    // The game was deleted (by us on "Нова игра", or elsewhere).
    if (pin) {
      detach();
      forgetPin();
      showSetup('Играта беше изтрита.');
    }
    return;
  }
  state = next;
  watchAnswers(state.phase === 'question' || state.phase === 'reveal' ? state.qIndex : null);
  render();
}

function watchAnswers(qIndex) {
  if (qIndex === answersQ) return;
  stopAnswers?.();
  stopAnswers = null;
  answers = {};
  answersQ = qIndex;
  if (qIndex === null) return;
  stopAnswers = onValue(ref(db, `games/${pin}/answers/${qIndex}`), (snap) => {
    answers = snap.val() || {};
    render();
  });
}

// ---------- Rendering ----------

function render() {
  if (!state || !quiz) return;
  const key = `${state.phase}:${state.qIndex}`;
  const entering = key !== shown;
  shown = key;
  if (state.phase !== 'question') clearTimers();
  switch (state.phase) {
    case 'lobby':
      renderLobby();
      break;
    case 'question':
      renderQuestion(entering);
      break;
    case 'reveal':
      renderReveal();
      break;
    case 'leaderboard':
      renderLeaderboard();
      break;
    case 'ended':
      renderEnd(entering);
      break;
  }
  if (entering) {
    showScreen(state.phase);
    if (document.activeElement instanceof HTMLButtonElement) document.activeElement.blur();
  }
}

function renderJoinInfo() {
  const joinUrl = new URL(`play.html?pin=${pin}`, location.href).href;
  $('#pin').textContent = pin;
  $('#join-url').textContent = joinUrl.replace(/^https?:\/\//, '');
  const box = $('#qr');
  box.innerHTML = '';
  if (window.QRCode) {
    new window.QRCode(box, {
      text: joinUrl,
      width: 640,
      height: 640,
      colorDark: '#1a1340',
      colorLight: '#ffffff',
      correctLevel: window.QRCode.CorrectLevel.M,
    });
    box.title = joinUrl;
  } else {
    box.hidden = true;
  }
}

function playerEntries() {
  return Object.entries(players).sort(([, a], [, b]) => (a.joinedAt || 0) - (b.joinedAt || 0));
}

function renderLobby() {
  $('#lobby-title').textContent = quiz.title;
  const entries = playerEntries();
  $('#player-list').innerHTML = entries
    .map(
      ([id, p]) => `<li class="player-chip${p.online ? '' : ' offline'}" data-uid="${esc(id)}">
        <button class="name" type="button" aria-expanded="${selectedUid === id}">${esc(p.name)}</button>
        ${selectedUid === id ? '<button class="kick" type="button">Премахни</button>' : ''}
      </li>`,
    )
    .join('');
  $('#player-count').textContent = entries.length;
  $('#player-count-label').textContent = entries.length === 1 ? 'играч' : 'играчи';
  $('#start-btn').disabled = entries.length === 0;
  $('#lobby-empty').hidden = entries.length > 0;
}

function tilesHtml(question, correct = null) {
  return question.answers
    .map(
      (text, i) => `<div class="tile c${i}${i === correct ? ' correct' : ''}" data-index="${i}">
        ${shapeSvg(i)}<span class="tile-text">${esc(text)}</span>${i === correct ? '<span class="tile-mark" aria-label="верен отговор">✓</span>' : ''}
      </div>`,
    )
    .join('');
}

function counterText() {
  return `${state.qIndex + 1} / ${quiz.questions.length}`;
}

function progressWidth() {
  return `${((state.qIndex + 1) / quiz.questions.length) * 100}%`;
}

/** Players who should answer: online players plus anyone who already answered. */
function answerStats() {
  const ids = Object.keys(players);
  const answered = ids.filter((id) => answers[id]);
  const expected = ids.filter((id) => players[id].online || answers[id]);
  const online = ids.filter((id) => players[id].online);
  return { answered: answered.length, expected: expected.length, allAnswered: online.length > 0 && online.every((id) => answers[id]) };
}

function renderQuestion(entering) {
  const question = quiz.questions[state.qIndex];
  if (entering) {
    ending = false;
    $('#q-counter').textContent = counterText();
    $('#q-progress').style.width = progressWidth();
    $('#q-text').textContent = question.q;
    $('#q-tiles').innerHTML = tilesHtml(question);
    $('#ring').hidden = !state.timed;
  }
  const stats = answerStats();
  $('#answered').textContent = `Отговориха: ${stats.answered} / ${stats.expected}`;
  if (state.timed) startCountdown();
  if (answersQ === state.qIndex && stats.allAnswered) endQuestion();
}

function startCountdown() {
  clearTimers();
  const deadline = state.startedAt + state.duration;
  const ringFg = $('#ring-fg');
  ringFg.style.strokeDasharray = RING_LENGTH;
  const draw = () => {
    const left = Math.max(0, deadline - serverNow());
    const seconds = Math.ceil(left / 1000);
    $('#ring-text').textContent = seconds;
    ringFg.style.strokeDashoffset = RING_LENGTH * (1 - left / state.duration);
    $('#ring').classList.toggle('low', seconds <= 5);
    if (left > 0) frame = requestAnimationFrame(draw);
  };
  draw();
  // Wait for the grace period so answers sent at the last moment still arrive.
  questionTimer = setTimeout(endQuestion, Math.max(0, deadline - serverNow()) + GRACE_MS + 150);
}

function clearTimers() {
  clearTimeout(questionTimer);
  cancelAnimationFrame(frame);
  questionTimer = null;
  frame = null;
}

function renderReveal() {
  const question = quiz.questions[state.qIndex];
  const correct = state.correct ?? question.correct;
  $('#r-counter').textContent = counterText();
  $('#r-progress').style.width = progressWidth();
  $('#r-text').textContent = question.q;
  $('#r-tiles').innerHTML = tilesHtml(question, correct);
  $('#explain').textContent = question.explain || '';
  $('#explain').hidden = !question.explain;

  const counts = question.answers.map(() => 0);
  for (const a of Object.values(answers)) if (counts[a.choice] !== undefined) counts[a.choice]++;
  const max = Math.max(1, ...counts);
  $('#chart').innerHTML = counts
    .map(
      (n, i) => `<div class="bar${i === correct ? '' : ' dim'}" data-index="${i}" data-count="${n}">
        <span class="bar-count">${n}</span>
        <div class="bar-fill c${i}" style="height:${(n / max) * 100}%"></div>
        <div class="bar-base c${i}">${shapeSvg(i)}${i === correct ? '<span class="sr-only">верен</span>' : ''}</div>
      </div>`,
    )
    .join('');
  const right = Object.entries(answers).filter(([id, a]) => players[id] && a.choice === correct).length;
  $('#r-answered').textContent = `Верни: ${right} / ${Object.keys(players).length}`;
}

function renderLeaderboard() {
  const top = rank(players).slice(0, 5);
  $('#leader-list').innerHTML = top.length
    ? top
        .map(
          (p) => `<li class="leader-row${p.rank === 1 ? ' first' : ''}" data-uid="${esc(p.uid)}" data-name="${esc(p.name)}" data-score="${p.score}" data-rank="${p.rank}">
            <span class="r">${p.rank}</span><span class="n">${esc(p.name)}</span>
            <span class="g">${p.lastGain ? `+${fmt(p.lastGain)}` : ''}</span><span class="s">${fmt(p.score)}</span>
          </li>`,
        )
        .join('')
    : '<li class="hint">Няма играчи.</li>';
  const last = state.qIndex >= quiz.questions.length - 1;
  $('#next-btn').textContent = last ? 'Към финала' : 'Следващ въпрос';
}

function renderEnd(entering) {
  const ranked = rank(players);
  $('#end-title').textContent = ranked.length ? 'Край на играта!' : 'Край';
  const podium = [ranked[1], ranked[0], ranked[2]];
  $('#podium').innerHTML = podium
    .map((p, slot) =>
      p
        ? `<div class="step step-${[2, 1, 3][slot]}">
            <span class="who">${esc(p.name)}</span><span class="pts">${fmt(p.score)}</span>
            <div class="block">${p.rank}</div>
          </div>`
        : '<div class="step"></div>',
    )
    .join('');
  $('#final-list').innerHTML = ranked
    .map(
      (p) => `<li data-uid="${esc(p.uid)}" data-name="${esc(p.name)}" data-score="${p.score}" data-rank="${p.rank}">
        <span>${p.rank}.</span><span class="n">${esc(p.name)}</span><b>${fmt(p.score)}</b>
      </li>`,
    )
    .join('');
  if (entering) {
    // The game is over: make sure its data disappears even if the tab is simply closed.
    onDisconnect(gameRef).remove().catch(() => {});
    startConfetti();
  }
}

// ---------- Host actions ----------

async function startGame() {
  if (state?.phase !== 'lobby' || !Object.keys(players).length) return;
  await step(() => openQuestion(0));
}

function openQuestion(i) {
  const question = quiz.questions[i];
  return update(ref(db, `games/${pin}/state`), {
    phase: 'question',
    qIndex: i,
    startedAt: serverTimestamp(),
    duration: state.timed ? question.time * 1000 : 0,
    answerCount: question.answers.length,
    correct: null,
  });
}

/** Ends the current question: scores every player and reveals the answer in ONE multi-path update. */
async function endQuestion() {
  if (ending || state?.phase !== 'question') return;
  ending = true;
  clearTimers();
  const qIndex = state.qIndex;
  const question = quiz.questions[qIndex];
  try {
    const latest = (await get(ref(db, `games/${pin}/answers/${qIndex}`))).val() || {};
    const scored = applyQuestion(players, latest, question, state);
    const changes = { 'state/phase': 'reveal', 'state/correct': question.correct };
    for (const [id, r] of Object.entries(scored)) {
      changes[`players/${id}/score`] = r.score;
      changes[`players/${id}/streak`] = r.streak;
      changes[`players/${id}/lastGain`] = r.lastGain;
    }
    await update(gameRef, changes);
  } catch (err) {
    console.error(err);
    ending = false; // allow a retry via the button
  }
}

async function next() {
  if (!state) return;
  if (state.phase === 'reveal') {
    await step(() => update(ref(db, `games/${pin}/state`), { phase: 'leaderboard' }));
  } else if (state.phase === 'leaderboard') {
    const nextIndex = state.qIndex + 1;
    await step(() =>
      nextIndex < quiz.questions.length ? openQuestion(nextIndex) : update(ref(db, `games/${pin}/state`), { phase: 'ended' }),
    );
  }
}

async function step(action) {
  if (busy) return;
  busy = true;
  try {
    await action();
  } catch (err) {
    console.error(err);
  } finally {
    busy = false;
  }
}

async function newGame() {
  const oldRef = gameRef;
  detach();
  forgetPin();
  showSetup();
  if (oldRef) await remove(oldRef).catch(() => {});
}

function kick(playerUid) {
  selectedUid = null;
  remove(ref(db, `games/${pin}/players/${playerUid}`)).catch((err) => console.error(err));
}

// ---------- Wiring, keyboard, fullscreen, wake lock ----------

function wireUi() {
  $('#setup-form').addEventListener('submit', createGame);
  $('#quiz-select').addEventListener('change', describeQuiz);
  $('#timer-toggle').addEventListener('change', (e) => {
    $('#timer-label').textContent = e.target.checked ? 'Таймер вкл.' : 'Таймер изкл.';
  });
  $('#start-btn').addEventListener('click', startGame);
  $('#reveal-btn').addEventListener('click', endQuestion);
  $('#to-leaderboard-btn').addEventListener('click', next);
  $('#next-btn').addEventListener('click', next);
  $('#new-game-btn').addEventListener('click', newGame);
  $('#fullscreen-btn').addEventListener('click', toggleFullscreen);

  $('#player-list').addEventListener('click', (e) => {
    const chip = e.target.closest('.player-chip');
    if (!chip) return;
    if (e.target.closest('.kick')) return kick(chip.dataset.uid);
    selectedUid = selectedUid === chip.dataset.uid ? null : chip.dataset.uid;
    renderLobby();
  });

  document.addEventListener('keydown', (e) => {
    if (e.target.closest?.('input, select, textarea, button, a') || e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.code === 'KeyF') {
      e.preventDefault();
      toggleFullscreen();
    } else if (e.code === 'Space' || e.key === 'Enter') {
      const button = $(`[data-screen="${document.body.dataset.current}"] [data-primary]`);
      if (button && !button.disabled) {
        e.preventDefault();
        button.click();
      }
    }
  });

  // Leaving the end screen (closing/navigating away) deletes the finished game.
  addEventListener('pagehide', () => {
    if (state?.phase === 'ended' && gameRef) remove(gameRef).catch(() => {});
  });
}

function toggleFullscreen() {
  if (document.fullscreenElement) document.exitFullscreen?.().catch(() => {});
  else document.documentElement.requestFullscreen?.().catch(() => {});
}

async function requestWakeLock() {
  try {
    wakeLock = await navigator.wakeLock?.request('screen');
  } catch {
    /* not supported or denied: ignore */
  }
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && (!wakeLock || wakeLock.released)) requestWakeLock();
});

// ---------- Helpers ----------

function setUrlPin(value) {
  const url = new URL(location.href);
  if (value) url.searchParams.set('pin', value);
  else url.searchParams.delete('pin');
  history.replaceState(null, '', url);
}

function fail(title, text) {
  $('#error-title').textContent = title;
  $('#error-text').textContent = text;
  showScreen('error');
}

function safeStorage(fn) {
  try {
    return fn();
  } catch {
    return null;
  }
}

function startConfetti() {
  stopConfetti?.();
  if (prefersReducedMotion()) return;
  const canvas = $('#confetti');
  const ctx = canvas.getContext('2d');
  const colors = ['#e2364b', '#2f6fe0', '#e8a417', '#1f9e5a', '#ffffff', '#f5c542'];
  const resize = () => {
    canvas.width = innerWidth * devicePixelRatio;
    canvas.height = innerHeight * devicePixelRatio;
  };
  resize();
  addEventListener('resize', resize);
  const pieces = Array.from({ length: 180 }, () => ({
    x: Math.random() * canvas.width,
    y: -Math.random() * canvas.height,
    w: (6 + Math.random() * 8) * devicePixelRatio,
    h: (10 + Math.random() * 10) * devicePixelRatio,
    vy: (2 + Math.random() * 3) * devicePixelRatio,
    vx: (Math.random() - 0.5) * 2 * devicePixelRatio,
    a: Math.random() * Math.PI,
    va: (Math.random() - 0.5) * 0.2,
    color: colors[Math.floor(Math.random() * colors.length)],
  }));
  const until = performance.now() + 7000;
  let id;
  const tickFrame = (now) => {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    for (const p of pieces) {
      p.x += p.vx;
      p.y += p.vy;
      p.a += p.va;
      if (p.y > canvas.height && now < until) p.y = -p.h;
      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.rotate(p.a);
      ctx.fillStyle = p.color;
      ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h);
      ctx.restore();
    }
    if (now < until + 4000) id = requestAnimationFrame(tickFrame);
    else stopConfetti();
  };
  id = requestAnimationFrame(tickFrame);
  stopConfetti = () => {
    cancelAnimationFrame(id);
    removeEventListener('resize', resize);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    stopConfetti = null;
  };
}

// Local-only debugging aid for tests (never used on GitHub Pages).
if (isLocal) window.__host = { get pin() { return pin; }, get state() { return state; } };
