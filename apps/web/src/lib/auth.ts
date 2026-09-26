/**
 * Who the browser says it is.
 *
 * In production this returns a Supabase access token. In development it returns
 * nothing and the client falls back to the `X-Dev-User` header the API honours when
 * `AUTH_DEV_MODE` is on — which is what lets the whole stack run with `docker compose
 * up` and no Supabase project.
 *
 * Both paths are behind one interface so no component ever branches on the auth mode.
 */

const DEV_USER_KEY = "understudy.devUser";

export interface Identity {
  /** Bearer token, or null when running in dev-header mode. */
  token: string | null;
  /** Email used for the dev header, and for showing who you are in the UI. */
  email: string;
}

let supabaseTokenProvider: (() => Promise<string | null>) | null = null;

/**
 * Registered by the Supabase bootstrap when one is configured. Kept as a hook rather
 * than an import so the dev build does not pull in the auth SDK at all.
 */
export function registerTokenProvider(provider: () => Promise<string | null>): void {
  supabaseTokenProvider = provider;
}

export function getDevUser(): string {
  return localStorage.getItem(DEV_USER_KEY) ?? "alice@example.com";
}

export function setDevUser(email: string): void {
  localStorage.setItem(DEV_USER_KEY, email);
}

export async function getIdentity(): Promise<Identity> {
  const token = supabaseTokenProvider ? await supabaseTokenProvider() : null;
  return { token, email: getDevUser() };
}

export async function authHeaders(): Promise<Record<string, string>> {
  const { token, email } = await getIdentity();
  return token ? { Authorization: `Bearer ${token}` } : { "X-Dev-User": email };
}
