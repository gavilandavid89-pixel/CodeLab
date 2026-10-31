# CodeLab native account system

## Goal
Replace mandatory Google/GitHub OAuth with CodeLab-managed username/password accounts. OAuth can remain optional, but it must not be required to sign in.

## Implemented in this change
- `POST /api/auth/login`: username/password login; usernames are normalized to uppercase.
- `ADMIN_BOOTSTRAP_PASSWORD`: on first boot, if no local ADMIN exists, creates the `ADMIN` account when this secret is at least 16 characters. It is never overwritten if the account already exists.
- Passwords are stored as salted scrypt hashes, not plaintext.
- Auth sessions use the existing HttpOnly, SameSite=Lax session cookie.
- `POST /api/auth/change-password`: authenticated local users can change their password; minimum 16 characters. Bootstrap ADMIN is marked to change its password on first login.
- `GET /api/admin/accounts` and `POST /api/admin/accounts`: admin-only account listing and creation of regular user accounts; password hashes are never returned.
- Native login attempts are throttled per client IP and username.
- Local account workspaces use a distinct `local` provider namespace.

## Deployment requirements
1. Set a strong random `ADMIN_BOOTSTRAP_PASSWORD` secret in the CodeLab Render service environment before relying on native login. Do not put it in source control, issue bodies, logs, or documentation.
2. **Do not enable `ADMIN_BOOTSTRAP_PASSWORD` yet.** The current CodeLab Render service is on the Free plan and its service metadata does not show a persistent disk. Account hashes, workspaces, and sessions are written under `CODELAB_DATA_DIR`; the ephemeral filesystem can lose them on service replacement/restart. First provision/confirm persistent storage or move account/session/workspace data to a durable database. Do not create production accounts until persistence is confirmed.
3. Keep `ADMIN` for the human owner. Any later automation should use a separate least-privilege service identity with revocable access; never share the administrator password or browser session with an agent.
4. Public registration is intentionally not enabled in this initial slice. Account creation/invitations and admin account management must be added behind administrator authorization before general use.
5. The native login, first-password-change, and basic administrator account-management screens are now wired in the feature branch. They still require a careful manual verification on a persistent deployment before this can be called fully ready.

## Security notes
- Never log or return passwords, salts, or password hashes.
- Native login attempts are throttled per IP and username in memory; this is a basic mitigation, not a distributed rate limiter. Review proxy/IP trust, CSRF, and session revocation before broad public use.
- If `ADMIN_BOOTSTRAP_PASSWORD` is rotated after an ADMIN already exists, it does not reset the stored account password.
- Do not share one account between a human and an automated agent. Separate identities improve auditability and allow revocation without locking out the owner.
