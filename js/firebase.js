// Firebase bootstrap shared by host and player pages.
// SDK version is pinned here and only here (13.2.0, modular, loaded from Google's CDN).
import { initializeApp } from 'https://www.gstatic.com/firebasejs/13.2.0/firebase-app.js';
import {
  getAuth,
  signInAnonymously,
  onAuthStateChanged,
  connectAuthEmulator,
} from 'https://www.gstatic.com/firebasejs/13.2.0/firebase-auth.js';
import {
  getDatabase,
  connectDatabaseEmulator,
  ref,
  onValue,
} from 'https://www.gstatic.com/firebasejs/13.2.0/firebase-database.js';
import { firebaseConfig } from './firebase-config.js';

export {
  ref,
  child,
  get,
  set,
  update,
  remove,
  onValue,
  onDisconnect,
  runTransaction,
  serverTimestamp,
} from 'https://www.gstatic.com/firebasejs/13.2.0/firebase-database.js';

export const isLocal = ['localhost', '127.0.0.1'].includes(location.hostname);

// Must match the --project flag in package.json scripts. "demo-" projects never touch real Firebase.
const EMULATOR_PROJECT = 'demo-klasna-viktorina';
const emulatorConfig = {
  apiKey: 'demo-api-key',
  authDomain: `${EMULATOR_PROJECT}.firebaseapp.com`,
  databaseURL: `https://${EMULATOR_PROJECT}-default-rtdb.firebaseio.com`,
  projectId: EMULATOR_PROJECT,
  appId: 'demo-app',
};

/** True when js/firebase-config.js still has the placeholder values (only matters when deployed). */
export const configMissing = !isLocal && JSON.stringify(firebaseConfig).includes('TODO');

export const app = initializeApp(isLocal ? emulatorConfig : firebaseConfig);
export const auth = getAuth(app);
export const db = getDatabase(app);

if (isLocal) {
  connectAuthEmulator(auth, 'http://127.0.0.1:9099', { disableWarnings: true });
  connectDatabaseEmulator(db, '127.0.0.1', 9000);
}

/** Resolves with the signed-in user, signing in anonymously if needed. The uid persists across reloads. */
export function signIn() {
  return new Promise((resolve, reject) => {
    const stop = onAuthStateChanged(
      auth,
      (user) => {
        stop();
        if (user) resolve(user);
        else signInAnonymously(auth).then((cred) => resolve(cred.user), reject);
      },
      reject,
    );
  });
}

// Server clock: never trust device clocks for timing.
let serverOffset = 0;
onValue(ref(db, '.info/serverTimeOffset'), (snap) => {
  serverOffset = Number(snap.val()) || 0;
});
export const serverNow = () => Date.now() + serverOffset;

/** Calls cb(true|false) whenever the connection to the database changes. Returns an unsubscribe function. */
export function watchConnection(cb) {
  return onValue(ref(db, '.info/connected'), (snap) => cb(snap.val() === true));
}
