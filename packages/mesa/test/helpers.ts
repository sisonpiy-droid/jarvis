import { MESA_API_BASE } from "../src/config";
import { MesaClient } from "../src/client";

export interface FakeCall {
  method: string;
  path: string;
  auth: string | null;
}

/** A fetch stand-in that serves fixture bodies by path; 404 for anything unrouted. */
export function fakeFetch(routes: Record<string, unknown | ((call: FakeCall) => Response)>, calls: FakeCall[] = []) {
  const impl = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    const path = url.startsWith(MESA_API_BASE) ? url.slice(MESA_API_BASE.length) : url;
    const headers = new Headers(init?.headers);
    const call = { method: init?.method ?? "GET", path, auth: headers.get("authorization") };
    calls.push(call);
    const key = Object.keys(routes).find((k) => k === path || (k.endsWith("*") && path.startsWith(k.slice(0, -1))));
    if (!key) return Response.json({ error: { code: "NOT_FOUND", message: "Not found" } }, { status: 404 });
    const route = routes[key];
    return typeof route === "function" ? (route as (c: FakeCall) => Response)(call) : Response.json(route);
  };
  return impl as typeof fetch;
}

export const staticTokens = (token = "test-token") => ({
  get: async () => token,
  refresh: async () => undefined,
});

export function testClient(routes: Record<string, unknown>, calls: FakeCall[] = []) {
  return new MesaClient({
    tokens: staticTokens(),
    fetch: fakeFetch(routes, calls),
    minGapMs: 0,
    sleep: async () => {},
  });
}
