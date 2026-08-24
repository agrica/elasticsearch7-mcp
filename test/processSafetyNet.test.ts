import { describe, expect, it } from "vitest";
import { isLateAbortArtifact } from "../src/processSafetyNet.js";

/**
 * The net has to be narrow. It exists for one known artifact of the 7.x
 * client — a cancelled request reporting itself a second time outside any
 * promise chain — and everything else must still be fatal, or a future bug
 * becomes silence.
 */
describe("isLateAbortArtifact", () => {
  it("recognises the client's abort error by name", () => {
    // Matched on `name`, not on the class: the client does not export it, and
    // instanceof across a duplicated dependency tree is unreliable anyway.
    const error = new Error("Request aborted");
    error.name = "RequestAbortedError";

    expect(isLateAbortArtifact(error)).toBe(true);
  });

  it("lets every other error through as fatal", () => {
    for (const error of [
      new Error("Request aborted"), // right message, wrong name
      Object.assign(new Error("boom"), { name: "ConnectionError" }),
      Object.assign(new Error("nope"), { name: "TypeError" }),
    ]) {
      expect(isLateAbortArtifact(error), `${error.name} must stay fatal`).toBe(false);
    }
  });

  it("does not mistake a non-error for the artifact", () => {
    // An unhandled rejection can carry anything, including a bare string
    // reading "RequestAbortedError".
    for (const value of ["RequestAbortedError", { name: "RequestAbortedError" }, null, undefined]) {
      expect(isLateAbortArtifact(value)).toBe(false);
    }
  });
});
