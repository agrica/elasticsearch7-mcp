import type { Client } from "@elastic/elasticsearch";
import { abortable } from "./abortable.js";

/**
 * A view of the Elasticsearch client whose requests are aborted when the MCP
 * client cancels the call.
 *
 * Binding cancellation to the *client* rather than threading an `AbortSignal`
 * through every tool is deliberate. There are twenty-six tool functions, and
 * `src/server.ts` re-exports all of them as this package's library surface:
 * adding a trailing `signal` parameter to each would change every public
 * signature, every test call and `scripts/smoke.mjs`, to express one thing —
 * "this request belongs to a call that can be cancelled". That belongs to the
 * client the tool was handed, not to its argument list.
 *
 * The consequence to know: a tool reached through this wrapper cancels, and a
 * tool handed the bare client does not. The register modules are the only place
 * that decides, which is why the wrapping happens there and nowhere else.
 */
export function withCancellation(client: Client, signal: AbortSignal): Client {
  return wrap(client, signal, 0) as Client;
}

/** A promise from a 7.x client call: awaitable, and abortable mid-flight. */
function isAbortable(value: unknown): value is Promise<unknown> & {
  abort: () => void;
} {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { then?: unknown }).then === "function" &&
    typeof (value as { abort?: unknown }).abort === "function"
  );
}

function wrap<T extends object>(target: T, signal: AbortSignal, depth: number): T {
  return new Proxy(target, {
    get(obj, property) {
      // `obj`, not the proxy, is the receiver: a getter or a method that uses
      // `this` then sees the real client. That is what keeps the client's own
      // internals — transport, connection pool, serializer — entirely
      // unproxied, and this wrapper a view rather than a reimplementation.
      const value = Reflect.get(obj, property);

      if (typeof value === "function") {
        return (...args: unknown[]) => {
          const result = (value as (...a: unknown[]) => unknown).apply(obj, args);
          // Not every method returns a request: `close()` yields a plain
          // promise, with nothing to abort.
          return isAbortable(result) ? abortable(result, signal) : result;
        };
      }

      // The API lives in namespaces — indices, cat, cluster, tasks — so the
      // wrapper has to follow them one level down. The depth cap is a
      // safeguard, not a requirement: a property returning the client itself
      // would otherwise recurse without end.
      if (value !== null && typeof value === "object" && depth < 3) {
        return wrap(value, signal, depth + 1);
      }

      return value;
    },
  });
}
