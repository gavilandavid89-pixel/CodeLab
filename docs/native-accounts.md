# CodeLab native account system

## Goal
Use CodeLab-managed username/password accounts exclusively. Google/Gmail and GitHub OAuth are disabled.

## Implemented in this change
- `POST /api/auth/login`: username/password login; usernames are normalized to uppercase.
- `ADMIN_BOOTSTRAP_PASSWORD`: on first boot, if no local ADMIN exists, creates the `ADMIN` account when this secret is at least 16 characters. It is never overwritten if the account already exists.
- Passwords are stored as salted scrypt hashes, not plaintext.
- Auth sessions use the existing HttpOnly, SameSite=Lax session cookie.
- `POST /api/auth/change-password`: authenticated local users can change their password; minimum 16 characters. The existing bootstrap `ADMIN` is exempt from forced first-login rotation; regular accounts may be required to change an initial password.
- `GET /api/admin/accounts` and `POST /api/admin/accounts`: admin-only account listing and creation of regular user accounts; password hashes are never returned.
- Native login attempts are throttled per client IP and username.
- Local account workspaces use a distinct `local` provider namespace.

## Deployment requirements
1. Set a strong random `ADMIN_BOOTSTRAP_PASSWORD` secret in the CodeLab Render service environment before relying on native login. Do not put it in source control, issue bodies, logs, or documentation.
2. With `DATABASE_URL`, account records, auth sessions, CodeLab workspace snapshots, and PixelForge project records are persisted in PostgreSQL. Browser-only drafts and local backups are not automatically migrated into the database; users should sync or explicitly import those before changing devices. Expired or revoked sessions still require a new login. Without `DATABASE_URL`, file-backed fallback data depends on the configured persistent disk.
3. Keep `ADMIN` for the human owner. Any later automation should use a separate least-privilege service identity with revocable access; never share the administrator password or browser session with an agent.
4. Public self-registration is intentionally disabled. The existing **Administrar cuentas** interface and its admin-only listing/creation routes are available to the administrator; invitations and self-service recovery remain separate future work.
5. The native login, first-password-change, and administrator account-management screens are wired. Verify the full login and save flow on the deployed service before declaring it production-ready.

## Security notes
- Never log or return passwords, salts, or password hashes.
- Native login attempts are throttled per IP and username in memory; this is a basic mitigation, not a distributed rate limiter. Review proxy/IP trust, CSRF, and session revocation before broad public use.
- If `ADMIN_BOOTSTRAP_PASSWORD` is rotated after an ADMIN already exists, it does not reset the stored account password.
- Do not share one account between a human and an automated agent. Separate identities improve auditability and allow revocation without locking out the owner.
