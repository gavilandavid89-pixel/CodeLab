# CodeLab — Neon integration and animation persistence

## Neon is part of the CodeLab data path

CodeLab uses **Neon Postgres** as the database connection for CodeLab's persistent project state. The Neon-backed data layer is the source of truth for project data that must survive browser sessions and deployments.

### Project creation and modification

Project operations that change persistent CodeLab projects must be treated as database-backed operations:

- create a project
- edit project metadata
- modify project structure/design data
- modify web-space data
- save project revisions
- update project state used by the editor

When implementing or repairing these operations, keep the Neon persistence layer connected to the editor/API flow. Do not replace the persistent Neon path with local-only state or browser storage as the authoritative project store.

Browser/local state may be used for UI caching or temporary editor state, but it must not silently become the canonical storage path for persistent project modifications.

## Neon and PixelForge animation

The animation editor/workflow is part of the same persistent CodeLab project system.

Animation-related project changes include:

- animation frames and frame metadata
- FPS/timing
- animation configuration
- PixelForge document/layer state
- edits to the soldier animation
- visual revisions and saved versions

When an animation is modified from CodeLab, the resulting project/animation state must remain associated with the corresponding CodeLab project through the Neon-backed persistence path.

### Soldier animation

The current soldier animation work is in:

- `public/pixelforge/src/showcase-animation.mjs`

The animation is generated as a raster PixelForge animation and currently uses a 60-frame showcase with configurable FPS. Changes to the soldier gait, frames, visual details, or animation settings are project changes and therefore belong to the same persistent CodeLab project lifecycle.

## Implementation rule

**CodeLab → project editor/API → Neon persistence → project/animation state**

Do not introduce a second unrelated persistence mechanism for project modifications or animation state without explicitly updating this architecture document and the corresponding data flow.

## Current animation revision

The soldier walking cycle was refined in commit:

`7d18a3ea29a1dc54c4d48382cb552c8eaf34366b`

The revision improves the gait using alternating foot-lift phases, knee movement, arm/hand counter-motion, torso sway and a 20-frame gait cycle while retaining the existing PixelForge 60-frame showcase.

## Maintenance

Any future work that changes how CodeLab saves, loads, edits, versions, or persists projects/animations should update this document if the Neon data path or animation persistence behavior changes.
