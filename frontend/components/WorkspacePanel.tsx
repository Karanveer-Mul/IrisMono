"use client";

import React, { useState } from "react";
import { apiFetch, removeToken } from "@/lib/api";
import { Archive, Gauge, RotateCcw, Timer } from "lucide-react";

interface WorkspacePanelProps {
  /** The active organization, as the profile returns it. */
  org: {
    id: string;
    name: string;
    retentionDays?: number | null;
    maxConcurrentJobs?: number | null;
    deletedAt?: string | null;
  };
  /** What retentionDays = null resolves to on this deployment. */
  platformRetentionDays: number | null;
  /** What maxConcurrentJobs = null resolves to on this deployment. */
  platformMaxConcurrentJobs: number | null;
  /** Re-reads the profile after retention, concurrency, closure, or reopening changes it. */
  onChanged: () => void;
}

/**
 * Workspace administration: how long scans are kept, and closing the workspace.
 *
 * Both were API-only until now. Retention is a contract term an administrator
 * has to be able to see and set without a support ticket, and a customer who
 * wants to leave should not have to ask someone to run a DELETE for them.
 */
export function WorkspacePanel({
  org,
  platformRetentionDays,
  platformMaxConcurrentJobs,
  onChanged,
}: WorkspacePanelProps) {
  const usingDefault = org.retentionDays == null;
  const [days, setDays] = useState(usingDefault ? "" : String(org.retentionDays));
  const usingDefaultConcurrency = org.maxConcurrentJobs == null;
  const [concurrency, setConcurrency] = useState(
    usingDefaultConcurrency ? "" : String(org.maxConcurrentJobs)
  );
  const [confirmName, setConfirmName] = useState("");
  const [showClose, setShowClose] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const closed = !!org.deletedAt;

  const saveRetention = async (retentionDays: number | null) => {
    setError(null);
    setNotice(null);
    setBusy(true);
    try {
      await apiFetch("/api/auth/organization/retention", {
        method: "PUT",
        body: { retentionDays },
      });
      setDays(retentionDays === null ? "" : String(retentionDays));
      setNotice(
        retentionDays === null
          ? "Now following the platform default."
          : `Scans are now deleted ${retentionDays} days after they are uploaded.`
      );
      onChanged();
    } catch (err: any) {
      setError(err.message || "Could not change the retention window");
    } finally {
      setBusy(false);
    }
  };

  const saveConcurrency = async (maxConcurrentJobs: number | null) => {
    setError(null);
    setNotice(null);
    setBusy(true);
    try {
      await apiFetch("/api/auth/organization/concurrency", {
        method: "PUT",
        body: { maxConcurrentJobs },
      });
      setConcurrency(maxConcurrentJobs === null ? "" : String(maxConcurrentJobs));
      setNotice(
        maxConcurrentJobs === null
          ? "Now following the platform default."
          : `Up to ${maxConcurrentJobs} job(s) may run here at once.`
      );
      onChanged();
    } catch (err: any) {
      setError(err.message || "Could not change the concurrency limit");
    } finally {
      setBusy(false);
    }
  };

  const close = async () => {
    setError(null);
    setBusy(true);
    try {
      const res = await apiFetch("/api/auth/organization", { method: "DELETE" });
      setShowClose(false);
      setConfirmName("");
      setNotice(res.note);
      onChanged();
    } catch (err: any) {
      setError(err.message || "Could not close the workspace");
    } finally {
      setBusy(false);
    }
  };

  const revokeEveryone = async () => {
    setError(null);
    setBusy(true);
    try {
      await apiFetch("/api/auth/organization/sessions/revoke", { method: "POST" });
      removeToken();
      window.location.reload();
    } catch (err: any) {
      setError(err.message || "Could not end the sessions");
      setBusy(false);
    }
  };

  const reopen = async () => {
    setError(null);
    setBusy(true);
    try {
      await apiFetch("/api/auth/organization/reopen", { method: "POST" });
      setNotice("The workspace is open again.");
      onChanged();
    } catch (err: any) {
      setError(err.message || "Could not reopen the workspace");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="glass-card">
      <div style={{ display: "flex", alignItems: "center", gap: "0.6rem", marginBottom: "1rem" }}>
        <Archive size={20} style={{ color: closed ? "var(--accent-red)" : "var(--text-muted)" }} />
        <strong>Workspace</strong>
      </div>

      {error && (
        <div className="callout callout-error" style={{ marginBottom: "1rem" }}>
          <div style={{ fontSize: "0.85rem" }}>{error}</div>
        </div>
      )}

      {notice && !error && (
        <div className="callout" style={{ marginBottom: "1rem" }}>
          <div style={{ fontSize: "0.85rem" }}>{notice}</div>
        </div>
      )}

      {closed ? (
        /* A closed workspace can only be reopened with a token minted before the
           closure - no new one can name it. That bounds reopening to this
           session, which is the mistake it exists to undo, so the consequence of
           signing out is stated rather than discovered. */
        <div>
          <p style={{ fontSize: "0.9rem", marginBottom: "0.5rem" }}>
            This workspace was closed on {new Date(org.deletedAt!).toLocaleString()}.
          </p>
          <p style={{ color: "var(--text-muted)", fontSize: "0.78rem", marginBottom: "0.75rem" }}>
            Jobs, credit history, and audit records are kept. Invite links no longer work and no
            new sign-in can reach this workspace. <strong>Reopening is only possible from this
            session</strong> — signing out makes it an operator task.
          </p>
          <button className="btn btn-primary" id="workspace-reopen-btn" disabled={busy} onClick={reopen}>
            <RotateCcw size={14} />
            <span>Reopen workspace</span>
          </button>
        </div>
      ) : (
        <>
          <div style={{ marginBottom: "1.5rem" }}>
            <div style={{ display: "flex", alignItems: "center", gap: "0.5rem", marginBottom: "0.35rem" }}>
              <Timer size={16} style={{ color: "var(--text-muted)" }} />
              <span style={{ fontSize: "0.9rem" }}>
                Scans are deleted after{" "}
                <strong style={{ color: "#00f2fe" }}>
                  {org.retentionDays ?? platformRetentionDays ?? "—"} days
                </strong>
                {usingDefault && (
                  <span style={{ color: "var(--text-muted)" }}> (platform default)</span>
                )}
              </span>
            </div>

            <p style={{ color: "var(--text-muted)", fontSize: "0.75rem", marginBottom: "0.75rem" }}>
              Measured from when a scan was uploaded, not from when it was last touched. Job
              records, credits, and the audit trail are kept regardless — only the stored images
              are removed. Shortening this window deletes images that are already past the new
              limit on the next sweep.
            </p>

            <form
              onSubmit={(e) => {
                e.preventDefault();
                saveRetention(Number(days));
              }}
              style={{ display: "flex", gap: "0.5rem", alignItems: "flex-end" }}
            >
              <div className="form-group" style={{ marginBottom: 0, width: "9rem" }}>
                <label className="form-label" htmlFor="retention-days-input">
                  Days to keep (1–3650)
                </label>
                <input
                  id="retention-days-input"
                  className="input-field"
                  inputMode="numeric"
                  placeholder={platformRetentionDays ? String(platformRetentionDays) : "30"}
                  value={days}
                  onChange={(e) => setDays(e.target.value.replace(/[^0-9]/g, ""))}
                />
              </div>
              <button
                type="submit"
                className="btn"
                id="retention-save-btn"
                disabled={busy || days === "" || Number(days) < 1 || Number(days) > 3650}
              >
                Save
              </button>
              {!usingDefault && (
                <button
                  type="button"
                  className="btn"
                  id="retention-default-btn"
                  disabled={busy}
                  onClick={() => saveRetention(null)}
                >
                  Use the default
                </button>
              )}
            </form>
          </div>

          <div style={{ borderTop: "1px solid rgba(255,255,255,0.06)", paddingTop: "1.25rem", marginBottom: "1.5rem" }}>
            <div style={{ display: "flex", alignItems: "center", gap: "0.5rem", marginBottom: "0.35rem" }}>
              <Gauge size={16} style={{ color: "var(--text-muted)" }} />
              <span style={{ fontSize: "0.9rem" }}>
                Up to{" "}
                <strong style={{ color: "#00f2fe" }}>
                  {org.maxConcurrentJobs ?? platformMaxConcurrentJobs ?? "—"} job(s)
                </strong>{" "}
                may run here at once
                {usingDefaultConcurrency && (
                  <span style={{ color: "var(--text-muted)" }}> (platform default)</span>
                )}
              </span>
            </div>

            <p style={{ color: "var(--text-muted)", fontSize: "0.75rem", marginBottom: "0.75rem" }}>
              A new job is refused once this many are already waiting or processing here, across
              every member and every tab. Raise this only if this workspace has GPU capacity
              provisioned to match.
            </p>

            <form
              onSubmit={(e) => {
                e.preventDefault();
                saveConcurrency(Number(concurrency));
              }}
              style={{ display: "flex", gap: "0.5rem", alignItems: "flex-end" }}
            >
              <div className="form-group" style={{ marginBottom: 0, width: "9rem" }}>
                <label className="form-label" htmlFor="concurrency-input">
                  Concurrent jobs (1–1000)
                </label>
                <input
                  id="concurrency-input"
                  className="input-field"
                  inputMode="numeric"
                  placeholder={platformMaxConcurrentJobs ? String(platformMaxConcurrentJobs) : "1"}
                  value={concurrency}
                  onChange={(e) => setConcurrency(e.target.value.replace(/[^0-9]/g, ""))}
                />
              </div>
              <button
                type="submit"
                className="btn"
                id="concurrency-save-btn"
                disabled={busy || concurrency === "" || Number(concurrency) < 1 || Number(concurrency) > 1000}
              >
                Save
              </button>
              {!usingDefaultConcurrency && (
                <button
                  type="button"
                  className="btn"
                  id="concurrency-default-btn"
                  disabled={busy}
                  onClick={() => saveConcurrency(null)}
                >
                  Use the default
                </button>
              )}
            </form>
          </div>

          {/* Incident response: a shared credential, a suspected compromise, a
              contractor engagement that ended. Blunt on purpose - picking which
              sessions are the bad ones is exactly what nobody can do at the
              moment they need this. */}
          <div style={{ borderTop: "1px solid rgba(255,255,255,0.06)", paddingTop: "1.25rem", marginBottom: "1.5rem" }}>
            <p style={{ color: "var(--text-muted)", fontSize: "0.78rem", marginBottom: "0.6rem" }}>
              Signs out everyone in this workspace immediately, including you. They can sign back
              in — this ends sessions, it does not disable accounts.
            </p>
            <button
              className="btn"
              id="workspace-revoke-btn"
              disabled={busy}
              onClick={revokeEveryone}
            >
              Sign everyone out
            </button>
          </div>

          <div style={{ borderTop: "1px solid rgba(255,255,255,0.06)", paddingTop: "1.25rem" }}>
            {showClose ? (
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  close();
                }}
              >
                <p style={{ fontSize: "0.85rem", marginBottom: "0.5rem" }}>
                  Closing ends access for everyone in {org.name}. Jobs, credit history, and audit
                  records are <strong>kept</strong> — this is not erasure. To have the stored
                  images themselves destroyed, ask support to discard this workspace&apos;s
                  encryption key.
                </p>
                <div className="form-group">
                  {/* Typing the name, because the cost of doing this by accident
                      is every member losing access at once. */}
                  <label className="form-label" htmlFor="close-confirm-input">
                    Type <strong>{org.name}</strong> to confirm
                  </label>
                  <input
                    id="close-confirm-input"
                    className="input-field"
                    value={confirmName}
                    onChange={(e) => setConfirmName(e.target.value)}
                    autoComplete="off"
                  />
                </div>
                <div style={{ display: "flex", gap: "0.5rem" }}>
                  <button
                    type="submit"
                    className="btn"
                    id="workspace-close-confirm-btn"
                    disabled={busy || confirmName !== org.name}
                    style={{ color: "var(--accent-red)" }}
                  >
                    Close this workspace
                  </button>
                  <button
                    type="button"
                    className="btn"
                    onClick={() => {
                      setShowClose(false);
                      setConfirmName("");
                    }}
                  >
                    Cancel
                  </button>
                </div>
              </form>
            ) : (
              <button className="btn" id="workspace-close-btn" onClick={() => setShowClose(true)}>
                Close this workspace
              </button>
            )}
          </div>
        </>
      )}
    </div>
  );
}
