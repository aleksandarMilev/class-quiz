# Класна викторина

A live classroom quiz game. The teacher runs the **host screen** on the projector; students scan a QR code, enter a nickname and answer on their phones with big colored shape buttons. Scores, streaks and the leaderboard update live.

- Static site: plain HTML/CSS/JS ES modules, no build step, no frameworks. Hosted on GitHub Pages.
- Real-time sync: Firebase Realtime Database + Firebase Anonymous Auth (Firebase JS SDK **13.2.0** loaded from Google's CDN; pinned in `js/firebase.js` only).
- Subject-agnostic: every quiz is one data file in `quizzes/`.
- UI language: Bulgarian. Code, comments and this README: English.

```
index.html          Landing page (Играч / Водещ)
host.html           Projector screen          → js/host.js
play.html           Phone screen              → js/play.js
js/firebase.js      Firebase init; uses the local emulators on localhost / 127.0.0.1
js/firebase-config.js   Your Firebase web config (edit this once)
js/scoring.js       Pure scoring/ranking/quiz-validation functions (unit tested)
js/ui.js            Shapes, colors, escaping, screen switching
quizzes/index.js    Quiz registry (one line per quiz)
quizzes/*.js        Quiz files
database.rules.json Realtime Database security rules
```

---

## 1. Firebase setup (one time, ~10 minutes)

1. Go to <https://console.firebase.google.com> → **Create a project** (any name, e.g. `klasna-viktorina`). Google Analytics is not needed.
2. On the project overview page click the **Web** icon (`</>`) → **Add app**. Give it a nickname, do **not** tick Firebase Hosting → **Register app**.
3. Leave this tab open — you will copy the config in step 6.
4. Left menu → **Build → Realtime Database** → **Create Database** → location **Belgium (`europe-west1`)** → start in **locked mode** → **Enable**.
5. Open the **Rules** tab, delete everything, paste the full contents of [`database.rules.json`](database.rules.json) → **Publish**.
6. ⚙ **Project settings** → **General** → *Your apps* → your web app → **SDK setup and configuration** → **Config**. Copy the values into [`js/firebase-config.js`](js/firebase-config.js) (`apiKey`, `authDomain`, `databaseURL`, `projectId`, `appId`). `databaseURL` must look like `https://<project>-default-rtdb.europe-west1.firebasedatabase.app` — if it is missing from the snippet, reload the page after step 4.
7. Left menu → **Build → Authentication** → **Get started** → **Sign-in method** tab → **Anonymous** → **Enable** → **Save**.
8. **Authentication → Settings → Authorized domains → Add domain** → `<your-github-user>.github.io` (`localhost` is already there).

> Newer console versions may group these pages under **Security** / **Databases** instead of **Build**; the page names are the same.

## 2. Deploy to GitHub Pages

1. Create a GitHub repository (e.g. `klasna-viktorina`) and push this folder to the `main` branch:
   ```bash
   git init
   git add .
   git commit -m "Класна викторина"
   git branch -M main
   git remote add origin https://github.com/<user>/<repo>.git
   git push -u origin main
   ```
2. Repository → **Settings → Pages** → *Build and deployment* → Source **Deploy from a branch** → Branch **`main`** / **`/ (root)`** → **Save**.
3. After a minute the site is live at `https://<user>.github.io/<repo>/`. Host screen: `.../host.html`. All paths are relative, so the sub-folder works.

**About `firebase-config.js`:** these values are public by design (every visitor's browser downloads them). They are not passwords. Security is enforced by `database.rules.json` on Firebase's servers — that's why step 1.5 matters.

## 3. Run locally with the emulators

Requirements: Node.js 22+ and Java 21+ (for the Firebase emulators).

```bash
npm install
npx playwright install chromium      # only needed for the e2e test

# terminal 1: Firebase emulators (auth :9099, database :9000, UI :4000)
npm run emulators

# terminal 2: static server
npm run serve                         # http://127.0.0.1:5173
```

Open <http://127.0.0.1:5173/host.html> and, in other browser windows (or a private window = another player), <http://127.0.0.1:5173/play.html>. On `localhost`/`127.0.0.1` the app always uses the emulators (project `demo-klasna-viktorina`) and ignores `firebase-config.js`, so local testing can never touch your real database.

Tests:

```bash
npm run test:unit    # scoring + every quiz in the registry is valid (no emulator needed)
npm run test:rules   # security rules against the database emulator (starts it automatically)
npm run test:e2e     # Playwright: host + 5 phones, full game (starts emulators + static server)
npm test             # all of the above
```

The e2e test uses only `tests/fixtures/test-quiz.js` (via `host.html?testQuiz=1`, honored only on localhost), so editing or replacing real quizzes never breaks it.

## 4. Add a new quiz in 5 minutes

1. Copy an existing file, e.g. `quizzes/boolean-logic.js` → `quizzes/fractions.js`, and edit it:
   ```js
   export default {
     id: "fractions",                       // same as the file name; a-z, 0-9, "-"
     title: "Дроби (5. клас)",              // shown on the projector
     questions: [
       { q: "Колко е 1/2 + 1/4?", answers: ["3/4", "2/6", "1/6", "2/4"], correct: 0, time: 20, explain: "1/2 = 2/4, а 2/4 + 1/4 = 3/4." },
       // answers: 2–4 items · correct: index starting at 0 · time: seconds · explain: shown after the answer
     ]
   };
   ```
2. Add **one line** to `quizzes/index.js`:
   ```js
   { id: 'fractions', title: 'Дроби (5. клас)', load: () => import('./fractions.js') },
   ```
3. Optional but recommended: `npm run test:unit` checks every registered quiz (2–4 answers, valid `correct`, `time`, matching `id`). The host screen also refuses a broken quiz with a Bulgarian error message.
4. `git add . && git commit -m "Нова викторина" && git push` — GitHub Pages updates in about a minute.

Removing a quiz = delete its file and its line in `quizzes/index.js`. Nothing else references quiz files.

## 5. Before class checklist

- [ ] Open `host.html` on the projector computer **5 minutes early**, pick the quiz, click **Създай игра**.
- [ ] Join with **your own phone** (scan the QR code) to check that everything works, then remove yourself (click your name → **Премахни**).
- [ ] Students' phones must be online: school Wi-Fi or mobile data.
- [ ] Press **F** for fullscreen. **Space/Enter** moves to the next step.
- [ ] Don't close the host tab mid-game. If it reloads by accident, it resumes where it left off.

## 6. Troubleshooting

| Problem | Fix |
|---|---|
| `auth/unauthorized-domain` / „Този адрес не е разрешен…“ | Add `<user>.github.io` in **Authentication → Settings → Authorized domains** (step 1.8). |
| „Анонимният вход не е включен…“ / `auth/operation-not-allowed` | Enable **Anonymous** in **Authentication → Sign-in method** (step 1.7). |
| `permission_denied` in the browser console | The rules were not published, or are outdated: paste `database.rules.json` into **Realtime Database → Rules** and click **Publish**. Also check that `databaseURL` in `firebase-config.js` is your database's URL. |
| „Сайтът не е настроен“ | `js/firebase-config.js` still contains the `TODO` placeholders. |
| QR code opens the wrong URL | The QR encodes `play.html?pin=…` next to the page you opened `host.html` from. Open the host via the GitHub Pages address (`https://<user>.github.io/<repo>/host.html`), not via `localhost` or a local file. |
| Phones say „Няма игра с този PIN“ | The game was deleted (host clicked **Нова игра** or closed the end screen) or the PIN was mistyped. |
| Students see „Няма връзка…“ | Their phone lost internet. The game continues; they reconnect automatically (same player, same score). |
| (Developers, Windows) `Port 9000 is not open … could not start Database Emulator` after running tests | A Java emulator from a previous run is still alive. This happens when `java` on `PATH` is Oracle's `javapath` launcher shim. Put the real JDK first in `PATH` (e.g. `C:\Program Files\Java\jdk-25\bin`) and end the stray `java.exe` in Task Manager. |
| (Developers) `npm warn EBADENGINE` for `@firebase/rules-unit-testing` | v6 declares Node ≥ 24.12 but works on Node 22. Harmless. |

## How it works (short)

- **Data** (`games/{pin}`): `state` (phase, question index, server start time, duration, number of buttons), `players/{uid}` (name, score, streak, last gain, online) and `answers/{qIndex}/{uid}`. PINs are reserved with a transaction, so an existing game is never overwritten.
- **Phones never get question text or the correct answer before the reveal.** They only know how many buttons to show. The correct index is written at reveal time.
- **Timing** uses server timestamps and `.info/serverTimeOffset`; phone clocks are never trusted. Answers arriving more than 0.5 s after the deadline score 0.
- **Scoring** (`js/scoring.js`): correct = 500–1000 points depending on speed (1000 when the timer is off), plus a streak bonus of +100 per consecutive correct answer after the first (max +500). The host computes scores and writes them together with the reveal in one atomic multi-path update.
- **Security rules** enforce: signed-in users only; only the host writes the game state and scores; players create only their own entry and may only change `name`/`online`; each player answers each question once, only while it's open, only with a valid button number and the server's timestamp; anything not listed is rejected.
- **Cleanup:** the game is deleted when the host leaves the end screen or clicks **Нова игра**.
