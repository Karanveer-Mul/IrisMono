"use client";

import React, { useState } from "react";
import { useRouter } from "next/navigation";
import { apiFetch, setToken, decodeUserFromToken } from "@/lib/api";
import type { UserContext } from "@/lib/api";
import { Shield, Sparkles, Building2, UserPlus, KeyRound } from "lucide-react";

type AuthTab = "login" | "register-org" | "join-invite";

interface AuthProps {
  onAuthSuccess: (user: UserContext) => void;
  /** Pre-filled when landing on /join/<code>. */
  initialInviteCode?: string;
}

export function Auth({ onAuthSuccess, initialInviteCode }: AuthProps) {
  const router = useRouter();

  const [activeTab, setActiveTab] = useState<AuthTab>(
    initialInviteCode ? "join-invite" : "login"
  );

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [orgName, setOrgName] = useState("");
  const [inviteCode, setInviteCode] = useState(initialInviteCode ?? "");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setLoading(true);

    try {
      let endpoint = "/api/auth/login";
      let payload: Record<string, string> = { email, password };

      if (activeTab === "register-org") {
        endpoint = "/api/auth/register";
        payload = { email, password, orgName };
      } else if (activeTab === "join-invite") {
        if (!inviteCode) {
          throw new Error("Please enter or click a valid invite code link");
        }
        endpoint = `/api/auth/join/${inviteCode}`;
      }

      const res = await apiFetch(endpoint, {
        method: "POST",
        body: payload,
      });

      if (res.token) {
        setToken(res.token);
        const decodedUser = decodeUserFromToken(res.token);
        if (decodedUser) {
          // Drop the invite code from the URL once it has been consumed
          if (activeTab === "join-invite") {
            router.replace("/");
          }
          onAuthSuccess(decodedUser);
        } else {
          throw new Error("Authentication failed reading session details");
        }
      }
    } catch (err: any) {
      setError(err.message || "An authentication error occurred");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="auth-wrapper">
      <div className="auth-container">

        {/* Brand Header */}
        <div style={{ textAlign: "center", marginBottom: "2rem" }}>
          <div style={{ display: "inline-flex", padding: "10px", background: "rgba(0,242,254,0.06)", borderRadius: "12px", border: "1px solid rgba(0,242,254,0.15)", marginBottom: "1rem" }}>
            <Shield size={32} className="uploader-icon" style={{ color: "#00f2fe" }} />
          </div>
          <h1 style={{ fontSize: "2rem", fontWeight: 800, marginBottom: "0.25rem" }}>IrisMono</h1>
          <p style={{ color: "var(--text-secondary)", fontSize: "0.9rem" }}>Medical Image Segmentation Engine</p>
        </div>

        {/* Tab Controls */}
        <div className="auth-tabs">
          <div
            id="tab-login"
            className={`auth-tab ${activeTab === "login" ? "active" : ""}`}
            onClick={() => { setActiveTab("login"); setError(null); }}
          >
            Sign In
          </div>
          <div
            id="tab-register"
            className={`auth-tab ${activeTab === "register-org" ? "active" : ""}`}
            onClick={() => { setActiveTab("register-org"); setError(null); }}
          >
            Create Workspace
          </div>
          <div
            id="tab-join"
            className={`auth-tab ${activeTab === "join-invite" ? "active" : ""}`}
            onClick={() => { setActiveTab("join-invite"); setError(null); }}
          >
            Join Team
          </div>
        </div>

        {/* Form Panel */}
        <div className="glass-card glow-card">
          {error && (
            <div className="callout callout-error" id="auth-error-msg">
              <div>
                <strong>Authentication Denied</strong>
                <p style={{ marginTop: "0.25rem", fontSize: "0.85rem" }}>{error}</p>
              </div>
            </div>
          )}

          <form onSubmit={handleSubmit}>

            {activeTab === "register-org" && (
              <div className="form-group">
                <label className="form-label" htmlFor="org-name-input">Hospital / Organization Name</label>
                <div style={{ position: "relative" }}>
                  <Building2 size={16} style={{ position: "absolute", left: "12px", top: "15px", color: "var(--text-muted)" }} />
                  <input
                    id="org-name-input"
                    type="text"
                    className="input-field"
                    style={{ paddingLeft: "2.5rem" }}
                    placeholder="e.g. St. Jude Hospital"
                    value={orgName}
                    onChange={(e) => setOrgName(e.target.value)}
                    required
                  />
                </div>
              </div>
            )}

            {activeTab === "join-invite" && (
              <div className="form-group">
                <label className="form-label" htmlFor="invite-code-input">Invite Code</label>
                <div style={{ position: "relative" }}>
                  <KeyRound size={16} style={{ position: "absolute", left: "12px", top: "15px", color: "var(--text-muted)" }} />
                  <input
                    id="invite-code-input"
                    type="text"
                    className="input-field"
                    style={{ paddingLeft: "2.5rem" }}
                    placeholder="e.g. inv_xxxx-xxxx-xxxx"
                    value={inviteCode}
                    onChange={(e) => setInviteCode(e.target.value)}
                    required
                  />
                </div>
              </div>
            )}

            <div className="form-group">
              <label className="form-label" htmlFor="email-input">Hospital Email Address</label>
              <div style={{ position: "relative" }}>
                <UserPlus size={16} style={{ position: "absolute", left: "12px", top: "15px", color: "var(--text-muted)" }} />
                <input
                  id="email-input"
                  type="email"
                  className="input-field"
                  style={{ paddingLeft: "2.5rem" }}
                  placeholder="name@hospital.org"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  required
                />
              </div>
            </div>

            <div className="form-group" style={{ marginBottom: "2rem" }}>
              <label className="form-label" htmlFor="password-input">Password</label>
              <input
                id="password-input"
                type="password"
                className="input-field"
                placeholder="••••••••"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
              />
            </div>

            <button
              id="auth-submit-btn"
              type="submit"
              className="btn btn-primary"
              style={{ width: "100%", height: "48px" }}
              disabled={loading}
            >
              {loading ? (
                <div className="spinner" style={{ width: "1.25rem", height: "1.25rem", borderWidth: "2px" }} />
              ) : (
                <>
                  {activeTab === "login" && "Sign In"}
                  {activeTab === "register-org" && "Create Workspace & Seed Credits"}
                  {activeTab === "join-invite" && "Join Organization Workspace"}
                </>
              )}
            </button>

          </form>
        </div>

        {/* Notice Info Card */}
        {activeTab === "register-org" && (
          <div className="callout callout-info" style={{ marginTop: "1.5rem" }}>
            <Sparkles size={20} style={{ color: "#00f2fe", flexShrink: 0 }} />
            <div style={{ fontSize: "0.8rem" }}>
              <strong>First-In Creator Trial:</strong> Registering a new workspace instantly seeds the organization balance with exactly <strong>3 credits</strong> and restricts registration access to your email domain.
            </div>
          </div>
        )}

      </div>
    </div>
  );
}
