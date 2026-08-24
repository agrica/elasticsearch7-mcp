/**
 * An OAuth2 `client_credentials` token, kept fresh.
 *
 * This module knows nothing about Elasticsearch or MCP: it turns a client id and
 * a secret into a bearer token that is currently valid. What it deliberately
 * does *not* do is store anything — `client_credentials` returns no refresh
 * token (RFC 6749 §4.4.3 says one SHOULD NOT be included), so renewing means
 * asking again, and the whole component is one cache and one in-flight promise.
 *
 * The MCP authorization specification is explicit that this is the right shape
 * for a server in this position: "If the MCP server makes requests to upstream
 * APIs, it may act as an OAuth client to them. The access token used at the
 * upstream API is a separate token, issued by the upstream authorization
 * server." A stdio server receives no token from its client, so the accompanying
 * MUST NOT — never pass the client's token through — holds by construction. Do
 * not add a path that forwards a caller-supplied token; that is the token
 * passthrough anti-pattern the same specification forbids.
 */

/** Which of the two form-based client authentication methods to use. */
export type OAuthAuthStyle = "post" | "basic";

export type OAuthConfig = {
  tokenUrl: string;
  clientId: string;
  clientSecret: string;
  scope?: string;
  audience?: string;
  authStyle: OAuthAuthStyle;
};

export type TokenProvider = {
  /** A token that is valid now, fetching or renewing one if needed. */
  access(): Promise<string>;
};

/**
 * The token request's own timeout, deliberately not `ES_REQUEST_TIMEOUT`: the
 * identity provider is a different service from the cluster, and a long
 * Elasticsearch aggregation timeout says nothing about how long a token endpoint
 * should be allowed to hang.
 */
const TOKEN_REQUEST_TIMEOUT_MS = 10_000;

/**
 * Assumed lifetime when the response carries no `expires_in`, which RFC 6749
 * recommends but does not require. Five minutes errs on the side of asking
 * again: the cost of a needless token request is one HTTP round trip, and the
 * cost of serving a dead token is a failed tool call.
 */
const DEFAULT_LIFETIME_SECONDS = 300;

/** Renew this long before expiry — see `marginFor`. */
const MAX_MARGIN_SECONDS = 60;

/**
 * How early to renew.
 *
 * A flat minute would make a 30-second token permanently expired, so the margin
 * never exceeds half the lifetime. Both terms matter: the minute absorbs clock
 * skew between this host and the identity provider, and the half keeps a
 * short-lived token usable.
 */
function marginFor(lifetimeSeconds: number): number {
  return Math.min(MAX_MARGIN_SECONDS, lifetimeSeconds / 2);
}

/** The subset of a token response this code reads. */
type TokenResponse = {
  access_token?: unknown;
  token_type?: unknown;
  expires_in?: unknown;
  error?: unknown;
  error_description?: unknown;
};

/**
 * What an error at the token endpoint is allowed to say.
 *
 * Only the fields RFC 6749 §5.2 defines, plus the status. The response body is
 * never copied: an identity provider that echoes the request parameters back in
 * its error — several do — would otherwise carry the `client_secret` into a tool
 * result, which is to say into the calling model's context.
 */
function describeFailure(
  tokenUrl: string,
  status: number,
  payload: TokenResponse | undefined
): string {
  const code = typeof payload?.error === "string" ? payload.error : undefined;
  const detail =
    typeof payload?.error_description === "string"
      ? payload.error_description
      : undefined;

  return (
    `Token endpoint ${tokenUrl} answered ${status}` +
    (code ? `: ${code}` : "") +
    (detail ? ` (${detail})` : "")
  );
}

/** Parse a JSON body without letting a malformed one mask the status code. */
async function readPayload(
  response: Response
): Promise<TokenResponse | undefined> {
  try {
    return (await response.json()) as TokenResponse;
  } catch {
    return undefined;
  }
}

/**
 * RFC 6749 §2.3.1: for HTTP Basic client authentication both values are
 * form-urlencoded before being base64-encoded. Skipping this is invisible until
 * a secret contains a character that needs escaping, and then it fails as
 * `invalid_client` with nothing pointing at the cause.
 */
function basicCredentials(clientId: string, clientSecret: string): string {
  const encoded = `${encodeURIComponent(clientId)}:${encodeURIComponent(clientSecret)}`;
  return `Basic ${Buffer.from(encoded).toString("base64")}`;
}

export function createTokenProvider(
  config: OAuthConfig,
  now: () => number = Date.now
): TokenProvider {
  let cached: { token: string; expiresAt: number } | undefined;
  let inFlight: Promise<string> | undefined;
  let warnedAboutLifetime = false;

  async function fetchToken(): Promise<string> {
    const body = new URLSearchParams({ grant_type: "client_credentials" });
    if (config.scope) body.set("scope", config.scope);
    if (config.audience) body.set("audience", config.audience);

    const headers: Record<string, string> = {
      "content-type": "application/x-www-form-urlencoded",
      accept: "application/json",
    };

    if (config.authStyle === "basic") {
      headers.authorization = basicCredentials(
        config.clientId,
        config.clientSecret
      );
    } else {
      body.set("client_id", config.clientId);
      body.set("client_secret", config.clientSecret);
    }

    const response = await fetch(config.tokenUrl, {
      method: "POST",
      headers,
      body,
      signal: AbortSignal.timeout(TOKEN_REQUEST_TIMEOUT_MS),
    });

    const payload = await readPayload(response);

    if (!response.ok) {
      throw new Error(describeFailure(config.tokenUrl, response.status, payload));
    }

    const token = payload?.access_token;
    if (typeof token !== "string" || token.length === 0) {
      throw new Error(
        `Token endpoint ${config.tokenUrl} returned no access_token.`
      );
    }

    // A token that is not a bearer must not be sent as one: the request would
    // be rejected with a 401 whose cause is invisible from either end.
    const tokenType =
      typeof payload?.token_type === "string"
        ? payload.token_type.toLowerCase()
        : undefined;
    if (tokenType !== undefined && tokenType !== "bearer") {
      throw new Error(
        `Token endpoint ${config.tokenUrl} issued a "${tokenType}" token; only bearer tokens can be used here.`
      );
    }

    let lifetime = DEFAULT_LIFETIME_SECONDS;
    if (typeof payload?.expires_in === "number" && payload.expires_in > 0) {
      lifetime = payload.expires_in;
    } else if (!warnedAboutLifetime) {
      // stderr, never stdout: stdout carries the MCP protocol. Once, because a
      // provider that omits it omits it every time.
      warnedAboutLifetime = true;
      console.error(
        `Token endpoint ${config.tokenUrl} returned no expires_in; assuming ${DEFAULT_LIFETIME_SECONDS}s.`
      );
    }

    cached = {
      token,
      expiresAt: now() + (lifetime - marginFor(lifetime)) * 1000,
    };

    return token;
  }

  return {
    async access() {
      if (cached && now() < cached.expiresAt) return cached.token;

      // Single-flight. Without it, N tool calls arriving after expiry send N
      // token requests, which some providers rate limit and all of them log.
      if (inFlight) return inFlight;

      inFlight = fetchToken().finally(() => {
        inFlight = undefined;
      });

      return inFlight;
    },
  };
}
