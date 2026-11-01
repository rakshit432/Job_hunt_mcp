const DEFAULT_TIMEOUT_MS = 15_000;

export function fetchWithTimeout(
  input: string | URL | Request,
  init: RequestInit = {},
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<Response> {
  return fetch(input, { ...init, signal: AbortSignal.timeout(timeoutMs) });
}
