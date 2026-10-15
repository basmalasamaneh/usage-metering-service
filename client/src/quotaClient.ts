/**
 * Thin client for the usage metering service. It only knows the public HTTP API: nothing here
 * depends on which plans exist, so plans can be changed in the service without touching this code.
 */
export class ServiceError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Json = any;

export class QuotaClient {
  constructor(
    public readonly baseUrl: string,
    public apiKey?: string,
    private readonly adminToken?: string,
  ) {}

  async request(method: string, path: string, body?: unknown): Promise<Json> {
    const headers: Record<string, string> = {};
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (this.apiKey) headers['x-api-key'] = this.apiKey;
    if (path === '/v1/accounts' && this.adminToken) headers['x-admin-token'] = this.adminToken;
    const res = await fetch(`${this.baseUrl}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await res.text();
    const json = text ? JSON.parse(text) : null;
    if (!res.ok) throw new ServiceError(res.status, json?.error?.code ?? 'error', json?.error?.message ?? res.statusText);
    return json;
  }

  get = (path: string) => this.request('GET', path);
  post = (path: string, body?: unknown) => this.request('POST', path, body);
  put = (path: string, body?: unknown) => this.request('PUT', path, body);
  patch = (path: string, body?: unknown) => this.request('PATCH', path, body);

  createAccount(name: string): Promise<Json> {
    return this.post('/v1/accounts', { name });
  }

  /** Ask the service to consume units on behalf of one of our users. The requestId makes retries safe. */
  consume(userId: string, units: number, requestId: string): Promise<Json> {
    return this.post('/v1/consume', { userId, units, requestId });
  }

  async waitUntilHealthy(timeoutMs = 60_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      try {
        const res = await fetch(`${this.baseUrl}/health`);
        if (res.ok) return;
      } catch {
        /* not up yet */
      }
      if (Date.now() > deadline) throw new Error(`quota service at ${this.baseUrl} did not become healthy`);
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
}
