import { installProcessSafetyNet } from "../../src/processSafetyNet.js";

/**
 * The suite runs with the same safety net as `index.ts`.
 *
 * Not a convenience: cancelling a request makes the 7.x client emit a stray
 * `RequestAbortedError` outside any promise chain, which vitest reports as an
 * unhandled error and which would otherwise fail a run whose assertions all
 * passed. Installing the production net here means the tests observe the
 * behaviour the server actually has, rather than a stricter one no deployment
 * runs under.
 *
 * The fatal path is overridden: exiting would kill the vitest worker, and a
 * genuine unhandled error then reads as a crash rather than as a failing run.
 * Marking the exit code lets the runner finish and report it.
 */
installProcessSafetyNet((kind, message) => {
  console.error(`Unhandled ${kind} during the test run: ${message}`);
  process.exitCode = 1;
});
