"use client";

import { useState, useEffect } from "react";
import { Auth } from "./Auth";
import { Dashboard } from "./Dashboard";
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
