// Quiz registry. To add a quiz: create quizzes/<id>.js and add one line below.
// Quizzes are loaded lazily, only when the host picks one.
export default [
  { id: 'boolean-logic', title: 'Булева логика (8. клас)', load: () => import('./boolean-logic.js') },
];
