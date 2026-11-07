import {
  db,
  ref,
  get,
  set,
  onValue,
  onDisconnect,
  serverTimestamp,
  signIn,
  serverNow,
  watchConnection,
  configMissing,
} from "./firebase.js";
import { rank } from "./scoring.js";
import {
  $,
  shapeSvg,
  iconSvg,
  showScreen,
  ordinal,
  fmt,
  connectionBanner,
  errorText,
  SHAPE_LABELS,
  COLORS,
} from "./ui.js";

const params = new URLSearchParams(location.search);

let uid = null;
let pin = null;
let state = null;
let players = {};
let me = null;
let joined = false;
let connected = false;
let finished = false;
let reachedEnd = false;
const myAnswers = {};
const pending = {};
const rejected = {};
let myAnswerQ = null;
let stopMyAnswer = null;
let listeners = [];
let gridKey = "";
let deadlineTimer = null;
let frame = null;

init();

async function init() {
  wireUi();
  if (configMissing)
    return message(
      "Сайтът не е настроен",
      "Учителят трябва да попълни js/firebase-config.js.",
    );
  try {
    uid = (await signIn()).uid;
  } catch (err) {
    return message("Неуспешен вход", errorText(err));
  }
  watchConnection(onConnection);
  const fromUrl = params.get("pin");
  if (fromUrl && /^\d{6}$/.test(fromUrl)) openGame(fromUrl);
  else showPin(fromUrl ? "PIN кодът е 6 цифри." : "");
}

function showPin(error = "") {
  $("#pin-error").textContent = error;
  showScreen("pin");
  $("#pin-input").focus();
}

async function openGame(candidate) {
  showScreen("loading");
  let gameState;
  let mine;
  try {
    gameState = (await get(ref(db, `games/${candidate}/state`))).val();
    mine = gameState
      ? (await get(ref(db, `games/${candidate}/players/${uid}`))).val()
      : null;
  } catch (err) {
    return message("Нещо се обърка", errorText(err));
  }
  if (!gameState) {
    $("#pin-input").value = candidate;
    return showPin("Няма игра с този PIN");
  }
  pin = candidate;
  setUrlPin(pin);
  if (mine) return enterGame();
  if (gameState.phase === "ended")
    return message(
      "Играта вече приключи",
      "Изчакай учителя да пусне нова игра.",
      true,
    );
  showScreen("name");
  $("#name-input").focus();
}

async function join(event) {
  event.preventDefault();
  const button = $("#name-btn");
  const error = $("#name-error");
  const name = $("#name-input").value.trim().replace(/\s+/g, " ");
  if (!name) return (error.textContent = "Въведи име.");
  if (name.length > 16) return (error.textContent = "Името е до 16 знака.");
  if (button.disabled) return;
  button.disabled = true;
  error.textContent = "";
  try {
    const all = (await get(ref(db, `games/${pin}/players`))).val() || {};
    const lower = name.toLocaleLowerCase("bg");
    const taken = Object.entries(all).some(
      ([id, p]) =>
        id !== uid &&
        p.online &&
        String(p.name).toLocaleLowerCase("bg") === lower,
    );
    if (taken) {
      error.textContent = "Това име вече е заето. Избери друго.";
      return;
    }
    await set(ref(db, `games/${pin}/players/${uid}`), {
      name,
      joinedAt: serverTimestamp(),
      online: true,
    });
    enterGame();
  } catch (err) {
    const s = await get(ref(db, `games/${pin}/state`))
      .then((x) => x.val())
      .catch(() => null);
    if (!s || s.phase === "ended")
      message(
        "Играта вече приключи",
        "Изчакай учителя да пусне нова игра.",
        true,
      );
    else error.textContent = errorText(err);
  } finally {
    button.disabled = false;
  }
}

function enterGame() {
  joined = true;
  if (connected) goOnline();
  listeners.push(
    onValue(ref(db, `games/${pin}/players`), (snap) => {
      players = snap.val() || {};
      if (!players[uid]) return onMissing();
      me = players[uid];
      render();
    }),
  );
  listeners.push(
    onValue(ref(db, `games/${pin}/state`), (snap) => {
      const next = snap.val();
      if (!next) return onGameGone();
      state = next;
      watchMyAnswer(state.qIndex);
      render();
    }),
  );
}

function onConnection(isConnected) {
  connected = isConnected;
  connectionBanner(isConnected);
  if (isConnected && joined && !finished) goOnline();
}

function goOnline() {
  const onlineRef = ref(db, `games/${pin}/players/${uid}/online`);
  onDisconnect(onlineRef)
    .set(false)
    .then(() => set(onlineRef, true))
    .catch(() => {});
}

function watchMyAnswer(qIndex) {
  if (qIndex === myAnswerQ) return;
  stopMyAnswer?.();
  myAnswerQ = qIndex;
  stopMyAnswer = onValue(
    ref(db, `games/${pin}/answers/${qIndex}/${uid}`),
    (snap) => {
      myAnswers[qIndex] = snap.val();
      render();
    },
  );
}

async function onMissing() {
  if (finished) return;
  const s = await get(ref(db, `games/${pin}/state`))
    .then((x) => x.val())
    .catch(() => null);
  if (s && s.phase !== "ended") {
    stopAll();
    message("Беше премахнат от играта", "Учителят те премахна от тази игра.");
  } else {
    onGameGone();
  }
}

function onGameGone() {
  if (finished) return;
  stopAll();
  if (!reachedEnd) message("Играта приключи", "Учителят затвори играта.", true);
}

function stopAll() {
  finished = true;
  listeners.forEach((stop) => stop());
  listeners = [];
  stopMyAnswer?.();
  stopMyAnswer = null;
  clearTimers();
  if (pin)
    onDisconnect(ref(db, `games/${pin}/players/${uid}/online`))
      .cancel()
      .catch(() => {});
}

function render() {
  if (finished || !state || !me) return;
  $("#p-top").hidden = false;
  $("#p-name").textContent = me.name;
  $("#p-score").textContent = fmt(me.score);
  if (state.phase !== "question") {
    clearTimers();
    gridKey = "";
  }
  switch (state.phase) {
    case "lobby":
      return wait("Ти си вътре!", "Виж името си на екрана.");
    case "question":
      return renderQuestion();
    case "reveal":
      return renderResult();
    case "leaderboard": {
      const mine = myRank();
      return wait(
        "Гледай екрана…",
        mine ? `Ти си ${ordinal(mine.rank)} с ${fmt(mine.score)} точки.` : "",
      );
    }
    case "ended":
      return renderFinal();
  }
}

function renderQuestion() {
  const q = state.qIndex;
  const deadline = state.startedAt + state.duration;
  const timeUp = state.timed && serverNow() >= deadline;
  if (rejected[q]) {
    clearTimers();
    return wait("Твърде късно", "Отговорът не беше приет. Гледай екрана…");
  }
  const choice = myAnswers[q]?.choice ?? pending[q];
  if (choice !== undefined) {
    clearTimers();
    const shape = $("#sent-shape");
    shape.className = `sent-shape c${choice}`;
    shape.innerHTML = shapeSvg(choice);
    return showScreen("sent");
  }
  if (timeUp) {
    clearTimers();
    return wait("Времето изтече", "Гледай екрана…");
  }

  const key = `${q}:${state.answerCount}:${state.startedAt}`;
  if (key !== gridKey) {
    gridKey = key;
    const grid = $("#answer-grid");
    grid.dataset.count = state.answerCount;
    grid.innerHTML = Array.from(
      { length: state.answerCount },
      (_, i) =>
        `<button class="answer-btn c${i}" type="button" data-choice="${i}" aria-label="${SHAPE_LABELS[i]}">${shapeSvg(i)}</button>`,
    ).join("");
    $("#timebar").hidden = !state.timed;
    clearTimers();
    if (state.timed) {
      deadlineTimer = setTimeout(
        render,
        Math.max(0, deadline - serverNow()) + 50,
      );
      const fill = $("#timebar-fill");
      const draw = () => {
        const left = Math.max(0, deadline - serverNow());
        fill.style.transform = `scaleX(${left / state.duration})`;
        if (left > 0) frame = requestAnimationFrame(draw);
      };
      draw();
    }
  }
  showScreen("question");
}

function submit(choice) {
  if (!state || state.phase !== "question") return;
  const q = state.qIndex;
  if (pending[q] !== undefined || myAnswers[q]) return;
  if (state.timed && serverNow() > state.startedAt + state.duration)
    return render();
  pending[q] = choice;
  for (const b of document.querySelectorAll(".answer-btn")) {
    b.disabled = true;
    b.classList.toggle("chosen", Number(b.dataset.choice) === choice);
  }
  set(ref(db, `games/${pin}/answers/${q}/${uid}`), {
    choice,
    at: serverTimestamp(),
  }).catch(() => {
    rejected[q] = true;
    render();
  });
  render();
}

function myRank() {
  return rank(players).find((p) => p.uid === uid);
}

function renderResult() {
  const answer = rejected[state.qIndex] ? null : myAnswers[state.qIndex];
  const gain = Number(me.lastGain) || 0;
  let kind;
  let icon;
  let title;
  let gainText = "";
  if (!answer) {
    [kind, icon, title] = ["none", "clock", "Времето изтече"];
  } else if (answer.choice === state.correct && gain > 0) {
    [kind, icon, title, gainText] = [
      "good",
      "check",
      "Вярно!",
      `+${fmt(gain)}`,
    ];
  } else if (answer.choice === state.correct) {
    [kind, icon, title] = ["none", "clock", "Вярно, но късно"];
  } else {
    [kind, icon, title] = ["bad", "cross", "Грешно"];
  }
  $("#result").className = `result ${kind}`;
  $("#result").dataset.kind = kind;
  $("#result-icon").innerHTML = iconSvg(icon);
  $("#result-title").textContent = title;
  $("#result-gain").textContent = gainText;
  $("#result-gain").hidden = !gainText;
  $("#result-score").textContent = fmt(me.score);
  const mine = myRank();
  $("#result-rank").textContent = mine ? `Ти си ${ordinal(mine.rank)}` : "";
  showScreen("result");
}

function renderFinal() {
  const ranked = rank(players);
  const mine = ranked.find((p) => p.uid === uid);
  if (!mine) return;
  reachedEnd = true;
  $("#final-rank").textContent = ordinal(mine.rank);
  $("#final-rank").dataset.rank = mine.rank;
  $("#final-text").textContent =
    mine.rank === 1 ? "Победител!" : `от ${ranked.length} играчи`;
  $("#final-score").textContent = fmt(mine.score);
  showScreen("ended");
}

function wait(title, text) {
  $("#wait-title").textContent = title;
  $("#wait-text").textContent = text;
  showScreen("wait");
}

function message(title, text, retry = false) {
  $("#p-top").hidden = true;
  $("#error-title").textContent = title;
  $("#error-text").textContent = text;
  $("#error-retry").hidden = !retry;
  $("#error-retry").textContent = "Към началото";
  showScreen("error");
}

function clearTimers() {
  clearTimeout(deadlineTimer);
  cancelAnimationFrame(frame);
  deadlineTimer = null;
  frame = null;
}

function wireUi() {
  $("#wait-shapes").innerHTML = COLORS.map(
    (color, i) => `<span style="color:${color}">${shapeSvg(i, "")}</span>`,
  ).join("");
  $("#pin-form").addEventListener("submit", (e) => {
    e.preventDefault();
    const value = $("#pin-input").value.trim();
    if (!/^\d{6}$/.test(value)) return showPin("PIN кодът е 6 цифри.");
    openGame(value);
  });
  $("#pin-input").addEventListener(
    "input",
    (e) => (e.target.value = e.target.value.replace(/\D/g, "").slice(0, 6)),
  );
  $("#name-form").addEventListener("submit", join);
  $("#answer-grid").addEventListener("click", (e) => {
    const button = e.target.closest(".answer-btn");
    if (button && !button.disabled) submit(Number(button.dataset.choice));
  });
}

function setUrlPin(value) {
  const url = new URL(location.href);
  url.searchParams.set("pin", value);
  history.replaceState(null, "", url);
}
