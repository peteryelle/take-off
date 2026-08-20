// netlify/functions/public-config.js
// Serves the browser-safe Supabase URL + anon key as a small JS snippet, read
// from server env vars for the *current* deploy context (production, a branch
// deploy, or local `netlify dev`). This is what lets public/auth.js resolve
// the right Supabase project per environment instead of a value baked into
// the file — see public/auth.js for why the anon key itself is safe to serve.

export default async function handler() {
  const url = process.env.SUPABASE_URL || "";
  const anonKey = process.env.SUPABASE_ANON_KEY || "";

  const body = `window.SUPABASE_URL = ${JSON.stringify(url)};\n` +
               `window.SUPABASE_ANON_KEY = ${JSON.stringify(anonKey)};\n`;

  return new Response(body, {
    status: 200,
    headers: {
      "Content-Type": "application/javascript",
      "Cache-Control": "no-store"
    }
  });
}

export const config = { path: "/config.js" };
