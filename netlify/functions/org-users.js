// netlify/functions/org-users.js
// Org-scoped user management. Only owner/admin may act.
//
// GET  /api/org-users                         → list members of caller's org
// POST /api/org-users { action:"invite", email, role }
// POST /api/org-users { action:"update_role", user_id, role }
// POST /api/org-users { action:"remove", user_id }
//
// Invites: an admin invites into THEIR OWN org. We mint a Supabase invite link
// (carrying org_id + role in user_metadata so handle_new_user places the new
// user correctly) and email it via Resend. The invitee sets their password on
// set-password.html.
// ─────────────────────────────────────────────────────────────────

import { ok, err, CORS } from "./utils/clients.js";
import { requireOrg } from "./utils/auth.js";
import { sendEmail } from "./utils/email.js";

const ROLES = ["owner", "admin", "member"];

function canActorSet(actorRole, targetRole) {
  // owner can grant any role; admin can grant admin/member but not owner
  if (actorRole === "owner") return ROLES.includes(targetRole);
  if (actorRole === "admin") return targetRole === "admin" || targetRole === "member";
  return false;
}

export default async function handler(req) {
  if (req.method === "OPTIONS") return new Response("", { headers: CORS });

  const gate = await requireOrg(req);
  if (gate.error) return gate.error;
  const { supabase, orgId, role, user } = gate;

  if (role !== "owner" && role !== "admin")
    return err("Only an organization owner or admin can manage users", 403);

  // ── GET: list members ───────────────────────────────────────────
  if (req.method === "GET") {
    const { data, error } = await supabase
      .from("profiles")
      .select("user_id, email, role, created_at")
      .eq("org_id", orgId)
      .order("created_at", { ascending: true });
    if (error) return err(error.message, 500);
    return ok({ members: data, me: user.id });
  }

  if (req.method !== "POST") return err("Method not allowed", 405);

  let body;
  try { body = await req.json(); } catch { return err("Invalid JSON"); }
  const { action } = body;

  // ── invite a new member into this org ───────────────────────────
  if (action === "invite") {
    const email = (body.email || "").trim().toLowerCase();
    const inviteRole = body.role || "member";
    if (!email) return err("email required");
    if (!ROLES.includes(inviteRole)) return err("invalid role");
    if (!canActorSet(role, inviteRole))
      return err("You cannot grant that role", 403);

    const origin = new URL(req.url).origin;
    const { data, error } = await supabase.auth.admin.generateLink({
      type: "invite",
      email,
      options: {
        data: { org_id: orgId, role: inviteRole },
        redirectTo: `${origin}/set-password.html`
      }
    });
    if (error) {
      // most common: user already exists somewhere
      return err(error.message || "Could not create invite", 400);
    }

    const link = data?.properties?.action_link;
    if (!link) return err("Invite link generation failed", 500);

    try {
      await sendEmail({
        to: email,
        subject: "You're invited to Take-off",
        html: `
          <div style="font-family:system-ui,Arial,sans-serif;max-width:480px;margin:0 auto;color:#1a1a1a">
            <h2 style="color:#b8860b">Take-off</h2>
            <p>You've been invited to join an organization on Take-off as <b>${inviteRole}</b>.</p>
            <p><a href="${link}" style="display:inline-block;background:#f0c040;color:#111;
                  padding:10px 18px;border-radius:4px;text-decoration:none;font-weight:bold">
                  Accept invite &amp; set password</a></p>
            <p style="color:#666;font-size:12px">If you weren't expecting this, you can ignore this email.</p>
          </div>`,
        text: `You've been invited to Take-off as ${inviteRole}. Accept and set your password: ${link}`
      });
    } catch (e) {
      return err(`Invite created but email failed to send: ${e.message}`, 502);
    }

    return ok({ invited: email, role: inviteRole });
  }

  // ── change a member's role ──────────────────────────────────────
  if (action === "update_role") {
    const { user_id } = body;
    const newRole = body.role;
    if (!user_id || !newRole) return err("user_id and role required");
    if (!ROLES.includes(newRole)) return err("invalid role");
    if (!canActorSet(role, newRole)) return err("You cannot grant that role", 403);

    const { data: target, error: tErr } = await supabase
      .from("profiles").select("user_id, role").eq("user_id", user_id).eq("org_id", orgId).maybeSingle();
    if (tErr) return err(tErr.message, 500);
    if (!target) return err("Member not found in your organization", 404);

    // don't strip the last owner
    if (target.role === "owner" && newRole !== "owner") {
      const { count } = await supabase
        .from("profiles").select("user_id", { count: "exact", head: true })
        .eq("org_id", orgId).eq("role", "owner");
      if ((count ?? 0) <= 1) return err("Cannot demote the only owner", 409);
    }

    const { error } = await supabase
      .from("profiles").update({ role: newRole }).eq("user_id", user_id).eq("org_id", orgId);
    if (error) return err(error.message, 500);
    return ok({ user_id, role: newRole });
  }

  // ── remove a member ─────────────────────────────────────────────
  if (action === "remove") {
    const { user_id } = body;
    if (!user_id) return err("user_id required");

    const { data: target, error: tErr } = await supabase
      .from("profiles").select("user_id, role").eq("user_id", user_id).eq("org_id", orgId).maybeSingle();
    if (tErr) return err(tErr.message, 500);
    if (!target) return err("Member not found in your organization", 404);

    if (target.role === "owner") {
      const { count } = await supabase
        .from("profiles").select("user_id", { count: "exact", head: true })
        .eq("org_id", orgId).eq("role", "owner");
      if ((count ?? 0) <= 1) return err("Cannot remove the only owner", 409);
    }

    // delete the auth user; the profile cascades (profiles.user_id FK ON DELETE CASCADE)
    const { error } = await supabase.auth.admin.deleteUser(user_id);
    if (error) return err(error.message, 500);
    return ok({ removed: user_id });
  }

  return err("Unknown action", 400);
}

export const config = { path: "/api/org-users" };
