import { useEffect, useState } from "react";
import { supabase } from "./supabase";

const OWNER_ID = "02ef4d60-c8b0-47ac-b5a4-772667e0b6cd";

export default function SuperAdminPanel() {
  const [authorized, setAuthorized] = useState(false);
  const [checking, setChecking] = useState(true);
  const [admins, setAdmins] = useState([]);
  const [audit, setAudit] = useState([]);
  const [target, setTarget] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");

  async function call(action, target_user_id) {
    const { data, error } = await supabase.functions.invoke(
      "super-admin-control",
      { body: { action, ...(target_user_id ? { target_user_id } : {}) } }
    );
    if (error) throw new Error(error.message);
    if (data?.error) throw new Error(data.error);
    return data;
  }

  async function refresh() {
    setBusy(true);
    setMessage("");
    try {
      const [a, l] = await Promise.all([
        call("list_admins"),
        call("audit_log")
      ]);
      setAdmins(a?.admins ?? a?.data ?? []);
      setAudit(l?.audit ?? l?.data ?? []);
    } catch (e) {
      setMessage(e.message);
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    let active = true;
    supabase.auth.getUser().then(({ data, error }) => {
      if (!active) return;
      const isAuthorized = !error && data?.user?.id === OWNER_ID;
      setAuthorized(isAuthorized);
      setChecking(false);
      if (isAuthorized) void refresh();
    });
    return () => { active = false; };
  }, []);

  async function changeAdmin(action) {
    const id = target.trim();
    if (!id) return setMessage("Enter the user's Supabase Auth UUID.");
    if (id === OWNER_ID) return setMessage("The Super Admin account is protected.");
    if (action === "revoke_admin" &&
        !window.confirm("Are you sure you want to revoke this admin?")) return;

    setBusy(true);
    setMessage("");
    try {
      await call(action, id);
      setTarget("");
      setMessage("Operation completed successfully.");
      await refresh();
    } catch (e) {
      setMessage(e.message);
    } finally {
      setBusy(false);
    }
  }

  const panel = {
    padding: 20, margin: "20px 0", borderRadius: 14,
    background: "var(--card-bg, #151b2b)",
    color: "var(--text-color, #fff)",
    border: "1px solid var(--border-color, #344054)"
  };
  const button = {
    padding: "10px 14px", borderRadius: 8, border: 0,
    margin: "5px", cursor: "pointer"
  };

  if (checking) return <div style={panel}>Checking Super Admin access...</div>;
  if (!authorized) return null;

  return (
    <section style={panel}>
      <div style={{fontSize: 12, opacity: .7}}>NUR2 DATA • RESTRICTED ACCESS</div>
      <h2>Super Admin Control</h2>
      <p>Manage administrator access and review security activity.</p>

      {message && (
        <div role="alert" style={{padding: 12, margin: "12px 0",
          background: "#263449", borderRadius: 8}}>
          {message}
        </div>
      )}

      <div style={{display: "flex", flexWrap: "wrap", gap: 8}}>
        <input
          value={target}
          onChange={e => setTarget(e.target.value)}
          placeholder="Admin user's Supabase UUID"
          aria-label="Admin user UUID"
          style={{flex: "1 1 240px", minWidth: 0, padding: 12,
            borderRadius: 8, border: "1px solid #667085"}}
        />
        <button style={{...button, background: "#16834a", color: "white"}}
          disabled={busy} onClick={() => changeAdmin("grant_admin")}>
          Grant Admin
        </button>
        <button style={{...button, background: "#a83232", color: "white"}}
          disabled={busy} onClick={() => changeAdmin("revoke_admin")}>
          Revoke Admin
        </button>
        <button style={button} disabled={busy} onClick={refresh}>
          Refresh
        </button>
      </div>

      <h3>Administrators</h3>
      {admins.length === 0 ? <p>No administrator records returned.</p> : (
        <div style={{overflowX: "auto"}}>
          <table style={{width: "100%", borderCollapse: "collapse"}}>
            <thead><tr><th align="left">User ID</th><th align="left">Role</th></tr></thead>
            <tbody>
              {admins.map((a, i) => (
                <tr key={a.user_id ?? a.id ?? i}>
                  <td style={{padding: 9, overflowWrap: "anywhere"}}>
                    {a.user_id ?? a.id ?? JSON.stringify(a)}
                  </td>
                  <td>{a.role ?? "Admin"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <h3>Security Audit Log</h3>
      {audit.length === 0 ? <p>No audit records returned.</p> : (
        <div style={{overflowX: "auto"}}>
          <table style={{width: "100%", borderCollapse: "collapse"}}>
            <thead><tr><th align="left">Action</th><th align="left">Actor</th><th align="left">Target</th><th align="left">Date</th></tr></thead>
            <tbody>
              {audit.map((a, i) => (
                <tr key={a.id ?? i}>
                  <td style={{padding: 8}}>{a.action}</td>
                  <td>{a.actor_user_id ?? "System"}</td>
                  <td>{a.target_user_id ?? "—"}</td>
                  <td>{a.created_at ? new Date(a.created_at).toLocaleString() : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
