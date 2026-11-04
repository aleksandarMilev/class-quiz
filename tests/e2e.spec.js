// End-to-end: 1 host + 5 players against the local emulators.
// Run with: npm run test:e2e (starts auth + database emulators; this file starts the static server).
// Uses ONLY tests/fixtures/test-quiz.js (host.html?testQuiz=1), never a real quiz from quizzes/.
import { test, expect } from '@playwright/test';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { applyQuestion, rank } from '../js/scoring.js';
import quiz from './fixtures/test-quiz.js';

const PORT = Number(process.env.E2E_PORT || 5173);
const BASE = `http://127.0.0.1:${PORT}`;
const DB = 'http://127.0.0.1:9000';
const NS = 'demo-klasna-viktorina-default-rtdb';
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const NAMES = ['Ана', 'Борис', 'Вики', 'Гошо', 'Дари'];

/** Reads the emulator database as admin (bypasses rules). */
async function dbGet(path, admin = true) {
  const res = await fetch(`${DB}/${path}.json?ns=${NS}`, { headers: admin ? { Authorization: 'Bearer owner' } : {} });
  return { status: res.status, body: await res.json() };
}

let server;
test.beforeAll(async () => {
  const up = await fetch(`${BASE}/index.html`).then((r) => r.ok).catch(() => false);
  if (up) return; // reuse a server you started yourself (npm run serve)
  server = spawn(process.execPath, [`${ROOT}node_modules/http-server/bin/http-server`, ROOT, '-p', String(PORT), '-a', '127.0.0.1', '-c-1', '--silent'], {
    stdio: 'ignore',
  });
  for (let i = 0; i < 50; i++) {
    if (await fetch(`${BASE}/index.html`).then((r) => r.ok).catch(() => false)) return;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error('static server did not start');
});
test.afterAll(() => server?.kill());

async function noHorizontalOverflow(page) {
  const { scroll, client } = await page.evaluate(() => ({
    scroll: document.documentElement.scrollWidth,
    client: document.documentElement.clientWidth,
  }));
  expect(scroll, `horizontal overflow on ${page.url()}`).toBeLessThanOrEqual(client);
}

test('full game: host + 5 players, reconnects, scoring and cleanup', async ({ browser }) => {
  test.setTimeout(240_000);
  const errors = [];

  // ---- Host creates a game ----
  const hostCtx = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
  const host = await hostCtx.newPage();
  host.on('pageerror', (e) => errors.push(`host: ${e.message}`));
  await host.goto(`${BASE}/host.html?testQuiz=1`);
  await expect(host.locator('[data-screen="setup"]')).toBeVisible();
  await host.selectOption('#quiz-select', 'test-quiz');
  await expect(host.locator('#quiz-meta')).toHaveText('3 въпроса');
  await host.click('#create-btn');
  await expect(host.locator('[data-screen="lobby"]')).toBeVisible();
  const pin = (await host.locator('#pin').textContent()).trim();
  expect(pin).toMatch(/^\d{6}$/);
  await expect(host.locator('#lobby-title')).toHaveText(quiz.title);
  await expect(host.locator('#join-url')).toContainText(`play.html?pin=${pin}`);
  await expect(host.locator('#qr img, #qr canvas').first()).toBeAttached();
  await expect(host.locator('#start-btn')).toBeDisabled();
  expect(new URL(host.url()).searchParams.get('pin')).toBe(pin);

  // Rules are active in the emulator namespace the app uses.
  expect((await dbGet(`games/${pin}`, false)).status).toBe(401);
  expect((await dbGet(`games/${pin}/hostUid`)).body).toBeTruthy();

  // ---- 5 players join on phones ----
  const players = [];
  const openPlayer = async (label) => {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    const page = await ctx.newPage();
    page.on('pageerror', (e) => errors.push(`${label}: ${e.message}`));
    await page.goto(`${BASE}/play.html?pin=${pin}`);
    await expect(page.locator('[data-screen="name"]')).toBeVisible();
    await noHorizontalOverflow(page);
    return { ctx, page };
  };
  const joinAs = async (page, name) => {
    await page.fill('#name-input', name);
    await page.click('#name-btn');
  };

  for (const name of NAMES) {
    const p = await openPlayer(name);
    if (name === NAMES[4]) {
      await joinAs(p.page, 'АНА'); // duplicate of an online player, different case
      await expect(p.page.locator('#name-error')).toHaveText('Това име вече е заето. Избери друго.');
    }
    await joinAs(p.page, name);
    await expect(p.page.locator('#wait-title')).toHaveText('Ти си вътре!');
    await expect(p.page.locator('#wait-text')).toHaveText('Виж името си на екрана.');
    await noHorizontalOverflow(p.page);
    players.push({ name, ...p });
  }
  await expect(host.locator('#player-count')).toHaveText('5');
  for (const name of NAMES) await expect(host.locator('.player-chip', { hasText: name })).toBeVisible();

  // ---- Kick an extra player (inline "Премахни", no confirm dialog) ----
  const extra = await openPlayer('extra');
  await joinAs(extra.page, 'Излишен');
  await expect(host.locator('#player-count')).toHaveText('6');
  await host.locator('.player-chip', { hasText: 'Излишен' }).locator('button.name').click();
  await host.locator('.player-chip', { hasText: 'Излишен' }).locator('.kick').click();
  await expect(extra.page.locator('#error-title')).toHaveText('Беше премахнат от играта');
  await expect(host.locator('#player-count')).toHaveText('5');
  await extra.ctx.close();

  // ---- Play ----
  const uidOf = {};
  const game0 = (await dbGet(`games/${pin}`)).body;
  for (const [id, p] of Object.entries(game0.players)) uidOf[p.name] = id;
  expect(Object.keys(uidOf).sort()).toEqual([...NAMES].sort());

  let expectedPlayers = Object.fromEntries(Object.entries(game0.players).map(([id, p]) => [id, { ...p, score: 0, streak: 0 }]));

  const phase = (name, timeout = 30_000) => expect(host.locator('body')).toHaveAttribute('data-current', name, { timeout });

  /** Each pick is [playerIndex, choice, delayBeforeTapMs]; players not listed don't answer. */
  async function playQuestion(qIndex, picks, { reloadHostMidway = false } = {}) {
    const q = quiz.questions[qIndex];
    await phase('question');
    await expect(host.locator('#q-counter')).toHaveText(`${qIndex + 1} / ${quiz.questions.length}`);
    await expect(host.locator('#q-text')).toHaveText(q.q);
    await expect(host.locator('#q-tiles .tile')).toHaveCount(q.answers.length);
    for (const { page } of players) {
      await expect(page.locator('.answer-btn')).toHaveCount(q.answers.length);
      await expect(page.locator('[data-screen="question"]')).toBeVisible();
      // Phones never show question or answer text.
      await expect(page.locator('body')).not.toContainText(q.q);
      await noHorizontalOverflow(page);
    }
    let answered = 0;
    for (const [i, choice, delay] of picks) {
      if (delay) await players[i].page.waitForTimeout(delay);
      await players[i].page.locator(`.answer-btn[data-choice="${choice}"]`).click();
      await expect(players[i].page.locator('[data-screen="sent"]')).toBeVisible();
      answered++;
      if (answered === 2 && reloadHostMidway) {
        await host.reload();
        await expect(host.locator('#pin')).toHaveText(pin, { useInnerText: false }); // resumed, same game
        await phase('question');
        await expect(host.locator('#q-text')).toHaveText(q.q);
      }
      if (answered < players.length) await expect(host.locator('#answered')).toContainText(`Отговориха: ${answered} /`);
    }
    // Ends automatically: all online players answered, or the timer ran out.
    await phase('reveal', (q.time + 5) * 1000);

    const game = (await dbGet(`games/${pin}`)).body;
    expect(game.state.correct).toBe(q.correct);
    expectedPlayers = Object.fromEntries(
      Object.entries(applyQuestion(expectedPlayers, game.answers?.[qIndex], q, game.state)).map(([id, r]) => [id, { ...expectedPlayers[id], ...r }]),
    );
    for (const [id, p] of Object.entries(expectedPlayers)) {
      expect(game.players[id].score, `score of ${p.name} after q${qIndex + 1}`).toBe(p.score);
      expect(game.players[id].streak).toBe(p.streak);
      expect(game.players[id].lastGain).toBe(p.lastGain);
    }

    // Reveal: correct tile highlighted, chart counts, explanation.
    await expect(host.locator('#r-tiles .tile.correct')).toHaveAttribute('data-index', String(q.correct));
    await expect(host.locator('#explain')).toHaveText(q.explain);
    for (let c = 0; c < q.answers.length; c++) {
      const n = picks.filter(([, choice]) => choice === c).length;
      await expect(host.locator(`#chart .bar[data-index="${c}"]`)).toHaveAttribute('data-count', String(n));
    }

    // Phones: result + rank.
    const ranked = rank(expectedPlayers);
    for (let i = 0; i < players.length; i++) {
      const pick = picks.find(([pi]) => pi === i);
      const me = expectedPlayers[uidOf[players[i].name]];
      const page = players[i].page;
      if (!pick) await expect(page.locator('#result-title')).toHaveText('Времето изтече');
      else if (pick[1] === q.correct) {
        await expect(page.locator('#result-title')).toHaveText('Вярно!');
        await expect(page.locator('#result-gain')).toHaveText(`+${fmt(me.lastGain)}`);
      } else await expect(page.locator('#result-title')).toHaveText('Грешно');
      await expect(page.locator('#result-score')).toHaveText(fmt(me.score));
      const myRank = ranked.find((p) => p.uid === uidOf[players[i].name]).rank;
      await expect(page.locator('#result-rank')).toHaveText(new RegExp(`^Ти си ${myRank}-`));
      await noHorizontalOverflow(page);
    }

    // Leaderboard: top 5, exact order and scores.
    await host.click('#to-leaderboard-btn');
    await phase('leaderboard');
    const rows = host.locator('#leader-list .leader-row');
    await expect(rows).toHaveCount(Math.min(5, ranked.length));
    for (let r = 0; r < Math.min(5, ranked.length); r++) {
      await expect(rows.nth(r)).toHaveAttribute('data-name', ranked[r].name);
      await expect(rows.nth(r)).toHaveAttribute('data-score', String(ranked[r].score));
    }
    for (const { page } of players) await expect(page.locator('#wait-title')).toHaveText('Гледай екрана…');
  }

  const fmt = (n) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');

  await host.click('#start-btn');

  // Q1 (4 answers, correct = 2): different delays, everyone answers → ends early.
  await playQuestion(0, [
    [0, 2, 0],
    [1, 2, 1200],
    [2, 0, 300],
    [3, 2, 1500],
    [4, 1, 200],
  ]);

  // A player reloads mid-game: same anonymous uid, no nickname step.
  await players[1].page.reload();
  await expect(players[1].page.locator('#wait-title')).toHaveText('Гледай екрана…');
  await expect(players[1].page.locator('#p-name')).toHaveText(NAMES[1]);
  await expect(players[1].page.locator('[data-screen="name"]')).toBeHidden();

  await host.click('#next-btn');

  // Q2 (2 answers, correct = 0, 5 s): Гошо never answers → ends on time-out. Host reloads mid-question.
  await playQuestion(
    1,
    [
      [1, 0, 0],
      [0, 0, 400],
      [2, 1, 200],
      [4, 0, 300],
    ],
    { reloadHostMidway: true },
  );
  await host.click('#next-btn');

  // Q3 (3 answers, correct = 1).
  await playQuestion(2, [
    [4, 1, 0],
    [3, 1, 700],
    [0, 0, 300],
    [2, 1, 900],
    [1, 2, 200],
  ]);
  await expect(host.locator('#next-btn')).toHaveText('Към финала');
  await host.click('#next-btn');

  // ---- End ----
  await phase('ended');
  const finalRanked = rank(expectedPlayers);
  const finalRows = host.locator('#final-list li');
  await expect(finalRows).toHaveCount(5);
  for (let r = 0; r < 5; r++) {
    await expect(finalRows.nth(r)).toHaveAttribute('data-name', finalRanked[r].name);
    await expect(finalRows.nth(r)).toHaveAttribute('data-score', String(finalRanked[r].score));
    await expect(finalRows.nth(r)).toHaveAttribute('data-rank', String(finalRanked[r].rank));
  }
  await expect(host.locator('.podium .step-1 .who')).toHaveText(finalRanked[0].name);
  for (const { name, page } of players) {
    const me = finalRanked.find((p) => p.name === name);
    await expect(page.locator('[data-screen="ended"]')).toBeVisible();
    await expect(page.locator('#final-rank')).toHaveAttribute('data-rank', String(me.rank));
    await expect(page.locator('#final-score')).toHaveText(fmt(me.score));
    await noHorizontalOverflow(page);
  }

  // Leaving the end screen deletes the game.
  await host.click('#new-game-btn');
  await expect(host.locator('[data-screen="setup"]')).toBeVisible();
  await expect.poll(async () => (await dbGet(`games/${pin}`)).body, { timeout: 10_000 }).toBeNull();
  // Phones keep showing their final result.
  for (const { page } of players) await expect(page.locator('[data-screen="ended"]')).toBeVisible();

  expect(errors).toEqual([]);
  await hostCtx.close();
  for (const p of players) await p.ctx.close();
});

test('timer off: no countdown, correct answer scores 1000', async ({ browser }) => {
  const hostCtx = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
  const host = await hostCtx.newPage();
  await host.goto(`${BASE}/host.html?testQuiz=1`);
  await host.selectOption('#quiz-select', 'test-quiz');
  await host.locator('#timer-toggle').uncheck();
  await expect(host.locator('#timer-label')).toHaveText('Таймер изкл.');
  await host.click('#create-btn');
  await expect(host.locator('#pin')).toHaveText(/^\d{6}$/);
  const pin = (await host.locator('#pin').textContent()).trim();

  const ctx = await browser.newContext({ viewport: { width: 360, height: 740 } });
  const phone = await ctx.newPage();
  await phone.goto(`${BASE}/play.html?pin=${pin}`);
  await phone.fill('#name-input', 'Соло');
  await phone.click('#name-btn');
  await expect(host.locator('#player-count')).toHaveText('1');
  await host.keyboard.press('Space'); // keyboard shortcut = "Започни"

  await expect(host.locator('[data-screen="question"]')).toBeVisible();
  await expect(host.locator('#ring')).toBeHidden();
  await expect(phone.locator('#timebar')).toBeHidden();
  await phone.waitForTimeout(1500);
  await phone.locator(`.answer-btn[data-choice="${quiz.questions[0].correct}"]`).click();
  await expect(host.locator('[data-screen="reveal"]')).toBeVisible();
  await expect(phone.locator('#result-gain')).toHaveText('+1 000');
  expect(Object.values((await dbGet(`games/${pin}/players`)).body)[0].score).toBe(1000);

  await host.goto(`${BASE}/index.html`); // leave without finishing; clean up directly
  await fetch(`${DB}/games/${pin}.json?ns=${NS}`, { method: 'DELETE', headers: { Authorization: 'Bearer owner' } });
  await hostCtx.close();
  await ctx.close();
});

test('wrong PIN shows a clear message', async ({ browser }) => {
  const ctx = await browser.newContext({ viewport: { width: 360, height: 740 } });
  const page = await ctx.newPage();
  await page.goto(`${BASE}/play.html?pin=000001`);
  await expect(page.locator('#pin-error')).toHaveText('Няма игра с този PIN');
  await noHorizontalOverflow(page);
  await page.goto(`${BASE}/play.html`);
  await expect(page.locator('[data-screen="pin"]')).toBeVisible();
  await ctx.close();
});
