// public/auth.js  —  client-side tenant session bootstrap
// Loaded in <head> AFTER the supabase-js UMD bundle, on every app page.
//
// Responsibilities:
//   1. Install a fetch() interceptor that attaches the logged-in user's
//      bearer token to every /api/* call (so no per-call edits are needed).
//   2. Gate the page: if there is no session, redirect to login.html.
//   3. On any 401 from the API, bounce to login.
//
// The anon key is public-safe (it only grants what RLS allows) — it's set on
// window by /config.js (netlify/functions/public-config.js), which reads the
// SUPABASE_URL / SUPABASE_ANON_KEY env vars for the current deploy context, so
// this file loads a different Supabase project locally, on a branch deploy, or
// in production without ever hardcoding a project into the page. Load
// /config.js before this script.
(function () {
  var SUPABASE_URL = window.SUPABASE_URL;
  var SUPABASE_ANON_KEY = window.SUPABASE_ANON_KEY;

  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
    console.error(
      "[auth] window.SUPABASE_URL / SUPABASE_ANON_KEY are not set — " +
      "make sure /config.js loads before auth.js and SUPABASE_URL / " +
      "SUPABASE_ANON_KEY are set in the environment (see .env.example)."
    );
    return;
  }

  if (!window.supabase || !window.supabase.createClient) {
    console.error("[auth] supabase-js must load before auth.js");
    return;
  }

  var sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: { persistSession: true, autoRefreshToken: true }
  });

  var token = null;
  var publicPage =
    location.pathname.endsWith("login.html") ||
    location.pathname.endsWith("set-password.html");

  function toLogin() {
    if (!publicPage) {
      location.replace(
        "login.html?next=" + encodeURIComponent(location.pathname + location.search)
      );
    }
  }

  // ── fetch interceptor: stamp Authorization on /api/* calls ──────────
  var _fetch = window.fetch.bind(window);
  window.fetch = async function (input, init) {
    init = init || {};
    var url = typeof input === "string" ? input : (input && input.url) || "";
    if (url.indexOf("/api/") === -1) return _fetch(input, init);

    if (!token) {
      var s = await sb.auth.getSession();
      token = (s.data && s.data.session && s.data.session.access_token) || null;
    }
    var headers = new Headers(
      init.headers || (typeof input !== "string" && input.headers) || {}
    );
    if (token) headers.set("Authorization", "Bearer " + token);

    var res = await _fetch(input, Object.assign({}, init, { headers: headers }));
    if (res.status === 401) toLogin();
    return res;
  };

  sb.auth.onAuthStateChange(function (_e, session) {
    token = (session && session.access_token) || null;
  });

  // ── page gate ───────────────────────────────────────────────────────
  if (!publicPage) {
    sb.auth.getSession().then(function (s) {
      token = (s.data && s.data.session && s.data.session.access_token) || null;
      if (!token) toLogin();
    });
  }

  window.TakeoffAuth = {
    client: sb,
    getToken: function () { return token; },
    signOut: async function () { await sb.auth.signOut(); location.replace("login.html"); }
  };
})();
