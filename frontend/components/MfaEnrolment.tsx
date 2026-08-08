"use client";

import React, { useState } from "react";
import { apiFetch } from "@/lib/api";
import { ShieldCheck, Copy, Check } from "lucide-react";

interface MfaEnrolmentProps {
  /** Called once MFA is on. Recovery codes have been shown by then. */
  onEnrolled: () => void;
  /** Shown when the organization requires it and the account has no session. */
  required?: boolean;
}

type Stage = "start" | "confirm" | "codes";

/**
 * Enrolment, in the same two steps the API enforces: a secret is handed over,
 * and nothing takes effect until a code proves the app holds it.
 *
 * No QR code. Rendering one needs either a dependency or a few hundred lines of
 * encoder, and the manual-entry key every authenticator app accepts is the same
 * secret - so the honest version is to show the key clearly and say so, rather
 * than ship a picture of it later.
 */
export function MfaEnrolment({ onEnrolled, required }: MfaEnrolmentProps) {
  const [stage, setStage] = useState<Stage>("start");
  const [secret, setSecret] = useState("");
  const [uri, setUri] = useState("");
  const [code, setCode] = useState("");
  const [recoveryCodes, setRecoveryCodes] = useState<string[]>([]);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const begin = async () => {
    setError(null);
    setBusy(true);
    try {
      const res = await apiFetch("/api/auth/mfa/setup", { method: "POST" });
      setSecret(res.secret);
      setUri(res.otpauthUri);
      setStage("confirm");
    } catch (err: any) {
      setError(err.message || "Could not start enrolment");
    } finally {
      setBusy(false);
    }
  };

  const confirm = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const res = await apiFetch("/api/auth/mfa/confirm", { method: "POST", body: { code } });
      setRecoveryCodes(res.recoveryCodes || []);
      setStage("codes");
    } catch (err: any) {
      setError(err.message || "That code was not accepted");
    } finally {
      setBusy(false);
    }
  };

  const copySecret = async () => {
    try {
      await navigator.clipboard.writeText(secret);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard is permissioned and can simply refuse. The key is on screen
      // either way, so this is not worth an error state.
    }
  };

  return (
    <div className="glass-card">
      <div style={{ display: "flex", alignItems: "center", gap: "0.6rem", marginBottom: "1rem" }}>
        <ShieldCheck size={20} style={{ color: "#00f2fe" }} />
        <strong>Two-factor authentication</strong>
      </div>

      {error && (
        <div className="callout callout-error" style={{ marginBottom: "1rem" }}>
          <div style={{ fontSize: "0.85rem" }}>{error}</div>
        </div>
      )}

      {stage === "start" && (
        <>
          <p style={{ color: "var(--text-secondary)", fontSize: "0.88rem", marginBottom: "1.25rem" }}>
            {required
              ? "This organization requires a second factor. Enrol an authenticator app to continue."
              : "Add an authenticator app, so a stolen password is not enough on its own."}
          </p>
          <button className="btn btn-primary" onClick={begin} disabled={busy} id="mfa-begin-btn">
            {busy ? "Preparing…" : "Set up authenticator"}
          </button>
        </>
      )}

      {stage === "confirm" && (
        <>
          <p style={{ color: "var(--text-secondary)", fontSize: "0.88rem", marginBottom: "0.75rem" }}>
            Add this key to your authenticator app, then enter the six-digit code it shows.
          </p>

          <div
            style={{
              display: "flex", alignItems: "center", gap: "0.75rem", padding: "0.75rem 1rem",
              background: "rgba(0,242,254,0.05)", border: "1px solid rgba(0,242,254,0.2)",
              borderRadius: "8px", marginBottom: "0.75rem",
            }}
          >
            <code
              id="mfa-secret"
              style={{ flex: 1, fontSize: "0.9rem", letterSpacing: "0.08em", wordBreak: "break-all" }}
            >
              {secret}
            </code>
            <button
              type="button"
              className="btn"
              onClick={copySecret}
              title="Copy key"
              style={{ padding: "0.4rem 0.6rem" }}
            >
              {copied ? <Check size={16} /> : <Copy size={16} />}
            </button>
          </div>

          <p style={{ color: "var(--text-muted)", fontSize: "0.75rem", marginBottom: "1.25rem", wordBreak: "break-all" }}>
            Or open this link on the device with your authenticator: <br />
            <span style={{ color: "var(--text-secondary)" }}>{uri}</span>
          </p>

          <form onSubmit={confirm}>
            <div className="form-group">
              <label className="form-label" htmlFor="mfa-code-input">Code from your app</label>
              <input
                id="mfa-code-input"
                className="input-field"
                inputMode="numeric"
                autoComplete="one-time-code"
                placeholder="000000"
                maxLength={6}
                value={code}
                onChange={(e) => setCode(e.target.value.replace(/[^0-9]/g, ""))}
                required
              />
            </div>
            <button
              type="submit"
              className="btn btn-primary"
              id="mfa-confirm-btn"
              disabled={busy || code.length !== 6}
            >
              {busy ? "Checking…" : "Turn on two-factor"}
            </button>
          </form>
        </>
      )}

      {stage === "codes" && (
        <>
          <div className="callout callout-info" style={{ marginBottom: "1rem" }}>
            <div style={{ fontSize: "0.82rem" }}>
              <strong>Save these now.</strong> They are shown once and each works a single time. If
              you lose both your phone and these codes, an administrator has to restore access by
              hand — there is no self-service reset.
            </div>
          </div>

          <div
            style={{
              display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))",
              gap: "0.5rem", marginBottom: "1.25rem",
            }}
            id="mfa-recovery-codes"
          >
            {recoveryCodes.map((c) => (
              <code
                key={c}
                style={{
                  padding: "0.5rem 0.75rem", background: "rgba(255,255,255,0.03)",
                  border: "1px solid rgba(255,255,255,0.08)", borderRadius: "6px", fontSize: "0.85rem",
                }}
              >
                {c}
              </code>
            ))}
          </div>

          <button className="btn btn-primary" onClick={onEnrolled} id="mfa-done-btn">
            I have saved them
          </button>
        </>
      )}
    </div>
  );
}
