# CodeLab ↔ Penpot native document contract

Status: partial implementation. A bounded CodeLab-native JSON persistence endpoint now exists; Penpot Transit/RPC compatibility, native serializer validation, asset lifecycle and generator mapping remain pending.

## Existing CodeLab persistence boundary

The current CodeLab host already has:
- authenticated account sessions and deterministic account workspace IDs;
- workspace state persisted in the existing PostgreSQL table `codelab_workspace_states` (with a file-backed local fallback);
- project records inside each workspace state;
- optimistic concurrency through the workspace `revision` and conflict responses;
- project-level `design` data, currently validated as an object with an optional `elements` array.

The Penpot integration must extend this boundary rather than create a second account, workspace, project, or database system.

## Project-facing contract

A CodeLab project remains the owner of the design. Its design payload will gain a versioned Penpot-native document envelope while legacy CodeLab design fields remain readable:

```json
{
  "design": {
    "format": "codelab-penpot-document",
    "version": 1,
    "engine": {
      "name": "penpot",
      "upstream": "2.19.0",
      "commit": "f66e5afa70e7d5e039b79cee758bf8e03510ad3e"
    },
    "document": {},
    "screenIndex": [],
    "prototypeGraph": [],
    "generatorSnapshot": {
      "pages": [],
      "components": [],
      "tokens": [],
      "assets": []
    },
    "updatedAt": null
  }
}
```

The empty objects/arrays above are schema examples, not a claim that Penpot's internal document has already been mapped. The exact native document serialization and identifiers must be taken from the pinned Penpot source and verified against its own serialization tests before writing an adapter.

## Ownership and persistence rules

1. CodeLab authenticates the request and derives the workspace from the signed-in session; a client-supplied workspace ID never grants access.
2. The project ID must exist in that authenticated workspace before a document can be read or written.
3. Save operations use the existing workspace revision/optimistic concurrency contract. A stale editor cannot silently overwrite a newer save.
4. Penpot document bytes/JSON are stored under the same CodeLab PostgreSQL connection and workspace ownership. No second Postgres instance, independent user directory, or external asset bucket is introduced.
5. Large binary assets must use CodeLab's existing durable storage conventions with metadata/ownership tied to the project. Do not place unbounded base64 data in project JSON.
6. The generator reads the saved native document through a server-side adapter. It must not require users to export a file and upload it again.
7. Legacy `design.elements` remains readable during migration. Do not silently discard existing CodeLab designs.
8. The generator-facing snapshot is derived data and can be rebuilt from the native document; it is not a competing source of truth.

## Required adapter behavior

- Pages/boards: preserve stable native IDs, order, names, dimensions and background.
- Layers/shapes: preserve parent-child order, transforms, visibility, locking, geometry, fills, strokes and text style.
- Components/variants: preserve component identity and instance relationships.
- Tokens/styles: map color, typography, spacing, radius and effect tokens to CodeLab's design system without flattening source semantics.
- Prototype graph: preserve source/target page and node IDs, trigger, action, transition and navigation semantics.
- Assets: preserve references and media type; resolve them through CodeLab-owned storage.
- Incremental updates: keep document version/revision and reject stale writes.
- Generator: derive responsive screen structure and interaction graph from the saved document, while keeping PixelForge as the existing animation engine.

## Security and limits

The current workspace API has bounded request bodies and project validation. Native documents will need explicit limits for serialized document size, page count, node count, nesting depth, asset count and per-asset bytes. Limits must be enforced before database writes and must return stable machine-readable errors. Do not raise global request limits just to accommodate design documents; use bounded chunked uploads for binary assets if required.

## Implementation sequence

1. Confirm Penpot's canonical document serialization and save lifecycle from source/tests.
2. Add a versioned CodeLab storage adapter using the existing account/workspace authorization and PostgreSQL pool.
3. Add read/write endpoints with optimistic concurrency and bounded payload validation.
4. Add an adapter that derives the CodeLab generator snapshot from the native document.
5. Add integration tests for ownership, cross-account denial, revision conflicts, multi-page save/reopen, prototype graph round-trip, and generator parity.
6. Only then connect the Penpot workspace UI to those CodeLab endpoints.

## Implemented persistence endpoint (partial)

The branch now exposes a project-scoped persistence route:

- `GET /api/workspace/:workspaceId/projects/:projectId/penpot-document`
- `PUT /api/workspace/:workspaceId/projects/:projectId/penpot-document`

Both operations require the existing CodeLab workspace authorization. The project must already exist in the workspace. The PUT body contains `document` and `baseRevision`; the workspace revision is checked before writing. A successful write stores a versioned envelope at `project.design.penpotDocument` and increments the existing workspace revision. The serialized JSON document is capped at 8 MiB. No separate database or storage service is created.

This endpoint is deliberately a persistence boundary, not yet Penpot's complete backend API. It does not implement Penpot's Transit RPC method surface, per-file WebSocket collaboration/presence, native file migrations, binary asset upload lifecycle, or the upstream frontend's full save orchestration. Those must be adapted before the native workspace can use this route as its only backend.

## Explicitly not implemented yet

This contract does not claim that Penpot's full editor dependency closure is vendored or buildable, that native Transit document serialization is implemented, or that the Penpot workspace can currently save/reopen through its complete application lifecycle. Those remain required implementation gates.
