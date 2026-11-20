# CodeLab fast evidence path: Cloudflare + Neon

CodeLab keeps Neon as the canonical database for PixelForge projects, revisions and evidence metadata. Cloudflare R2 is the fast object path for the PNG/video evidence itself.

Flow:

1. PixelForge saves the project in Neon/PostgreSQL.
2. CodeLab creates the evidence event in Neon.
3. CodeLab returns a short-lived, object-scoped upload URL.
4. The browser uploads the image/video directly to the Cloudflare Worker.
5. The Worker validates the HMAC upload signature and writes the object to R2.
6. The existing CodeLab evidence completion endpoint stores the resulting object reference in Neon.

This removes large evidence payloads from the CodeLab/Render request path and avoids making the editor wait on a GitHub commit just to move a visual artifact.

## Environment

CodeLab server:

- `CLOUDFLARE_EVIDENCE_BASE_URL`: public URL of the deployed Worker.
- `CLOUDFLARE_EVIDENCE_SIGNING_SECRET`: same secret configured on the Worker as `EVIDENCE_SIGNING_SECRET`.

Cloudflare Worker:

- R2 binding: `EVIDENCE_BUCKET`.
- Secret: `EVIDENCE_SIGNING_SECRET`.

The worker signs only `PUT + object key + expiry + content type`; credentials are never sent to the browser.

## Development

Use `wrangler dev` for the evidence gateway while iterating. CodeLab can point at the local Worker URL, so evidence changes can be tested without creating a GitHub commit for every visual iteration.

For production, deploy the Worker independently of the main CodeLab service. GitHub remains the source of truth for application code, while the fast evidence path is handled at the edge.

## Neon remains canonical

Do not move project state or revision metadata into R2. R2 stores binary evidence; Neon stores the event, revision, object key and lifecycle status.

## Realtime

Neon Realtime remains an optional notification layer. The current Neon project is PostgreSQL 17, so Realtime cannot be enabled yet because Neon requires PostgreSQL 18 for that capability. The Cloudflare path therefore does not pretend to replace Realtime; it simply removes the large-file transfer bottleneck.
