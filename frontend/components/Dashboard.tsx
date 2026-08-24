"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { apiFetch, removeToken, setToken, decodeUserFromToken } from "@/lib/api";
import type { UserContext, Membership } from "@/lib/api";
import { MaskUploader } from "./MaskUploader";
import { InviteManager } from "./InviteManager";
import { SecurityPanel } from "./SecurityPanel";
import { WorkspacePanel } from "./WorkspacePanel";
import { LogOut, Coins, ShieldCheck, ClipboardList, Clock, Layers } from "lucide-react";

interface OrganizationInfo {
  id: string;
  name: string;
  creditBalance: number;
  allowedDomains: string[];
  /** Whether this workspace requires a second factor of its members. */
  requireMfa?: boolean;
  /** How long scans are kept here; null means the platform default. */
  retentionDays?: number | null;
  /** How many jobs this workspace may run at once; null means the platform default. */
  maxConcurrentJobs?: number | null;
  /** Set once the workspace has been closed. The row survives; access does not. */
  deletedAt?: string | null;
}

interface AuditLog {
  id: string;
  status: "PENDING" | "PROCESSING" | "SUCCESS" | "FAILED";
  rawImageS3Key: string;
  maskImageS3Key: string | null;
  errorMessage: string | null;
  modelVersion: string | null;
  gpuSeconds: number | null;
  createdAt: string;
  completedAt: string | null;
}

interface DashboardProps {
  user: UserContext;
  onLogout: () => void;
  /** Re-scopes the session to another organization the user belongs to. */
  onSwitchOrganization: (user: UserContext) => void;
}

export function Dashboard({ user, onLogout, onSwitchOrganization }: DashboardProps) {
  const [memberships, setMemberships] = useState<Membership[]>([]);
  const [org, setOrg] = useState<OrganizationInfo | null>(null);
  // What a null retentionDays resolves to on this deployment, so the panel can
  // name the number rather than the word "default".
  const [platformRetentionDays, setPlatformRetentionDays] = useState<number | null>(null);
  // What a null maxConcurrentJobs resolves to, for the same reason.
  const [platformMaxConcurrentJobs, setPlatformMaxConcurrentJobs] = useState<number | null>(null);
  const [logs, setLogs] = useState<AuditLog[]>([]);
  const [activeJob, setActiveJob] = useState<AuditLog | null>(null);
  const [glowCredits, setGlowCredits] = useState(false);

  // Opaque cursor for the next page of the audit log; null when at the end.
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);

  // Read inside callbacks that outlive a single render (SSE handler, timers),
  // where the state value itself would be captured stale.
  const activeJobIdRef = useRef<string | null>(null);

  // Highest SSE event id seen. Sent on reconnect so the server replays anything
  // that happened while the stream was down.
  const lastEventIdRef = useRef<string | null>(null);

  const loadProfileAndLogs = useCallback(async () => {
    try {
      // 1. Fetch user org profile details
      const profile = await apiFetch("/api/auth/profile");

      // Trigger glow animation if balance changed (spend or refund)
      setMemberships(profile.memberships || []);
      setPlatformRetentionDays(profile.platformRetentionDays ?? null);
      setPlatformMaxConcurrentJobs(profile.platformMaxConcurrentJobs ?? null);

      setOrg((prev) => {
        if (prev && prev.creditBalance !== profile.organization.creditBalance) {
          setGlowCredits(true);
          setTimeout(() => setGlowCredits(false), 1500);
        }
        return profile.organization;
      });

      // 2. Fetch the first page of the audit log. Refreshing always returns to
      // page one - anything already loaded below it is replaced, so a job that
      // changed state cannot appear twice.
      const logsRes = await apiFetch("/api/jobs/logs");
      const list: AuditLog[] = logsRes.logs || [];
      setLogs(list);
      setNextCursor(logsRes.nextCursor ?? null);

      // If tracking an active job, sync it
      const trackedId = activeJobIdRef.current;
      if (trackedId) {
        const found = list.find((j) => j.id === trackedId);
        if (found) {
          setActiveJob(found);
        }
      }
    } catch (err) {
      console.error("Failed to load dashboard profile info:", err);
    }
  }, []);

  useEffect(() => {
    loadProfileAndLogs();

    let eventSource: EventSource | null = null;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let cancelled = false;
    let attempt = 0;

    /**
     * SSE connection. Receives real-time job status events from the backend.
     *
     * Two wrinkles worth knowing:
     *
     * EventSource cannot set an Authorization header, so the stream is
     * authenticated with a short-lived token minted for the purpose and passed
     * in the query string. The token only has to outlast the handshake.
     *
     * Because each reconnect needs a fresh token, we reconnect by hand rather
     * than letting EventSource do it, which means also passing lastEventId
     * ourselves - the server replays everything after it, so a job that
     * finished while the connection was down is not missed.
     */
    const connect = async () => {
      try {
        const { token } = await apiFetch("/api/auth/stream-token", { method: "POST" });
        if (cancelled) return;

        const params = new URLSearchParams({ token });
        if (lastEventIdRef.current) {
          params.set("lastEventId", lastEventIdRef.current);
        }

        const source = new EventSource(`/api/jobs/events?${params.toString()}`);
        eventSource = source;

        source.onopen = () => {
          attempt = 0;
        };

        source.addEventListener("JOB_STATUS_CHANGE", (e: MessageEvent) => {
          if (e.lastEventId) {
            lastEventIdRef.current = e.lastEventId;
          }
          try {
            const data = JSON.parse(e.data);
            console.log("[SSE Event] Job status change received:", data);
            loadProfileAndLogs();
          } catch (err) {
            console.error("Error processing SSE message data:", err);
          }
        });

        source.onerror = () => {
          source.close();
          if (cancelled) return;

          // Backoff, capped. Resumes from lastEventId on the next attempt.
          const delay = Math.min(1000 * 2 ** attempt, 30000);
          attempt++;
          console.warn(`SSE stream dropped; reconnecting in ${delay}ms.`);
          retryTimer = setTimeout(connect, delay);
        };
      } catch (err) {
        console.error("Could not open the live job event stream:", err);
        if (cancelled) return;
        const delay = Math.min(1000 * 2 ** attempt, 30000);
        attempt++;
        retryTimer = setTimeout(connect, delay);
      }
    };

    connect();

    return () => {
      cancelled = true;
      if (retryTimer) clearTimeout(retryTimer);
      eventSource?.close();
    };
  }, [user.id, loadProfileAndLogs]);

  const handleJobCreated = async () => {
    // Reload logs immediately to capture the new PENDING job
    await loadProfileAndLogs();

    const logsRes = await apiFetch("/api/jobs/logs");
    const list = (logsRes.logs || []) as AuditLog[];
    if (list.length > 0) {
      activeJobIdRef.current = list[0].id;
      setActiveJob(list[0]);
    }
  };

  const loadMoreLogs = async () => {
    if (!nextCursor || loadingMore) return;

    setLoadingMore(true);
    try {
      const res = await apiFetch(`/api/jobs/logs?cursor=${encodeURIComponent(nextCursor)}`);
      // Appended rather than merged: the cursor guarantees the next page starts
      // strictly after the last row already held, so there is nothing to dedupe.
      setLogs((prev) => [...prev, ...((res.logs || []) as AuditLog[])]);
      setNextCursor(res.nextCursor ?? null);
    } catch (err) {
      console.error("Failed to load more logs:", err);
    } finally {
      setLoadingMore(false);
    }
  };

  const handleJobFinalized = () => {
    activeJobIdRef.current = null;
    setActiveJob(null);
    loadProfileAndLogs();
  };

  const handleLogoutClick = () => {
    removeToken();
    onLogout();
  };

  /**
   * Switching organizations exchanges the session token for one scoped to the
   * other tenant. The server re-checks the membership, so this is a request
   * rather than a client-side context change.
   */
  const handleSwitchOrganization = async (organizationId: string) => {
    if (organizationId === user.organizationId) return;

    try {
      const res = await apiFetch("/api/auth/switch-organization", {
        method: "POST",
        body: { organizationId },
      });
      setToken(res.token);
      const switched = decodeUserFromToken(res.token);
      if (switched) {
        onSwitchOrganization(switched);
      }
    } catch (err) {
      console.error("Could not switch organization:", err);
    }
  };

  return (
    <div className="app-container">

      {/* Premium Header */}
      <header className="main-header">
        <div className="logo-container">
          <div style={{ background: "linear-gradient(135deg, var(--accent-indigo) 0%, var(--accent-teal) 100%)", width: "10px", height: "24px", borderRadius: "2px" }} />
          <span className="logo-text">IrisMono</span>
        </div>

        <div className="header-right">

          {/* Active organization. A person may belong to several, so this
              becomes a switcher once there is more than one. */}
          {org && (
            <div style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
              {memberships.length > 1 ? (
                <select
                  id="org-switcher"
                  className="input-field"
                  style={{ padding: "0.35rem 0.6rem", fontSize: "0.85rem", width: "auto", maxWidth: "220px" }}
                  value={user.organizationId}
                  onChange={(e) => handleSwitchOrganization(e.target.value)}
                  aria-label="Active organization"
                >
                  {memberships.map((m) => (
                    <option key={m.organizationId} value={m.organizationId}>
                      {m.organizationName}
                    </option>
                  ))}
                </select>
              ) : (
                <span style={{ fontSize: "0.85rem", color: "var(--text-secondary)", fontWeight: 500 }}>
                  {org.name}
                </span>
              )}
              <span className="badge badge-teal">
                <ShieldCheck size={12} />
                <span>{user.role}</span>
              </span>
            </div>
          )}

          {/* Logged in User ID */}
          <span style={{ fontSize: "0.85rem", color: "var(--text-secondary)", display: "inline-block", maxWidth: "160px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {user.email}
          </span>

          {/* Logout Button */}
          <button
            id="logout-btn"
            className="btn btn-secondary"
            style={{ padding: "0.45rem 1rem", fontSize: "0.85rem" }}
            onClick={handleLogoutClick}
          >
            <LogOut size={14} />
            <span>Sign Out</span>
          </button>
        </div>
      </header>

      {/* A closed workspace still renders, because the administrator who closed
          it is the only person who can reopen it - but nothing else here will
          work, and saying so beats letting every action fail with a 410. */}
      {org?.deletedAt && (
        <div className="callout callout-error" style={{ margin: "0 2rem 1rem" }}>
          <div style={{ fontSize: "0.85rem" }}>
            This workspace is closed. Existing records are kept, but no new scans can be submitted
            and nobody else can sign in to it.
          </div>
        </div>
      )}

      {/* Main Grid Content */}
      <main className="grid-container" style={{ flex: 1 }}>

        {/* Left Side: Mask Uploader & Logs */}
        <div style={{ display: "flex", flexDirection: "column", gap: "2rem" }}>

          <MaskUploader
            onJobCreated={handleJobCreated}
            activeJob={activeJob}
            onJobFinalized={handleJobFinalized}
          />

          {/* Audit Logs / Processing History */}
          <div className="glass-card">
            <div className="card-header" style={{ marginBottom: "1rem" }}>
              <h3 style={{ fontSize: "1.1rem", fontWeight: 700, display: "flex", alignItems: "center", gap: "0.5rem" }}>
                <ClipboardList size={18} style={{ color: "var(--accent-teal)" }} />
                <span>Logs &amp; Audits</span>
              </h3>
            </div>

            <p style={{ fontSize: "0.8rem", color: "var(--text-secondary)", marginBottom: "1rem" }}>
              Permanent logs maintained indefinitely for medical compliance, billing auditing, and status inspections.
            </p>

            {logs.length === 0 ? (
              <div style={{ textAlign: "center", padding: "2rem", color: "var(--text-muted)", fontSize: "0.9rem" }}>
                No mask generation tasks executed yet.
              </div>
            ) : (
              <div className="table-container">
                <table className="premium-table">
                  <thead>
                    <tr>
                      <th>Job ID</th>
                      <th>Time Started</th>
                      <th>Status</th>
                      <th>Model</th>
                      <th>Output Mask S3 Path</th>
                    </tr>
                  </thead>
                  <tbody>
                    {logs.map((log) => (
                      <tr key={log.id} className="job-log-row" id={`row-${log.id}`}>
                        <td
                          className="job-id-cell"
                          style={{ fontFamily: "monospace", fontSize: "0.75rem", color: "var(--accent-teal)", maxWidth: "120px", overflow: "hidden", textOverflow: "ellipsis" }}
                        >
                          {log.id}
                        </td>
                        <td style={{ fontSize: "0.8rem", color: "var(--text-secondary)" }}>
                          <div style={{ display: "flex", alignItems: "center", gap: "0.35rem" }}>
                            <Clock size={12} style={{ color: "var(--text-muted)" }} />
                            <span>{new Date(log.createdAt).toLocaleTimeString()}</span>
                          </div>
                        </td>
                        <td>
                          <span className={`badge ${
                            log.status === "PENDING" ? "badge-amber" :
                            log.status === "PROCESSING" ? "badge-teal" :
                            log.status === "SUCCESS" ? "badge-emerald" : "badge-red"
                          }`} style={{ padding: "0.2rem 0.5rem", fontSize: "0.7rem" }}>
                            {log.status}
                          </span>
                        </td>
                        <td
                          className="model-version-cell"
                          style={{ fontFamily: "monospace", fontSize: "0.72rem", color: "var(--text-secondary)", whiteSpace: "nowrap" }}
                          title={log.gpuSeconds != null ? `${log.gpuSeconds.toFixed(2)}s GPU time` : undefined}
                        >
                          {log.modelVersion ?? <span style={{ color: "var(--text-muted)" }}>—</span>}
                        </td>
                        <td
                          className="mask-path-cell"
                          style={{ fontSize: "0.75rem", color: "var(--text-secondary)", maxWidth: "250px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
                        >
                          {log.status === "SUCCESS" ? (
                            <span style={{ color: "#a7f3d0" }}>{log.maskImageS3Key}</span>
                          ) : log.status === "FAILED" ? (
                            <span style={{ color: "#fca5a5" }}>Refunded: {log.errorMessage}</span>
                          ) : (
                            <span style={{ color: "var(--text-muted)" }}>Processing...</span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>

                {nextCursor && (
                  <div style={{ textAlign: "center", padding: "1rem 0 0.25rem" }}>
                    <button
                      onClick={loadMoreLogs}
                      disabled={loadingMore}
                      className="btn-secondary"
                      style={{ fontSize: "0.8rem", padding: "0.45rem 1.1rem" }}
                    >
                      {loadingMore ? "Loading..." : "Load older jobs"}
                    </button>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>

        {/* Right Side: Credits Balance & Invite Whitelist Manager */}
        <div style={{ display: "flex", flexDirection: "column", gap: "2rem" }}>

          {/* Credit balance Widget */}
          <div className={`glass-card ${glowCredits ? "glow-card" : ""}`} style={{ transition: "box-shadow 0.3s ease, border-color 0.3s ease" }}>
            <h3 style={{ fontSize: "0.85rem", fontWeight: 700, color: "var(--text-secondary)", textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: "0.75rem" }}>
              Organization Credit Balance
            </h3>
            <div style={{ display: "flex", alignItems: "center", gap: "1rem" }}>
              <div style={{ display: "flex", alignItems: "center", justifyItems: "center", padding: "12px", background: "rgba(0, 242, 254, 0.05)", border: "1px solid rgba(0, 242, 254, 0.2)", borderRadius: "10px", color: "var(--accent-teal)" }}>
                <Coins size={28} />
              </div>
              <div>
                <div
                  id="credit-balance-display"
                  style={{ fontSize: "2rem", fontWeight: 800, color: org && org.creditBalance === 0 ? "var(--accent-red)" : "#ffffff" }}
                >
                  {org ? org.creditBalance : "0"}
                </div>
                <span style={{ fontSize: "0.75rem", color: "var(--text-muted)" }}>Available processing credits</span>
              </div>
            </div>
          </div>

          {/* Second factor, and - for an admin - whether it is required here */}
          <SecurityPanel
            user={user}
            requireMfa={!!org?.requireMfa}
            onPolicyChanged={loadProfileAndLogs}
          />

          {/* Retention and closure. Admin only, like the API behind it. */}
          {user.role === "ORG_ADMIN" && org && (
            <WorkspacePanel
              org={org}
              platformRetentionDays={platformRetentionDays}
              platformMaxConcurrentJobs={platformMaxConcurrentJobs}
              onChanged={loadProfileAndLogs}
            />
          )}

          {/* Invite whitelisting panel (Admin Only) */}
          {user.role === "ORG_ADMIN" ? (
            <InviteManager orgId={user.organizationId} />
          ) : (
            <div className="glass-card" style={{ background: "rgba(0,0,0,0.2)", opacity: 0.65 }}>
              <div style={{ display: "flex", gap: "0.75rem" }}>
                <Layers size={20} style={{ color: "var(--text-muted)" }} />
                <div>
                  <h4 style={{ fontSize: "0.9rem", fontWeight: 700, color: "var(--text-secondary)" }}>Administrator Console</h4>
                  <p style={{ fontSize: "0.8rem", color: "var(--text-muted)", marginTop: "0.5rem" }}>
                    Domain whitelist configuration and invite link controls are restricted to the ORG_ADMIN.
                  </p>
                </div>
              </div>
            </div>
          )}

        </div>

      </main>

    </div>
  );
}
