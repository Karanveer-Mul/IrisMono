"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { apiFetch, removeToken } from "@/lib/api";
import type { UserContext } from "@/lib/api";
import { MaskUploader } from "./MaskUploader";
import { InviteManager } from "./InviteManager";
import { LogOut, Coins, ShieldCheck, ClipboardList, Clock, Layers } from "lucide-react";

interface OrganizationInfo {
  id: string;
  name: string;
  creditBalance: number;
  allowedDomains: string[];
}

interface AuditLog {
  id: string;
  status: "PENDING" | "PROCESSING" | "SUCCESS" | "FAILED";
  rawImageS3Key: string;
  maskImageS3Key: string | null;
  errorMessage: string | null;
  createdAt: string;
  completedAt: string | null;
}

interface DashboardProps {
  user: UserContext;
  onLogout: () => void;
}

export function Dashboard({ user, onLogout }: DashboardProps) {
  const [org, setOrg] = useState<OrganizationInfo | null>(null);
  const [logs, setLogs] = useState<AuditLog[]>([]);
  const [activeJob, setActiveJob] = useState<AuditLog | null>(null);
  const [glowCredits, setGlowCredits] = useState(false);

  // Read inside callbacks that outlive a single render (SSE handler, timers),
  // where the state value itself would be captured stale.
  const activeJobIdRef = useRef<string | null>(null);

  const loadProfileAndLogs = useCallback(async () => {
    try {
      // 1. Fetch user org profile details
      const profile = await apiFetch("/api/auth/profile");

      // Trigger glow animation if balance changed (spend or refund)
      setOrg((prev) => {
        if (prev && prev.creditBalance !== profile.organization.creditBalance) {
          setGlowCredits(true);
          setTimeout(() => setGlowCredits(false), 1500);
        }
        return profile.organization;
      });

      // 2. Fetch jobs audit logs list
      const logsRes = await apiFetch("/api/jobs/logs");
      const list: AuditLog[] = logsRes.logs || [];
      setLogs(list);

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
    let cancelled = false;

    /**
     * SSE connection. Receives real-time job status events from the backend.
     *
     * EventSource cannot set an Authorization header, so the stream is
     * authenticated with a short-lived token minted for this purpose and passed
     * in the query string. The token expires in 60s, which only has to outlast
     * the handshake - the connection itself stays open afterwards.
     */
    const connect = async () => {
      try {
        const { token } = await apiFetch("/api/auth/stream-token", { method: "POST" });
        if (cancelled) return;

        eventSource = new EventSource(`/api/jobs/events?token=${encodeURIComponent(token)}`);

        eventSource.addEventListener("JOB_STATUS_CHANGE", (e: MessageEvent) => {
          try {
            const data = JSON.parse(e.data);
            console.log("[SSE Event] Job status change received:", data);
            loadProfileAndLogs();
          } catch (err) {
            console.error("Error processing SSE message data:", err);
          }
        });

        eventSource.onerror = (err) => {
          console.error("SSE stream connection error. Closing stream.", err);
          eventSource?.close();
        };
      } catch (err) {
        console.error("Could not open the live job event stream:", err);
      }
    };

    connect();

    return () => {
      cancelled = true;
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

  const handleJobFinalized = () => {
    activeJobIdRef.current = null;
    setActiveJob(null);
    loadProfileAndLogs();
  };

  const handleLogoutClick = () => {
    removeToken();
    onLogout();
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

          {/* Org details */}
          {org && (
            <div style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
              <span style={{ fontSize: "0.85rem", color: "var(--text-secondary)", fontWeight: 500 }}>
                {org.name}
              </span>
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
