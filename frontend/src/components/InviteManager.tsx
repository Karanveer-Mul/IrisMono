import React, { useState, useEffect } from "react";
import { apiFetch } from "../utils/api";
import { Users, Link2, Plus, Power, ShieldAlert, Check, Globe, X } from "lucide-react";

interface InviteInfo {
  id: string;
  inviteCode: string;
  allowedDomains: string[];
  isActive: boolean;
  createdAt: string;
  expiresAt: string | null;
}

interface InviteManagerProps {
  orgId: string;
}

export function InviteManager({ orgId }: InviteManagerProps) {
  const [allowedDomains, setAllowedDomains] = useState<string[]>([]);
  const [newDomain, setNewDomain] = useState("");
  const [invites, setInvites] = useState<InviteInfo[]>([]);
  
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  // Load organization allowed domains and existing invites on mount
  useEffect(() => {
    fetchWhitelistAndInvites();
  }, [orgId]);

  const fetchWhitelistAndInvites = async () => {
    try {
      setLoading(true);
      setError(null);

      // 1. Fetch whitelisted domains
      const domainRes = await apiFetch("/api/invites/domains/list");
      setAllowedDomains(domainRes.allowedDomains || []);

      // 2. Fetch invite links
      const invitesRes = await apiFetch("/api/invites");
      setInvites(invitesRes.invites || []);
    } catch (err: any) {
      setError(err.message || "Failed to load team details");
    } finally {
      setLoading(false);
    }
  };

  const handleAddDomain = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newDomain.trim()) return;

    setError(null);
    setSuccess(null);

    try {
      const res = await apiFetch("/api/invites/domains", {
        method: "POST",
        body: {
          action: "add",
          domain: newDomain.trim(),
        },
      });
      setAllowedDomains(res.allowedDomains);
      setNewDomain("");
      setSuccess(`Whitelisted domain '${newDomain}' successfully`);
    } catch (err: any) {
      setError(err.message || "Failed to add domain to whitelist");
    }
  };

  const handleRemoveDomain = async (domainToRemove: string) => {
    setError(null);
    setSuccess(null);

    try {
      const res = await apiFetch("/api/invites/domains", {
        method: "POST",
        body: {
          action: "remove",
          domain: domainToRemove,
        },
      });
      setAllowedDomains(res.allowedDomains);
      setSuccess(`Removed domain '${domainToRemove}' from whitelist`);
    } catch (err: any) {
      setError(err.message || "Failed to remove domain");
    }
  };

  const handleGenerateInvite = async () => {
    setError(null);
    setSuccess(null);

    try {
      const res = await apiFetch("/api/invites", {
        method: "POST",
      });
      setInvites([res.invite, ...invites]);
      
      const inviteUrl = `${window.location.origin}/join/${res.invite.inviteCode}`;
      setSuccess(`Created invite link: ${inviteUrl}`);
      navigator.clipboard.writeText(inviteUrl).catch(() => {});
    } catch (err: any) {
      setError(err.message || "Failed to generate invite link");
    }
  };

  const handleToggleInvite = async (invite: InviteInfo) => {
    setError(null);
    setSuccess(null);

    try {
      const res = await apiFetch(`/api/invites/${invite.id}/toggle`, {
        method: "PATCH",
      });
      setInvites(invites.map((inv) => (inv.id === invite.id ? res.invite : inv)));
      setSuccess(res.message);
    } catch (err: any) {
      setError(err.message || "Failed to toggle status");
    }
  };

  return (
    <div className="glass-card" style={{ height: "100%", display: "flex", flexDirection: "column", gap: "1.25rem" }}>
      <div className="card-header" style={{ marginBottom: 0 }}>
        <h2 style={{ fontSize: "1.2rem", fontWeight: 700, display: "flex", alignItems: "center", gap: "0.5rem" }}>
          <Users size={20} style={{ color: "#00f2fe" }} />
          <span>Team Whitelisting</span>
        </h2>
      </div>

      <p style={{ fontSize: "0.85rem", color: "var(--text-secondary)" }}>
        Control registration access. Users can only register if their email matches one of the organization's whitelisted domain patterns.
      </p>

      {error && (
        <div className="callout callout-error" id="invite-error-msg" style={{ margin: 0 }}>
          <ShieldAlert size={18} style={{ flexShrink: 0 }} />
          <div style={{ fontSize: "0.85rem" }}>{error}</div>
        </div>
      )}

      {success && (
        <div className="callout callout-info" id="invite-success-msg" style={{ background: "rgba(16, 185, 129, 0.05)", border: "1px solid rgba(16, 185, 129, 0.2)", color: "#a7f3d0", margin: 0 }}>
          <Check size={18} style={{ color: "#10b981" }} />
          <div style={{ fontSize: "0.85rem", overflowWrap: "anywhere" }}>{success}</div>
        </div>
      )}

      {/* Whitelisted Domains Management */}
      <div>
        <h3 style={{ fontSize: "0.8rem", fontWeight: 700, color: "var(--text-secondary)", textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: "0.5rem" }}>
          Whitelisted Domain List
        </h3>
        
        <div className="whitelist-tags" style={{ marginBottom: "1rem" }}>
          {allowedDomains.map((dom) => (
            <span key={dom} className="whitelist-tag" id={`tag-${dom}`}>
              <Globe size={12} style={{ color: "var(--accent-teal)" }} />
              <span>{dom}</span>
              <X 
                id={`remove-domain-${dom}`}
                size={12} 
                className="tag-remove" 
                onClick={() => handleRemoveDomain(dom)} 
              />
            </span>
          ))}
        </div>

        <form onSubmit={handleAddDomain} style={{ display: "flex", gap: "0.5rem" }}>
          <input
            id="new-domain-input"
            type="text"
            className="input-field"
            style={{ padding: "0.6rem 0.8rem", fontSize: "0.85rem" }}
            placeholder="e.g. *.stjude.org"
            value={newDomain}
            onChange={(e) => setNewDomain(e.target.value)}
          />
          <button 
            id="add-domain-btn"
            type="submit" 
            className="btn btn-secondary" 
            style={{ padding: "0.6rem 1rem", fontSize: "0.85rem" }}
          >
            <Plus size={16} />
            <span>Add</span>
          </button>
        </form>
      </div>

      <hr style={{ border: "none", borderTop: "1px solid var(--border-color)" }} />

      {/* Invite Generator */}
      <div>
        <h3 style={{ fontSize: "0.8rem", fontWeight: 700, color: "var(--text-secondary)", textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: "0.75rem" }}>
          Reusable Invite Codes
        </h3>
        <button 
          id="generate-invite-btn"
          className="btn btn-primary" 
          style={{ width: "100%", height: "40px", fontSize: "0.85rem" }}
          onClick={handleGenerateInvite}
        >
          <Link2 size={16} />
          <span>Generate and Copy Invite Link</span>
        </button>
      </div>

      {/* List of active invites */}
      {invites.length > 0 && (
        <div style={{ flex: 1, overflowY: "auto", maxHeight: "220px", display: "flex", flexDirection: "column", gap: "0.75rem" }}>
          {invites.map((invite) => (
            <div 
              key={invite.id} 
              className="glass-card" 
              style={{ padding: "0.85rem", display: "flex", alignItems: "center", justifyContent: "space-between", background: "rgba(0,0,0,0.15)", borderRadius: "8px" }}
            >
              <div style={{ display: "flex", flexDirection: "column", gap: "0.25rem", overflow: "hidden" }}>
                <span 
                  className="invite-code-span"
                  style={{ fontSize: "0.8rem", fontWeight: 600, color: invite.isActive ? "var(--text-primary)" : "var(--text-muted)", textDecoration: invite.isActive ? "none" : "line-through" }}
                >
                  {invite.inviteCode}
                </span>
                <span style={{ fontSize: "0.7rem", color: "var(--text-muted)" }}>
                  Created: {new Date(invite.createdAt).toLocaleDateString()}
                </span>
              </div>
              <button
                id={`toggle-invite-${invite.inviteCode}`}
                className={`btn ${invite.isActive ? "btn-danger" : "btn-secondary"}`}
                style={{ padding: "0.35rem 0.75rem", fontSize: "0.7rem" }}
                onClick={() => handleToggleInvite(invite)}
              >
                <Power size={10} />
                <span>{invite.isActive ? "Revoke" : "Activate"}</span>
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
