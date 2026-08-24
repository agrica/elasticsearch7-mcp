import type { Client } from "@elastic/elasticsearch";
import type { TokenProvider } from "./oauth2.js";

/**
 * Where a tool's client comes from.
 *
 * A function rather than a `Client`, because with OAuth2 the answer changes: the
 * bearer token expires, and the client that carries it has to be replaced. Every
 * register module asks for the client per call, so the rotation is invisible to
 * the tools — none of their signatures mentions authentication, and that is the
 * point.
 */
export type ClientSource = () => Promise<Client>;

/**
 * Build the source for this deployment.
 *
 * Without a token provider this is the trivial path: one client, forever, and
 * the promise is already resolved. With one, each token gets a child client.
 *
 * `child()` is what makes rotation cheap, and it is worth knowing why rather
 * than trusting it: the 7.17 client's `child()` shares the parent's connection
 * pool *and* copies the product-check symbol (`index.js:260-288`), so a child
 * opens no new sockets and does not repeat the `GET /` the 7.x client uses to
 * validate the cluster. Passing `auth` to it becomes an `Authorization` header
 * on the child's transport, which wins over the shared connection's own header —
 * `Transport.js:390` then `Connection.js:261` both let the more specific headers
 * through. So a bearer child works even when the parent carries an API key.
 *
 * The alternatives were worse. Rebuilding the client from scratch each rotation
 * loses keep-alive and repeats the product check. Injecting the header per
 * request through a Proxy cannot work cleanly: the token is only available
 * asynchronously, while the 7.x client's methods return an abortable promise
 * synchronously, so cancellation would have to be faked.
 */
export function createClientSource(
  base: Client,
  tokens?: TokenProvider
): ClientSource {
  if (!tokens) return async () => base;

  let current: { token: string; client: Client } | undefined;

  return async () => {
    const token = await tokens.access();

    // Memoised on the token string: a child per rotation, not per call.
    if (!current || current.token !== token) {
      current = { token, client: base.child({ auth: { bearer: token } }) };
    }

    return current.client;
  };
}
