const TOKEN_KEY = "irismono_jwt_token";

export interface UserContext {
  id: string;
  email: string;
  /** The organization this session is currently acting in. */
  organizationId: string;
  /** Role in that organization - a person may hold a different one elsewhere. */
  role: "ORG_ADMIN" | "MEMBER";
}

export interface Membership {
  organizationId: string;
  organizationName: string;
  role: "ORG_ADMIN" | "MEMBER";
}

/**
 * Save JWT token to localStorage
 */
export function setToken(token: string) {
  if (typeof window === "undefined") return;
  localStorage.setItem(TOKEN_KEY, token);
}

/**
 * Get JWT token from localStorage
 */
export function getToken(): string | null {
  if (typeof window === "undefined") return null;
  return localStorage.getItem(TOKEN_KEY);
}

/**
 * Remove JWT token (Logout)
 */
export function removeToken() {
  if (typeof window === "undefined") return;
  localStorage.removeItem(TOKEN_KEY);
}

/**
 * Decodes the JWT payload to extract user metadata.
 */
export function decodeUserFromToken(token: string | null): UserContext | null {
  if (!token) return null;
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return null;

    // Decode base64url payload
    const base64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const payload = JSON.parse(atob(base64));

    return {
      id: payload.id,
      email: payload.email,
      organizationId: payload.organizationId,
      role: payload.role,
    };
  } catch (err) {
    console.error("Failed to decode token payload:", err);
    return null;
  }
}

type ApiOptions = Omit<RequestInit, "body"> & { body?: unknown };

/**
 * Centralized fetch handler to make authenticated requests to backend API.
 *
 * Object bodies are serialized to JSON here. Passing a plain object straight
 * through to fetch() stringifies it as "[object Object]", which the Express
 * json parser rejects - see AUDIT.md, "every browser-originated POST sent a
 * malformed body".
 */
export async function apiFetch(path: string, options: ApiOptions = {}) {
  const token = getToken();
  const { body, ...rest } = options;

  const headers = new Headers(rest.headers || {});

  // Anything fetch can send as-is passes through untouched; everything else
  // is treated as a JSON payload.
  const isRawBody =
    body instanceof FormData ||
    body instanceof Blob ||
    body instanceof ArrayBuffer ||
    body instanceof URLSearchParams ||
    typeof body === "string";

  let payload: BodyInit | undefined;
  if (body !== undefined && body !== null) {
    if (isRawBody) {
      payload = body as BodyInit;
    } else {
      payload = JSON.stringify(body);
      if (!headers.has("Content-Type")) {
        headers.set("Content-Type", "application/json");
      }
    }
  }

  if (token) {
    headers.set("Authorization", `Bearer ${token}`);
  }

  const response = await fetch(path, { ...rest, headers, body: payload });

  // Handle empty content or stream endpoints (like SSE) without json parsing
  const contentType = response.headers.get("content-type");
  let data: any = null;

  if (contentType && contentType.includes("application/json")) {
    data = await response.json();
  }

  if (!response.ok) {
    const errorMessage = data?.error || `Request failed with status ${response.status}`;
    throw new Error(errorMessage);
  }

  return data;
}

/**
 * Fetches a binary resource with the session token attached and returns an
 * object URL for it.
 *
 * Job images are tenant-scoped behind the normal Bearer session, and an
 * <img src> cannot carry that header - so the bytes are fetched here and handed
 * to the tag as a blob URL. Callers must revokeObjectURL when done.
 */
export async function apiFetchObjectUrl(path: string): Promise<string> {
  const token = getToken();
  const headers = new Headers();
  if (token) {
    headers.set("Authorization", `Bearer ${token}`);
  }

  const response = await fetch(path, { headers });
  if (!response.ok) {
    throw new Error(`Request failed with status ${response.status}`);
  }

  return URL.createObjectURL(await response.blob());
}
