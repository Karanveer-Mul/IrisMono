"use client";

import React, { useState } from "react";
import { apiFetch, setToken, decodeUserFromToken } from "@/lib/api";
import type { UserContext } from "@/lib/api";
import { ShieldCheck } from "lucide-react";

interface MfaChallengeProps {
  /** Issued by the password step. Names the user and nothing else. */
  mfaToken: string;
  onVerified: (user: UserContext) => void;
  onCancel: () => void;
}

/**
 * The second step of a sign-in.
 *
 * The challenge token is held in component state rather than stored: it is not
 * a session, it expires in five minutes, and writing it to localStorage would
 * leave a half-finished sign-in lying around after the tab is closed.
 */
export function MfaChallenge({ mfaToken, onVerified, onCancel }: MfaChallengeProps) {
  const [code, setCode] = useState("");
  const [recoveryCode, setRecoveryCode] = useState("");
  const [useRecovery, setUseRecovery] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setBusy(true);

    try {
      const res = await apiFetch("/api/auth/mfa/verify", {
        method: "POST",
        body: useRecovery ? { mfaToken, recoveryCode } : { mfaToken, code },
      });

      setToken(res.token);
      const user = decodeUserFromToken(res.token);
      if (!user) throw new Error("Sign-in failed reading session details");
      onVerified(user);
    } catch (err: any) {
      setError(err.message || "Verification failed");
      setBusy(false);
    }
  };

  return (
    <div className="auth-wrapper">
      <div className="auth-container">
        <div style={{ textAlign: "center", marginBottom: "2rem" }}>
          <div
            style={{
              display: "inline-flex", padding: "10px", background: "rgba(0,242,254,0.06)",
              borderRadius: "12px", border: "1px solid rgba(0,242,254,0.15)", marginBottom: "1rem",
            }}
          >
            <ShieldCheck size={32} style={{ color: "#00f2fe" }} />
          </div>
          <h1 style={{ fontSize: "1.6rem", fontWeight: 800, marginBottom: "0.25rem" }}>
            One more step
          </h1>
          <p style={{ color: "var(--text-secondary)", fontSize: "0.9rem" }}>
            Enter the code from your authenticator app
          </p>
        </div>

        <div className="glass-card glow-card">
          {error && (
            <div className="callout callout-error" id="mfa-challenge-error">
              <div style={{ fontSize: "0.85rem" }}>{error}</div>
            </div>
          )}

          <form onSubmit={submit}>
            {useRecovery ? (
              <div className="form-group">
                <label className="form-label" htmlFor="recovery-input">Recovery code</label>
                <input
                  id="recovery-input"
                  className="input-field"
                  placeholder="xxxxx-xxxxx-xxxxx-xxxxx"
                  value={recoveryCode}
                  onChange={(e) => setRecoveryCode(e.target.value)}
                  required
                />
              </div>
            ) : (
              <div className="form-group">
                <label className="form-label" htmlFor="challenge-code-input">Six-digit code</label>
                <input
                  id="challenge-code-input"
                  className="input-field"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  // Focused on mount: this screen has exactly one thing to do.
                  autoFocus
                  placeholder="000000"
                  maxLength={6}
                  value={code}
                  onChange={(e) => setCode(e.target.value.replace(/[^0-9]/g, ""))}
                  required
                />
              </div>
            )}

            <button
              type="submit"
              className="btn btn-primary"
              id="mfa-verify-btn"
              style={{ width: "100%", height: "48px", marginTop: "0.5rem" }}
              disabled={busy || (useRecovery ? recoveryCode.length === 0 : code.length !== 6)}
            >
              {busy ? (
                <div className="spinner" style={{ width: "1.25rem", height: "1.25rem", borderWidth: "2px" }} />
              ) : (
                "Verify"
              )}
            </button>
          </form>

          <div style={{ display: "flex", justifyContent: "space-between", marginTop: "1.25rem" }}>
            <button
              type="button"
              className="btn"
              style={{ fontSize: "0.8rem" }}
              onClick={() => { setUseRecovery(!useRecovery); setError(null); }}
            >
              {useRecovery ? "Use a code from my app" : "Use a recovery code"}
            </button>
            <button type="button" className="btn" style={{ fontSize: "0.8rem" }} onClick={onCancel}>
              Back to sign in
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
