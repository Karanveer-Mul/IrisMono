const TOKEN_KEY = "irismono_jwt_token";

export interface UserContext {
  id: string;
  email: string;
  organizationId: string;
  role: "ORG_ADMIN" | "MEMBER";
}

/**
 * Save JWT token to localStorage
 */
export function setToken(token: string) {
  localStorage.setItem(TOKEN_KEY, token);
}

/**
 * Get JWT token from localStorage
 */
export function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}

/**
 * Remove JWT token (Logout)
 */
export function removeToken() {
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
    
    // Decode base64 payload
    const payloadJson = atob(parts[1]);
    const payload = JSON.parse(payloadJson);
    
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

/**
 * Centralized fetch handler to make authenticated requests to backend API
 */
export async function apiFetch(path: string, options: RequestInit = {}) {
  const token = getToken();
  
  const headers = new Headers(options.headers || {});
  if (!headers.has("Content-Type") && !(options.body instanceof FormData)) {
    headers.set("Content-Type", "application/json");
  }
  
  if (token) {
    headers.set("Authorization", `Bearer ${token}`);
  }

  const config: RequestInit = {
    ...options,
    headers,
  };

  const response = await fetch(path, config);
  
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
