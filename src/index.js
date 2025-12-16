export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    const cors = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
      "Access-Control-Allow-Headers": "content-type,x-api-key",
      "Cache-Control": "no-store"
    };

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: cors });
    }

    if (url.pathname === "/players" && request.method === "GET") {
      const json = await env.LIVE.get("snapshot");
      return new Response(
        json || JSON.stringify({ updatedAt: null, placeId: null, jobId: null, players: [] }),
        { headers: { "content-type": "application/json", ...cors } }
      );
    }

    if (url.pathname === "/update" && request.method === "POST") {
      const key = request.headers.get("x-api-key") || "";
      if (!env.API_KEY || key !== env.API_KEY) {
        return new Response(JSON.stringify({ error: "Unauthorized" }), {
          status: 401,
          headers: { "content-type": "application/json", ...cors }
        });
      }

      let body;
      try {
        body = await request.json();
      } catch {
        return new Response(JSON.stringify({ error: "Invalid JSON" }), {
          status: 400,
          headers: { "content-type": "application/json", ...cors }
        });
      }

      const players = Array.isArray(body.players) ? body.players : null;
      if (!players) {
        return new Response(JSON.stringify({ error: "Invalid payload" }), {
          status: 400,
          headers: { "content-type": "application/json", ...cors }
        });
      }

      const snapshot = {
        updatedAt: new Date().toISOString(),
        placeId: body.placeId ?? null,
        jobId: body.jobId ?? null,
        players: players.map(p => ({
          userId: Number(p.userId),
          username: String(p.username || ""),
          displayName: String(p.displayName || ""),
          team: p.team ? String(p.team) : null
        }))
      };

      await env.LIVE.put("snapshot", JSON.stringify(snapshot));

      return new Response(JSON.stringify({ ok: true }), {
        headers: { "content-type": "application/json", ...cors }
      });
    }

    return new Response("Not found", { status: 404, headers: cors });
  }
};
