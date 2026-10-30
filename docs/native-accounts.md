# CodeLab native account system

## Goal
Replace mandatory Google/GitHub OAuth with CodeLab-managed username/password accounts. OAuth can remain optional, but it must not be required to sign in.

## Implemented in this change
- `POST /api/auth/login`: username/password login; usernames are normalized to uppercase.
- `ADMIN_BOOTSTRAP_PASSWORD`: on first boot, if no local ADMIN exists, creates the `ADMIN` account when this secret is at least 16 characters. It is never overwritten if the account already exists.
- Passwords are stored as salted scrypt hashes, not plaintext.
- Auth sessions use the existing HttpOnly, SameSite=Lax session cookie.
- `POST /api/auth/change-password`: authenticated local users can change their password; minimum 16 characters. Bootstrap ADMIN is marked to change its password on first login.
- Local account workspaces use a distinct `local` provider namespace.

## Deployment requirements
1. Set a strong random `ADMIN_BOOTSTRAP_PASSWORD` secret in the CodeLab Render service environment before relying on native login. Do not put it in source control, issue bodies, logs, or documentation.
2. Confirm persistent storage for `CODELAB_DATA_DIR`. Account hashes, workspaces, and sessions are written under that directory; an ephemeral filesystem can lose them on service replacement/restart. Do not migrate production accounts until persistence is confirmed.
3. Keep `ADMIN` for the human owner. Any later automation should use a separate least-privilege service identity with revocable access; never share the administrator password or browser session with an agent.
4. Public registration is intentionally not enabled in this initial slice. Account creation/invitations and admin account management must be added behind administrator authorization before general use.
5. The front-end login/first-password-change screens and an end-to-end manual verification are still required before this can be called fully ready.

## Security notes
- Never log or return passwords, salts, or password hashes.
- The login route is subject to the existing request rate limit; add account-specific throttling/lockout and CSRF review before broad public use.
- If `ADMIN_BOOTSTRAP_PASSWORD` is rotated after an ADMIN already exists, it does not reset the stored account password.
- Do not share one account between a human and an automated agent. Separate identities improve auditability and allow revocation without locking out the owner.
