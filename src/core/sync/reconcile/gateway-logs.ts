import { fetchSameHost } from "@core/infra/http";
import { SQL } from "bun";
import { t } from "@server/i18n";
import type { GatewayLogRow } from "./types";

// Widened on both sides: the upstream stamps completion time, we stamp ours,
// and a retried request lands its consume row later than the upstream's.
export const WINDOW_SLACK_SECONDS = 600;
const ID_CHUNK = 2000;

// An http(s) targetDb is the ClickHouse HTTP interface the gateway logs to
// (LOG_SQL_DSN), with the database as the path; anything else is postgres.
export function isClickHouseUrl(url: string): boolean {
  return /^https?:\/\//i.test(url);
}

function dbError(err: unknown): Error {
  return new Error(
    t("ERROR.RECONCILE_DB_FAILED", {
      error: err instanceof Error ? err.message : String(err),
    }),
  );
}

// ClickHouse writes id 0 for every row, and the matcher keys rows by id, so a
// row without one gets a negative id hashed from its content: stable across the
// separate fetches it is deduplicated over, and never equal to a real id.
// 64-bit integers are quoted in JSON output, hence Float64 (exact below 2^53).
// Columns are qualified wherever an output alias shadows them.
const CH_COLUMNS = `
  toFloat64(if(logs.id != 0, logs.id,
     -toInt64(bitAnd(cityHash64(logs.created_at, logs.type, logs.channel_id,
                                logs.request_id, logs.upstream_request_id,
                                logs.model_name, logs.token_name, logs.quota,
                                logs.prompt_tokens, logs.completion_tokens),
                     9007199254740991)) - 1)) AS id,
  type, toFloat64(created_at) AS created_at, model_name, toFloat64(quota) AS quota,
  prompt_tokens, completion_tokens, channel_id, token_name, request_id,
  nullIf(upstream_request_id, '') AS upstream_request_id`;

function chString(v: string): string {
  return `'${v.replaceAll("\\", "\\\\").replaceAll("'", "\\'")}'`;
}

function num(v: unknown): number {
  if (typeof v === "number") return v;
  throw new Error(`expected a number, got ${JSON.stringify(v)}`);
}

function text(v: unknown): string {
  if (typeof v === "string") return v;
  throw new Error(`expected a string, got ${JSON.stringify(v)}`);
}

function toGatewayRow(line: string): GatewayLogRow {
  const raw: unknown = JSON.parse(line);
  if (typeof raw !== "object" || raw === null)
    throw new Error(`unexpected row ${line}`);
  const r: Record<string, unknown> = { ...raw };
  return {
    id: num(r.id),
    type: num(r.type),
    created_at: num(r.created_at),
    model_name: text(r.model_name),
    quota: num(r.quota),
    prompt_tokens: num(r.prompt_tokens),
    completion_tokens: num(r.completion_tokens),
    channel_id: num(r.channel_id),
    token_name: text(r.token_name),
    request_id: text(r.request_id),
    upstream_request_id:
      r.upstream_request_id === null ? null : text(r.upstream_request_id),
  };
}

async function clickhouseRows(
  url: string,
  query: string,
  params: Record<string, string>,
): Promise<GatewayLogRow[]> {
  return (await clickhouseLines(url, query, params)).map(toGatewayRow);
}

/** One JSON object per line from the ClickHouse HTTP interface at `url`. */
export async function clickhouseLines(
  url: string,
  query: string,
  params: Record<string, string>,
): Promise<string[]> {
  const target = new URL(url);
  const database = decodeURIComponent(target.pathname.replace(/^\/+/, ""));
  const endpoint = new URL(`${target.protocol}//${target.host}/`);
  if (database) endpoint.searchParams.set("database", database);
  for (const [k, v] of Object.entries(params))
    endpoint.searchParams.set(`param_${k}`, v);
  const headers: Record<string, string> = {
    "Content-Type": "text/plain; charset=utf-8",
  };
  if (target.username) {
    headers["X-ClickHouse-User"] = decodeURIComponent(target.username);
    headers["X-ClickHouse-Key"] = decodeURIComponent(target.password);
  }
  const res = await fetchSameHost(endpoint, {
    method: "POST",
    headers,
    body: `${query}\nFORMAT JSONEachRow`,
    signal: AbortSignal.timeout(60_000),
  });
  const body = await res.text();
  if (!res.ok) throw new Error(`ClickHouse ${res.status}: ${body.trim()}`);
  return body.split("\n").filter((line) => line !== "");
}

export async function fetchGatewayLogs(
  url: string,
  window: { start: number; end: number },
  channelIds: number[],
): Promise<GatewayLogRow[]> {
  if (channelIds.length === 0) return [];
  const from = window.start - WINDOW_SLACK_SECONDS;
  const to = window.end + WINDOW_SLACK_SECONDS;
  if (isClickHouseUrl(url)) {
    try {
      return await clickhouseRows(
        url,
        `SELECT ${CH_COLUMNS}
         FROM logs
         WHERE type IN (2, 5)
           AND logs.created_at BETWEEN {from:Int64} AND {to:Int64}
           AND channel_id IN {channels:Array(Int32)}
         ORDER BY logs.created_at`,
        {
          from: String(from),
          to: String(to),
          channels: `[${channelIds.join(",")}]`,
        },
      );
    } catch (err) {
      throw dbError(err);
    }
  }
  const sql = new SQL(url, { max: 2, connectionTimeout: 15, idleTimeout: 30 });
  try {
    // bigint columns arrive as strings; cast so the matcher compares numbers.
    const rows: GatewayLogRow[] = await sql`
      SELECT id::int, type::int, created_at::int, model_name,
             quota::float8, prompt_tokens::int, completion_tokens::int,
             channel_id::int, token_name, request_id, upstream_request_id
      FROM logs
      WHERE type IN (2, 5)
        AND created_at BETWEEN ${from} AND ${to}
        AND channel_id IN ${sql(channelIds)}
      ORDER BY created_at`;
    return rows;
  } catch (err) {
    throw dbError(err);
  } finally {
    await sql.close();
  }
}

// Rows keyed by the upstream's request id, whatever channel they sit on: a
// lane deleted since the request still has its log row.
export async function fetchGatewayLogsByUpstreamIds(
  url: string,
  ids: string[],
): Promise<GatewayLogRow[]> {
  if (ids.length === 0) return [];
  const out: GatewayLogRow[] = [];
  if (isClickHouseUrl(url)) {
    try {
      for (let i = 0; i < ids.length; i += ID_CHUNK) {
        const chunk = ids.slice(i, i + ID_CHUNK);
        out.push(
          ...(await clickhouseRows(
            url,
            `SELECT ${CH_COLUMNS}
             FROM logs
             WHERE logs.upstream_request_id IN {ids:Array(String)}`,
            { ids: `[${chunk.map(chString).join(",")}]` },
          )),
        );
      }
      return out;
    } catch (err) {
      throw dbError(err);
    }
  }
  const sql = new SQL(url, { max: 1, connectionTimeout: 15, idleTimeout: 30 });
  try {
    for (let i = 0; i < ids.length; i += ID_CHUNK) {
      const chunk = ids.slice(i, i + ID_CHUNK);
      const rows: GatewayLogRow[] = await sql`
        SELECT id::int, type::int, created_at::int, model_name,
               quota::float8, prompt_tokens::int, completion_tokens::int,
               channel_id::int, token_name, request_id, upstream_request_id
        FROM logs
        WHERE upstream_request_id IN ${sql(chunk)}`;
      out.push(...rows);
    }
    return out;
  } catch (err) {
    throw dbError(err);
  } finally {
    await sql.close();
  }
}

// Error rows on every channel: an attempt the gateway abandoned and retried
// elsewhere leaves its error row wherever the retry chain started.
export async function fetchGatewayErrorRows(
  url: string,
  window: { start: number; end: number },
): Promise<GatewayLogRow[]> {
  const from = window.start - WINDOW_SLACK_SECONDS;
  const to = window.end + WINDOW_SLACK_SECONDS;
  if (isClickHouseUrl(url)) {
    try {
      return await clickhouseRows(
        url,
        `SELECT ${CH_COLUMNS}
         FROM logs
         WHERE type = 5
           AND logs.created_at BETWEEN {from:Int64} AND {to:Int64}`,
        { from: String(from), to: String(to) },
      );
    } catch (err) {
      throw dbError(err);
    }
  }
  const sql = new SQL(url, { max: 1, connectionTimeout: 15, idleTimeout: 30 });
  try {
    const rows: GatewayLogRow[] = await sql`
      SELECT id::int, type::int, created_at::int, model_name,
             quota::float8, prompt_tokens::int, completion_tokens::int,
             channel_id::int, token_name, request_id, upstream_request_id
      FROM logs
      WHERE type = 5
        AND created_at BETWEEN ${from} AND ${to}`;
    return rows;
  } catch (err) {
    throw dbError(err);
  } finally {
    await sql.close();
  }
}
