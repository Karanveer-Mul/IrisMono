"use client";

import { useState, useEffect } from "react";
import { Auth } from "./Auth";
import { Dashboard } from "./Dashboard";
import { MfaEnrolment } from "./MfaEnrolment";
import { getToken, removeToken, decodeUserFromToken } from "@/lib/api";
import type { UserContext } from "@/lib/api";

interface AppShellProps {
  /** Set when the user landed on /join/<code>. */
  initialInviteCode?: string;
}

/**
 * Session gate. Renders the dashboard for an authenticated user, otherwise
 * the auth screen. Client-only because the JWT lives in localStorage.
 */
export function AppShell({ initialInviteCode }: AppShellProps) {
  const [user, setUser] = useState<UserContext | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const token = getToken();
    if (token) {
      const decodedUser = decodeUserFromToken(token);
      if (decodedUser) {
        setUser(decodedUser);
      } else {
        removeToken();
      }
    }
    setLoading(false);
  }, []);

  if (loading) {
    return (
      <div style={{ minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center" }}>
        <div className="spinner" />
      </div>
    );
  }

  // A restricted session is a real sign-in that can reach nothing but MFA
  // enrolment. Gating here rather than inside the dashboard: every request the
  // dashboard makes on mount would be refused, so it would render a shell of
  // empty panels and a stack of console errors instead of the one thing the
  // person is able to do.
  if (user?.restricted) {
    return (
      <div className="auth-wrapper">
        <div className="auth-container">
          <MfaEnrolment
            required
            onEnrolled={() => {
              // Enrolling does not lift the restriction on the token that is
              // already held - the claim was baked in when it was issued. A
              // fresh sign-in is what re-evaluates it.
              removeToken();
              setUser(null);
            }}
          />
        </div>
      </div>
    );
  }

  if (user) {
    return (
      <Dashboard
        // Remount on tenant change so no state from the previous organization
        // survives the switch.
        key={user.organizationId}
        user={user}
        onLogout={() => setUser(null)}
        onSwitchOrganization={setUser}
      />
    );
  }

  return <Auth onAuthSuccess={setUser} initialInviteCode={initialInviteCode} />;
}
