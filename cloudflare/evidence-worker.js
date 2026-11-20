const CORS_HEADERS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "PUT,GET,HEAD,OPTIONS",
  "access-control-allow-headers": "content-type",
  "access-control-max-age": "86400"
};

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    if (!url.pathname.startsWith("/evidence/")) {
      return new Response("Cloudflare evidence gateway", {
        status: 200,
        headers: CORS_HEADERS
      });
    }

    const key = decodeURIComponent(url.pathname.slice("/evidence/".length));
    if (!isSafeObjectKey(key)) {
      return json({ error: "invalid evidence object key" }, 400);
    }

    if (request.method === "GET" || request.method === "HEAD") {
      const object = await env.EVIDENCE_BUCKET.get(key);
      if (!object) {
        return json({ error: "evidence_not_found" }, 404);
      }

      const headers = new Headers(CORS_HEADERS);
      object.writeHttpMetadata(headers);
      headers.set("cache-control", "public, max-age=31536000, immutable");
      headers.set("etag", object.httpEtag);

      if (request.method === "HEAD") {
        return new Response(null, { status: 200, headers });
      }

      return new Response(object.body, { status: 200, headers });
    }

    if (request.method !== "PUT") {
      return json({ error: "method_not_allowed" }, 405);
    }

    const expires = Number(url.searchParams.get("expires") || 0);
    const signature = url.searchParams.get("sig") || "";
    const contentType = request.headers.get("content-type") || "application/octet-stream";

    if (!Number.isSafeInteger(expires) || !signature || !env.EVIDENCE_SIGNING_SECRET) {
      return json({ error: "invalid evidence request" }, 400);
    }
    if (Date.now() > expires * 1000) {
      return json({ error: "evidence_upload_expired" }, 401);
    }

    const payload = ["PUT", key, String(expires), contentType].join("\\n");
    const expected = await hmacHex(env.EVIDENCE_SIGNING_SECRET, payload);
    if (!timingSafeEqual(signature, expected)) {
      return json({ error: "invalid evidence signature" }, 403);
    }

    await env.EVIDENCE_BUCKET.put(key, request.body, {
      httpMetadata: {
        contentType,
        cacheControl: "public, max-age=31536000, immutable"
      }
    });

    return json({
      ok: true,
      objectKey: key,
      url: new URL("/evidence/" + key.split("/").map(encodeURIComponent).join("/"), request.url).toString()
    }, 201);
  }
};

function isSafeObjectKey(key) {
  return !!key &&
    !key.startsWith("/") &&
    !key.includes("..") &&
    !key.includes("\\0") &&
    key.length <= 1024;
}

async function hmacHex(secret, value) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const bytes = new Uint8Array(
    await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value))
  );
  return [...bytes].map(b => b.toString(16).padStart(2, "0")).join("");
}

function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

function json(value, status) {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      ...CORS_HEADERS,
      "content-type": "application/json",
      "cache-control": "no-store"
    }
  });
}
