export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method !== "PUT" || !url.pathname.startsWith("/evidence/")) {
      return new Response("Cloudflare evidence gateway", { status: 200 });
    }

    const key = decodeURIComponent(url.pathname.slice("/evidence/".length));
    const expires = Number(url.searchParams.get("expires") || 0);
    const signature = url.searchParams.get("sig") || "";
    const contentType = request.headers.get("content-type") || "application/octet-stream";

    if (!key || key.includes("..") || key.startsWith("/") || !Number.isFinite(expires)) {
      return new Response("invalid evidence request", { status: 400 });
    }
    if (Date.now() > expires * 1000) {
      return new Response("evidence upload expired", { status: 401 });
    }

    const payload = ["PUT", key, String(expires), contentType].join("\n");
    const expected = await hmacHex(env.EVIDENCE_SIGNING_SECRET, payload);
    if (!timingSafeEqual(signature, expected)) {
      return new Response("invalid evidence signature", { status: 403 });
    }

    await env.EVIDENCE_BUCKET.put(key, request.body, {
      httpMetadata: { contentType, cacheControl: "public, max-age=31536000, immutable" }
    });

    return new Response(JSON.stringify({
      ok: true,
      objectKey: key,
      url: new URL("/evidence/" + encodeURIComponent(key), request.url).toString()
    }), {
      status: 201,
      headers: { "content-type": "application/json", "cache-control": "no-store" }
    });
  }
};

async function hmacHex(secret, value) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const bytes = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value)));
  return [...bytes].map(b => b.toString(16).padStart(2, "0")).join("");
}

function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
