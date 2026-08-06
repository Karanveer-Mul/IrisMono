/**
 * Utility to verify if an email domain matches a whitelisted domain.
 * Supports exact matches and wildcard domains (e.g., '*.stjude.org' matches 'research.stjude.org' and 'stjude.org').
 */
export function isEmailDomainAllowed(email: string, allowedDomains: string[]): boolean {
  if (!email || !allowedDomains || allowedDomains.length === 0) {
    return false;
  }

  const parts = email.split("@");
  if (parts.length !== 2) {
    return false;
  }
  const emailDomain = parts[1].toLowerCase().trim();

  for (const domainPattern of allowedDomains) {
    let pattern = domainPattern.toLowerCase().trim();

    // Strip wildcard prefix if present
    if (pattern.startsWith("*.")) {
      pattern = pattern.substring(2);
    }

    if (emailDomain === pattern || emailDomain.endsWith("." + pattern)) {
      return true;
    }
  }

  return false;
}

/**
 * Extracts the base domain from an email.
 * E.g., 'admin@stjude.org' -> 'stjude.org'
 */
export function getEmailDomain(email: string): string {
  const parts = email.split("@");
  return parts.length === 2 ? parts[1].toLowerCase().trim() : "";
}
