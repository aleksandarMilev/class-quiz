// Used ONLY by tests (host.html?testQuiz=1 on localhost). Never edit real quizzes to fix tests.
export default {
  id: "test-quiz",
  title: "Тестова викторина",
  questions: [
    { q: "Тестов въпрос 1", answers: ["А", "Б", "В", "Г"], correct: 2, time: 15, explain: "Обяснение 1" },
    { q: "Тестов въпрос 2", answers: ["Да", "Не"], correct: 0, time: 5, explain: "Обяснение 2" },
    { q: "Тестов въпрос 3", answers: ["А", "Б", "В"], correct: 1, time: 15, explain: "Обяснение 3" }
  ]
};
