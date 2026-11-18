import { connection } from "next/server";
import { ZodError, type ZodType } from "zod";

export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
    public extra?: Record<string, unknown>,
  ) {
    super(message);
  }
}

export function json(data: unknown, status = 200, headers?: HeadersInit) {
  return Response.json(data, { status, headers });
}

/** Wrap a route handler: maps HttpError / ZodError to JSON error responses. */
export function handle<A extends unknown[]>(fn: (...args: A) => Promise<Response>) {
  return async (...args: A): Promise<Response> => {
    // Every API route is request-time (DB reads, cookies). Must run outside the try so Next's
    // prerender bail-out signal isn't swallowed by the error mapper below.
    await connection();
    // Serverless clock: requests drive the scheduler (at most once a minute, after the response).
    import("./scheduler").then((m) => m.maybeTick(), (e) => console.error("[won] scheduler load failed", e));
    try {
      return await fn(...args);
    } catch (e) {
      if (e instanceof HttpError) return json({ error: e.message, ...e.extra }, e.status);
      if (e instanceof ZodError) return json({ error: e.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") }, 400);
      console.error(e);
      return json({ error: "Internal error" }, 500);
    }
  };
}

export async function body<T>(req: Request, schema: ZodType<T>): Promise<T> {
  let data: unknown;
  try {
    data = await req.json();
  } catch {
    throw new HttpError(400, "Invalid JSON body");
  }
  return schema.parse(data);
}

// --- tiny in-memory rate limiter (per IP + bucket) ---
const buckets = new Map<string, { tokens: number; at: number }>();

export function clientIp(req: Request): string {
  return req.headers.get("cf-connecting-ip") || req.headers.get("x-forwarded-for")?.split(",")[0].trim() || "local";
}

export function rateLimit(req: Request, bucket: string, perMinute: number) {
  rateLimitKey(`${bucket}:${clientIp(req)}`, perMinute, 60_000);
}

/** Token bucket on any key (e.g. a phone number), `limit` per `windowMs`. */
export function rateLimitKey(key: string, limit: number, windowMs: number) {
  const perMinute = limit;
  const t = Date.now();
  const b = buckets.get(key) ?? { tokens: perMinute, at: t };
  b.tokens = Math.min(perMinute, b.tokens + ((t - b.at) / windowMs) * perMinute);
  b.at = t;
  if (b.tokens < 1) throw new HttpError(429, "Too many requests — please slow down");
  b.tokens -= 1;
  buckets.set(key, b);
}
