// netlify/functions/pdf-storage-url.js
// Issues short-lived signed URLs against the private "schematics" Storage bucket
// for the project's persisted drawing-set PDF. The function never touches the PDF
// bytes themselves — the client uploads/downloads directly to/from Storage using
// the signed URL this returns, which is what keeps a multi-page drawing set (often
// tens of MB) off the Netlify Functions payload/timeout ceiling entirely.
//
// POST /api/pdf-storage-url
//   { project_id, mode: 'upload', filename }   -> { url, path, token }
//     Client then PUTs the file bytes directly to `url`, then calls
//     POST /api/projects { action:'update_project', project_id, pdf_storage_path: path }
//     to record it (same call already used for pdf_filename/pdf_page_count).
//   { project_id, mode: 'download' }            -> { url } | { url: null } if none stored
//     Reads projects.pdf_storage_path; null means this project has no persisted
//     PDF yet (pre-dates this feature, or the upload step never completed) — the
//     client falls back to the manual re-attach prompt in that case.
// ─────────────────────────────────────────────────────────────────

import { getSupabase, ok, err, CORS } from "./utils/clients.js";
import { requireOrg, assertProjectInOrg } from "./utils/auth.js";

const BUCKET = "schematics";
const UPLOAD_URL_TTL_SEC   = 300;   // 5 min — plenty for a browser to start the PUT
const DOWNLOAD_URL_TTL_SEC = 3600;  // 1 hr — one project-load session

export default async function handler(req) {
  if (req.method === "OPTIONS") return new Response("", { headers: CORS });
  if (req.method !== "POST")    return err("POST required", 405);

  let body;
  try { body = await req.json(); } catch { return err("Invalid JSON"); }

  const { project_id, mode, filename } = body;
  if (!project_id || !mode) return err("project_id and mode required");

  const gate = await requireOrg(req);
  if (gate.error) return gate.error;
  const { supabase, orgId } = gate;

  if (!(await assertProjectInOrg(supabase, project_id, orgId)))
    return err("Project not found in your organization", 404);

  if (mode === "upload") {
    if (!filename) return err("filename required for mode:'upload'");
    // Keyed by project so a re-upload naturally replaces the prior file at the
    // same path — no orphaned objects to clean up across re-uploads.
    const path = `${project_id}/${filename}`;

    const { data, error } = await supabase.storage
      .from(BUCKET)
      .createSignedUploadUrl(path);
    if (error) return err(error.message, 500);

    return ok({ url: data.signedUrl, path, token: data.token });
  }

  if (mode === "download") {
    const { data: project, error: pErr } = await supabase
      .from("projects").select("pdf_storage_path").eq("id", project_id).maybeSingle();
    if (pErr) return err(pErr.message, 500);
    if (!project?.pdf_storage_path) return ok({ url: null });

    const { data, error } = await supabase.storage
      .from(BUCKET)
      .createSignedUrl(project.pdf_storage_path, DOWNLOAD_URL_TTL_SEC);
    if (error) return err(error.message, 500);

    const filename = project.pdf_storage_path.split("/").pop();
    return ok({ url: data.signedUrl, filename });
  }

  return err("mode must be 'upload' or 'download'");
}

export const config = { path: "/api/pdf-storage-url" };
