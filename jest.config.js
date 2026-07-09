/** @type {import('jest').Config} */
module.exports = {
  preset: "ts-jest",
  testEnvironment: "node",
  roots: ["<rootDir>/src"],
  testMatch: ["**/*.test.ts"],
  // bcrypt (work factor 12) in test setup + cold DB connections make the
  // default 5s hook timeout flaky.
  testTimeout: 30000,
};
