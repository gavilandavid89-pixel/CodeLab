import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";

const BUCKET = "codelab-agent-projects";
const PREFIX = "incoming/";
const CHUNK_BYTES = 1024 * 1024;
const MAX_BYTES = 256 * 1024 * 1024;

const sha256 = value => createHash("sha256").update(value).digest("hex");
const json = (data, status = 200) => new Response(JSON.stringify(data), {
  status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }
});
function env(name) {
  const value = String(process.env[name] || "").trim();
  if (!value) throw new Error("missing_env_" + name);
  return value;
}
function equal(a, b) {
  const x = Buffer.from(String(a || "")), y = Buffer.from(String(b || ""));
  return x.length > 0 && x.length === y.length && timingSafeEqual(x, y);
}
function signS3(method, key, body = new Uint8Array(), contentType = "") {
  const endpoint = new URL(env("AWS_ENDPOINT_URL_S3"));
  if (endpoint.protocol !== "https:" || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) {
    throw new Error("invalid_s3_endpoint");
  }
  const region = env("AWS_REGION");
  const accessKey = env("AWS_ACCESS_KEY_ID");
  const secretKey = env("AWS_SECRET_ACCESS_KEY");
  const uri = endpoint.pathname.replace(/\/$/, "") + "/" + BUCKET + "/" +
    key.split("/").map(encodeURIComponent).join("/");
  const url = new URL(endpoint.origin + uri);
  const payloadHash = sha256(body);
  const amzDate = new Date().toISOString().replace(/[:-]|\.\d{3}/g, "");
  const date = amzDate.slice(0, 8);
  const headers = {
    "x-amz-content-sha256": payloadHash,
    "x-amz-date": amzDate
  };
  if (contentType) headers["content-type"] = contentType;
  if (process.env.AWS_SESSION_TOKEN) headers["x-amz-security-token"] = process.env.AWS_SESSION_TOKEN;
  const signed = [...Object.keys(headers).map(x => x.toLowerCase()), "host"].sort();
  const canonicalHeaders = signed.map(name =>
    name + ":" + String(name === "host" ? url.host : headers[name]).trim().replace(/\s+/g, " ") + "\n"
  ).join("");
  const signedHeaders = signed.join(";");
  const canonical = [method, uri, "", canonicalHeaders, signedHeaders, payloadHash].join("\n");
  const scope = date + "/" + region + "/s3/aws4_request";
  const stringToSign = ["AWS4-HMAC-SHA256", amzDate, scope, sha256(Buffer.from(canonical))].join("\n");
  const h = (k, v) => createHmac("sha256", k).update(v, "utf8").digest();
  const kDate = h("AWS4" + secretKey, date);
  const kRegion = h(kDate, region);
  const kService = h(kRegion, "s3");
  const kSigning = h(kService, "aws4_request");
  headers.authorization = "AWS4-HMAC-SHA256 Credential=" + accessKey + "/" + scope +
    ", SignedHeaders=" + signedHeaders + ", Signature=" +
    createHmac("sha256", kSigning).update(stringToSign).digest("hex");
  return { url, headers, body };
}
async function putObject(key, bytes) {
  const signed = signS3("PUT", key, bytes, "application/zip");
  const response = await fetch(signed.url, {
    method: "PUT", headers: signed.headers, body: signed.body, redirect: "error",
    signal: AbortSignal.timeout(120000)
  });
  if (!response.ok) throw new Error("neon_storage_put_http_" + response.status);
}
async function getObject(key) {
  const signed = signS3("GET", key);
  const response = await fetch(signed.url, {
    method: "GET", headers: signed.headers, redirect: "error",
    signal: AbortSignal.timeout(120000)
  });
  if (!response.ok) throw new Error("neon_storage_get_http_" + response.status);
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (!bytes.length || bytes.length > MAX_BYTES) throw new Error("project_package_size_invalid");
  return bytes;
}
function filenameOnly(value) {
  const name = String(value || "project.codelab");
  if (name !== name.split(/[\\/]/).pop() ||
      !/^[A-Za-z0-9][A-Za-z0-9._ -]{0,170}\.codelab$/i.test(name)) {
    throw new Error("invalid_project_package_filename");
  }
  return name;
}
async function upload(request, url) {
  if (!equal(request.headers.get("x-codelab-project-folder-token"), env("CODELAB_PROJECT_FOLDER_SECRET"))) {
    return json({ error: "unauthorized" }, 401);
  }
  const filename = filenameOnly(url.searchParams.get("filename"));
  const bytes = new Uint8Array(await request.arrayBuffer());
  if (!bytes.length || bytes.length > MAX_BYTES) return json({ error: "project_package_size_invalid" }, 413);
  const objectKey = PREFIX + Date.now() + "-" + randomUUID() + "/" + filename;
  await putObject(objectKey, bytes);
  return json({
    ok: true, status: "uploaded", bucket: BUCKET, objectKey,
    sizeBytes: bytes.length, sha256: sha256(bytes), trigger: "storage_object_created"
  }, 202);
}
async function processUpload(request) {
  const headerId = request.headers.get("x-neon-trigger-invocation-id");
  let delivery;
  try { delivery = await request.json(); } catch { return json({ error: "invalid_trigger_json" }, 400); }
  const key = delivery?.data?.object_key;
  if (!headerId || delivery?.invocation_id !== headerId ||
      delivery?.trigger?.type !== "storage_object_created" ||
      delivery?.data?.bucket_name !== BUCKET ||
      typeof key !== "string" || !key.startsWith(PREFIX)) {
    return json({ error: "invalid_trigger_delivery" }, 401);
  }
  const filename = filenameOnly(key.split("/").pop());
  const bytes = await getObject(key);
  const digest = sha256(bytes);
  const server = new URL(env("CODELAB_SERVER_URL"));
  if (server.protocol !== "https:" || server.hostname !== "codelab-qedi.onrender.com") {
    throw new Error("codelab_server_origin_invalid");
  }
  const token = env("CODELAB_PROJECT_FOLDER_SECRET");
  const authHeaders = { "x-codelab-agent-bridge-token": token, "content-type": "application/json" };
  const chunks = Math.ceil(bytes.length / CHUNK_BYTES);
  const importRequestId = "folder-" + sha256(key).slice(0, 40);
  const manifestResponse = await fetch(new URL("/api/agent/bridge/artifacts", server), {
    method: "POST", headers: authHeaders,
    body: JSON.stringify({
      artifact_kind: "codelab_zip_upload", editor_id: "pixelforge",
      target_workspace_id: "ws_local_admin", source_project_id: null,
      import_request_id: importRequestId, filename,
      project_name: filename.replace(/\.codelab$/i, ""),
      total_bytes: bytes.length, total_chunks: chunks, sha256: digest
    }),
    signal: AbortSignal.timeout(60000)
  });
  const manifest = await manifestResponse.json().catch(() => ({}));
  if (!manifestResponse.ok || !manifest.artifactId) {
    throw new Error("artifact_manifest_http_" + manifestResponse.status + ":" + String(manifest.error || "invalid_response"));
  }
  const artifactId = String(manifest.artifactId);
  for (let i = 0; i < chunks; i++) {
    const part = bytes.subarray(i * CHUNK_BYTES, Math.min(bytes.length, (i + 1) * CHUNK_BYTES));
    const response = await fetch(new URL("/api/agent/bridge/artifacts/" + artifactId + "/" + i, server), {
      method: "PUT",
      headers: { "x-codelab-agent-bridge-token": token, "content-type": "application/octet-stream" },
      body: part, signal: AbortSignal.timeout(60000)
    });
    if (!response.ok) {
      const detail = await response.json().catch(() => ({}));
      throw new Error("artifact_chunk_http_" + response.status + ":" + String(detail.error || i));
    }
  }
  const commitResponse = await fetch(new URL("/api/agent/bridge/artifacts/" + artifactId + "/commit", server), {
    method: "POST", headers: authHeaders, body: JSON.stringify({ sha256: digest }),
    signal: AbortSignal.timeout(60000)
  });
  const commit = await commitResponse.json().catch(() => ({}));
  if (!commitResponse.ok || !["queued", "verified"].includes(String(commit.status))) {
    throw new Error("artifact_commit_http_" + commitResponse.status + ":" + String(commit.error || commit.status || "invalid_response"));
  }
  return {
    ok: true, status: commit.status, commandId: commit.commandId || null,
    artifactId, importRequestId, objectKey: key, workspaceId: "ws_local_admin",
    filename, sizeBytes: bytes.length, chunkCount: chunks, sourceSha256: digest
  };
}
export default {
  async fetch(request) {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/health") {
      return json({
        ok: true, service: "pixelforge-project-folder",
        storageConfigured: Boolean(process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY && process.env.AWS_ENDPOINT_URL_S3),
        serverConfigured: Boolean(process.env.CODELAB_SERVER_URL && process.env.CODELAB_PROJECT_FOLDER_SECRET)
      });
    }
    if (request.method === "POST" && url.pathname === "/upload") {
      try { return await upload(request, url); }
      catch (error) {
        console.error("[PixelForge Project Folder] upload failed:", String(error.message || error).slice(0, 240));
        return json({ error: "project_folder_upload_failed", detail: String(error.message || error).slice(0, 180) }, 502);
      }
    }
    if (request.method === "POST" && url.pathname === "/on-upload") {
      try { return json(await processUpload(request)); }
      catch (error) {
        console.error("[PixelForge Project Folder] import failed:", String(error.message || error).slice(0, 300));
        return json({ error: "project_folder_import_failed", detail: String(error.message || error).slice(0, 220) }, 502);
      }
    }
    return json({ error: "not_found" }, 404);
  }
};
