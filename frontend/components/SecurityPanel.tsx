"use client";

import React, { useCallback, useEffect, useState } from "react";
import { apiFetch } from "@/lib/api";
import type { UserContext } from "@/lib/api";
import { MfaEnrolment } from "./MfaEnrolment";
import { ShieldCheck, ShieldOff, Users } from "lucide-react";

interface MfaStatus {
  enabled: boolean;
  enabledAt: string | null;
  pending: boolean;
  recoveryCodesRemaining: number;
}

interface SecurityPanelProps {
  user: UserContext;
  /** Whether the active organization requires a second factor of everyone. */
  requireMfa: boolean;
  /** Refreshes the dashboard's copy of the organization after a policy change. */
  onPolicyChanged: () => void;
}

export function SecurityPanel({ user, requireMfa, onPolicyChanged }: SecurityPanelProps) {
  const [status, setStatus] = useState<MfaStatus | null>(null);
  const [enrolling, setEnrolling] = useState(false);
  const [disableCode, setDisableCode] = useState("");
  const [showDisable, setShowDisable] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setStatus(await apiFetch("/api/auth/mfa"));
    } catch (err) {
      console.error("Failed to read MFA status:", err);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const disable = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await apiFetch("/api/auth/mfa/disable", { method: "POST", body: { code: disableCode } });
      setDisableCode("");
      setShowDisable(false);
      await load();
    } catch (err: any) {
      setError(err.message || "Could not turn off two-factor");
    } finally {
      setBusy(false);
    }
  };

  const setPolicy = async (next: boolean) => {
    setError(null);
    setBusy(true);
    try {
      await apiFetch("/api/auth/organization/mfa", { method: "PUT", body: { requireMfa: next } });
      onPolicyChanged();
    } catch (err: any) {
      setError(err.message || "Could not change the policy");
    } finally {
      setBusy(false);
    }
  };

  if (enrolling) {
    return (
      <MfaEnrolment
        onEnrolled={() => {
          setEnrolling(false);
          load();
        }}
      />
    );
  }

  return (
    <div className="glass-card">
      <div style={{ display: "flex", alignItems: "center", gap: "0.6rem", marginBottom: "1rem" }}>
        {status?.enabled ? (
          <ShieldCheck size={20} style={{ color: "#00f2fe" }} />
        ) : (
          <ShieldOff size={20} style={{ color: "var(--text-muted)" }} />
        )}
        <strong>Security</strong>
      </div>

      {error && (
        <div className="callout callout-error" style={{ marginBottom: "1rem" }}>
          <div style={{ fontSize: "0.85rem" }}>{error}</div>
        </div>
      )}

      <div style={{ marginBottom: "1.5rem" }}>
        <div style={{ fontSize: "0.9rem", marginBottom: "0.35rem" }}>
          Two-factor authentication:{" "}
          <strong style={{ color: status?.enabled ? "#00f2fe" : "var(--text-muted)" }}>
            {status?.enabled ? "on" : "off"}
          </strong>
        </div>

        {status?.enabled ? (
          <>
            <p style={{ color: "var(--text-muted)", fontSize: "0.78rem", marginBottom: "0.75rem" }}>
              {status.recoveryCodesRemaining} recovery code
              {status.recoveryCodesRemaining === 1 ? "" : "s"} left.
              {status.recoveryCodesRemaining <= 2 &&
                " Turn it off and back on to get a fresh set."}
            </p>

            {showDisable ? (
              <form onSubmit={disable} style={{ display: "flex", gap: "0.5rem", alignItems: "flex-end" }}>
                <div className="form-group" style={{ marginBottom: 0, flex: 1 }}>
                  {/* A current code, not just a live session: otherwise a stolen
                      session removes the control that makes a stolen password
                      insufficient. The API enforces this; the label says why. */}
                  <label className="form-label" htmlFor="disable-code-input">
                    Enter a current code to confirm
                  </label>
                  <input
                    id="disable-code-input"
                    className="input-field"
                    inputMode="numeric"
                    placeholder="000000"
                    maxLength={6}
                    value={disableCode}
                    onChange={(e) => setDisableCode(e.target.value.replace(/[^0-9]/g, ""))}
                    required
                  />
                </div>
                <button type="submit" className="btn" disabled={busy || disableCode.length !== 6}>
                  Turn off
                </button>
                <button type="button" className="btn" onClick={() => setShowDisable(false)}>
                  Cancel
                </button>
              </form>
            ) : (
              <button className="btn" onClick={() => setShowDisable(true)} id="mfa-disable-btn">
                Turn off two-factor
              </button>
            )}
          </>
        ) : (
          <>
            <p style={{ color: "var(--text-muted)", fontSize: "0.78rem", marginBottom: "0.75rem" }}>
              A second factor makes a stolen password insufficient on its own.
            </p>
            <button className="btn btn-primary" onClick={() => setEnrolling(true)} id="mfa-enrol-btn">
              {status?.pending ? "Finish setting up" : "Set up two-factor"}
            </button>
          </>
        )}
      </div>

      {user.role === "ORG_ADMIN" && (
        <div style={{ borderTop: "1px solid rgba(255,255,255,0.06)", paddingTop: "1.25rem" }}>
          <div style={{ display: "flex", alignItems: "center", gap: "0.5rem", marginBottom: "0.5rem" }}>
            <Users size={16} style={{ color: "var(--text-muted)" }} />
            <span style={{ fontSize: "0.9rem" }}>
              Require two-factor of everyone in this workspace:{" "}
              <strong style={{ color: requireMfa ? "#00f2fe" : "var(--text-muted)" }}>
                {requireMfa ? "on" : "off"}
              </strong>
            </span>
          </div>

          <p style={{ color: "var(--text-muted)", fontSize: "0.75rem", marginBottom: "0.75rem" }}>
            Members without one keep their sign-in but can reach nothing except enrolment until they
            finish. Applies at each member&apos;s next sign-in — sessions already issued are
            unaffected. You have to enrol yourself before you can require it.
          </p>

          <button
            className="btn"
            id="mfa-policy-btn"
            disabled={busy}
            onClick={() => setPolicy(!requireMfa)}
          >
            {requireMfa ? "Stop requiring it" : "Require it"}
          </button>
        </div>
      )}
    </div>
  );
}
