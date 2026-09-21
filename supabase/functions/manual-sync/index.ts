import "jsr:@supabase/functions-js/edge-runtime.d.ts";

// Triggered by the dashboard's "Sync Now" button. Supabase already verifies
// the caller's JWT before invoking this function (verify_jwt: true), so any
// request that reaches here is from a logged-in user.
Deno.serve(async (req: Request) => {
  const GH_OWNER = Deno.env.get("GH_OWNER");
  const GH_REPO = Deno.env.get("GH_REPO");
  const GH_DISPATCH_TOKEN = Deno.env.get("GH_DISPATCH_TOKEN");

  if (!GH_OWNER || !GH_REPO || !GH_DISPATCH_TOKEN) {
    return new Response(JSON.stringify({ error: "Function not configured" }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }

  const ghRes = await fetch(
    `https://api.github.com/repos/${GH_OWNER}/${GH_REPO}/actions/workflows/sync.yml/dispatches`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${GH_DISPATCH_TOKEN}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
      body: JSON.stringify({ ref: "main" }),
    }
  );

  if (!ghRes.ok) {
    const text = await ghRes.text();
    return new Response(JSON.stringify({ error: "GitHub dispatch failed", detail: text }), {
      status: 502,
      headers: { "Content-Type": "application/json" },
    });
  }

  return new Response(JSON.stringify({ ok: true, message: "Sync triggered" }), {
    headers: { "Content-Type": "application/json" },
  });
});
