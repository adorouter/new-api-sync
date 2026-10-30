import { paceUpstreamRequest } from "@core/infra/concurrency";
import { FetchError, ofetch } from "ofetch";
import { t } from "@server/i18n";
import { withRetry } from "./retry";

// A bare "HTTP 403" names neither the host nor the route, so a failing run gives
// no way to tell our own gateway from an upstream. Query strings can carry keys,
// so only origin + path is reported.
function redactUrl(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return url;
  }
}

interface FetchOptions {
  headers?: Record<string, string>;
  method?: string;
  body?: unknown;
  timeoutMs?: number;
  retry?: number;
  retryDelayMs?: number;
  onHeaders?: (headers: Headers) => void;
}

export type FetchResult<T> =
  | { ok: true; data: T }
  | {
      ok: false;
      status: number | undefined;
      message: string;
      retryAfterMs?: number;
    };

// Same statuses ofetch retries on; a missing status is a network error or timeout.
const RETRY_STATUS = new Set([408, 409, 425, 429, 500, 502, 503, 504]);
const MAX_429_BACKOFF_MS = 60_000;

// Keeps the HTTP status so a caller can tell "route does not exist" (404)
// from "refused" or "unreachable"; the other two helpers flatten it.
export async function fetchJsonResult<T>(
  url: string,
  options?: FetchOptions,
): Promise<FetchResult<T>> {
  const attempts = (options?.retry ?? 0) + 1;
  const delay = options?.retryDelayMs ?? 0;
  return withRetry(
    () => fetchOnce<T>(url, options),
    (r) => r.ok,
    {
      attempts,
      // 429 doubles per attempt and honours Retry-After: a7 throttles key reveal
      // and pin for tens of seconds, three quick retries just burn the budget.
      // Capped at a minute: uncapped, eight retries on one token create waited
      // 1,020 s, and four such rounds were 80 of a 107 minute walk.
      backoffMs: (attempt, last) =>
        last.ok
          ? 0
          : last.status === 429
            ? Math.max(
                Math.min(delay * 2 ** (attempt - 1), MAX_429_BACKOFF_MS),
                last.retryAfterMs ?? 0,
              )
            : delay,
      shouldRetry: (r) =>
        !r.ok && (r.status === undefined || RETRY_STATUS.has(r.status)),
    },
  );
}

const MAX_REDIRECTS = 5;

// Upstreams get our keys, so a redirect is followed only on the same host
// (TheGrid answers 307 to a signed /r/ path on its own host).
function sameHostRedirect(
  from: string,
  location: string | null,
): string | null {
  if (!location) return null;
  const source = new URL(from);
  const target = new URL(location, source);
  if (target.hostname !== source.hostname) return null;
  if (source.protocol === "https:" && target.protocol !== "https:") return null;
  return target.href;
}

function redirectBlocked(from: string, location: string | null): Error {
  return new Error(
    t("ERROR.REDIRECT_BLOCKED", {
      from: redactUrl(from),
      to: location ? redactUrl(new URL(location, from).href) : "?",
    }),
  );
}

function isRedirect(status: number): boolean {
  return status >= 300 && status < 400 && status !== 304;
}

// 303, and 301/302 after a non GET, turn into a body-less GET, as fetch does.
function dropsBody(status: number, method: string): boolean {
  return (
    status === 303 ||
    ((status === 301 || status === 302) &&
      method !== "GET" &&
      method !== "HEAD")
  );
}

/** fetch() that follows redirects only within the same host and throws on any other. */
export async function fetchSameHost(
  url: string | URL,
  init: RequestInit = {},
): Promise<Response> {
  let current = String(url);
  let method = init.method ?? "GET";
  let body = init.body;
  for (let hop = 0; ; hop++) {
    const res = await fetch(current, {
      ...init,
      method,
      body,
      redirect: "manual",
    });
    if (!isRedirect(res.status)) return res;
    const location = res.headers.get("location");
    await res.body?.cancel().catch(() => undefined);
    const next = sameHostRedirect(current, location);
    if (!next || hop >= MAX_REDIRECTS) throw redirectBlocked(current, location);
    if (dropsBody(res.status, method)) {
      method = "GET";
      body = undefined;
    }
    current = next;
  }
}

async function fetchOnce<T>(
  url: string,
  options?: FetchOptions,
): Promise<FetchResult<T>> {
  let current = url;
  let method = (options?.method ?? "GET").toUpperCase();
  let body = options?.body;
  for (let hop = 0; ; hop++) {
    const result = await fetchOnceNoRedirect<T>(current, method, body, options);
    if (!("redirect" in result)) return result;
    const next = sameHostRedirect(current, result.redirect.location);
    if (!next || hop >= MAX_REDIRECTS)
      return {
        ok: false,
        status: result.redirect.status,
        message: redirectBlocked(current, result.redirect.location).message,
      };
    if (dropsBody(result.redirect.status, method)) {
      method = "GET";
      body = undefined;
    }
    current = next;
  }
}

async function fetchOnceNoRedirect<T>(
  url: string,
  method: string,
  body: FetchOptions["body"],
  options?: FetchOptions,
): Promise<
  FetchResult<T> | { redirect: { status: number; location: string | null } }
> {
  // ofetch treats a 3xx as a success, so the status is captured here.
  const seen: { status: number; location: string | null } = {
    status: 0,
    location: null,
  };
  try {
    // responseType: "json" forces parse; GitHub raw serves JSON as text/plain.
    // ofetch derives one signal from `timeout` and reuses it across its own
    // retries, so after a timeout every retry aborts instantly: fresh signal
    // per attempt, retries done here.
    await paceUpstreamRequest(url);
    const data = await ofetch<T>(url, {
      method,
      headers: options?.headers,
      body: body as Record<string, unknown> | undefined,
      signal: AbortSignal.timeout(options?.timeoutMs ?? 10_000),
      retry: false,
      responseType: "json",
      redirect: "manual",
      onResponse: ({ response }) => {
        seen.status = response.status;
        seen.location = response.headers.get("location");
        if (!isRedirect(response.status))
          options?.onHeaders?.(response.headers);
      },
    });
    if (isRedirect(seen.status)) return { redirect: seen };
    return { ok: true, data };
  } catch (err) {
    if (err instanceof FetchError && err.response)
      return {
        ok: false,
        status: err.response.status,
        retryAfterMs: retryAfterMs(err.response.headers.get("retry-after")),
        message: t("ERROR.HTTP_ERROR", {
          status: err.response.status,
          statusText: err.response.statusText,
          url: redactUrl(url),
        }),
      };
    return {
      ok: false,
      status: undefined,
      message: err instanceof Error ? err.message : String(err),
    };
  }
}

function retryAfterMs(header: string | null): number | undefined {
  if (!header) return undefined;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return seconds * 1000;
  const at = Date.parse(header);
  return Number.isFinite(at) ? Math.max(0, at - Date.now()) : undefined;
}

export async function fetchJson<T>(
  url: string,
  options?: FetchOptions,
): Promise<T> {
  const r = await fetchJsonResult<T>(url, options);
  if (r.ok) return r.data;
  throw new Error(r.message);
}

export async function tryFetchJson<T>(
  url: string,
  options?: FetchOptions,
): Promise<T | null> {
  try {
    return await fetchJson<T>(url, options);
  } catch {
    return null;
  }
}
