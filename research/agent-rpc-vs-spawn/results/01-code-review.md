---
test: test-code-review
label: Code Review
domain: Software Engineering
runtime: 24s
method: OpenClaw sessions_spawn
model: claude-opus-4-6
---



# Code Review: Security & Bug Analysis

## Issues Found

### 1. **SQL Injection** — `Critical`
Both `authenticate()` and `get_user_data()` use f-strings to build SQL queries with unsanitized user input. An attacker can pass `' OR '1'='1' --` as the username to bypass authentication entirely, or extract/delete the entire database.

**Fix:** Use parameterized queries (`?` placeholders).

---

### 2. **Weak Password Hashing (MD5)** — `Critical`
MD5 is cryptographically broken — it's fast to brute-force, has known collisions, and no salt is used. Rainbow table attacks can reverse hashes trivially.

**Fix:** Use `bcrypt` (or `argon2`/`scrypt`) with per-user salts.

---

### 3. **Path Traversal in `upload_file()`** — `Critical`
A filename like `../../etc/cron.d/malicious` lets an attacker write arbitrary files anywhere on the filesystem. No validation is performed on the filename.

**Fix:** Sanitize with `os.path.basename()` and validate against an allowlist of extensions. Optionally generate a random filename.

---

### 4. **Database Connections Never Closed** — `High`
Every call to `authenticate()` and `get_user_data()` opens a new connection that's never closed. This leaks file descriptors and can exhaust the SQLite connection limit under load.

**Fix:** Use `with` context managers or explicit `conn.close()`.

---

### 5. **No Error Handling** — `Medium`
Database failures, file I/O errors, and missing directories all produce unhandled exceptions that could crash the app or leak stack traces to users.

**Fix:** Add try/except blocks with appropriate error handling.

---

### 6. **`SELECT *` Usage** — `Low`
Fetching all columns (including password hashes) wastes memory and risks leaking sensitive fields downstream.

**Fix:** Select only the columns you need.

---

### 7. **No File Size Limit on Upload** — `Medium`
`upload_file()` writes content with no size check, enabling denial-of-service via disk exhaustion.

**Fix:** Check `len(content)` against a maximum before writing.

---

## Corrected Code

```python
import os
import sqlite3
import uuid
import bcrypt

UPLOAD_DIR = "/uploads"
MAX_UPLOAD_BYTES = 10 * 1024 * 1024  # 10 MB
ALLOWED_EXTENSIONS = {".jpg", ".jpeg", ".png", ".gif", ".pdf", ".txt"}


def _get_connection():
    """Return a new database connection."""
    return sqlite3.connect("users.db")


def authenticate(username: str, password: str) -> bool:
    """Authenticate a user with constant-time hash comparison."""
    try:
        with _get_connection() as conn:
            row = conn.execute(
                "SELECT password_hash FROM users WHERE username = ?",
                (username,),
            ).fetchone()
        if row is None:
            return False
        stored_hash = row[0]
        # bcrypt.checkpw handles salt extraction automatically
        return bcrypt.checkpw(password.encode("utf-8"), stored_hash)
    except sqlite3.Error:
        return False


def get_user_data(user_id: int) -> list | None:
    """Fetch non-sensitive user data by ID."""
    try:
        with _get_connection() as conn:
            data = conn.execute(
                "SELECT id, username, email, created_at FROM users WHERE id = ?",
                (user_id,),
            ).fetchall()
        return data
    except sqlite3.Error:
        return None


def upload_file(filename: str, content: bytes) -> str:
    """Save an uploaded file safely. Returns the stored filename."""
    # Size check
    if len(content) > MAX_UPLOAD_BYTES:
        raise ValueError(f"File exceeds {MAX_UPLOAD_BYTES} byte limit")

    # Strip any path components to prevent traversal
    safe_name = os.path.basename(filename)
    if not safe_name:
        raise ValueError("Invalid filename")

    # Extension allowlist
    _, ext = os.path.splitext(safe_name)
    if ext.lower() not in ALLOWED_EXTENSIONS:
        raise ValueError(f"Extension '{ext}' not allowed")

    # Generate a unique name to avoid collisions / overwrites
    stored_name = f"{uuid.uuid4().hex}{ext}"
    filepath = os.path.join(UPLOAD_DIR, stored_name)

    # Verify the resolved path is still inside UPLOAD_DIR (belt + suspenders)
    if not os.path.realpath(filepath).startswith(os.path.realpath(UPLOAD_DIR)):
        raise ValueError("Path traversal detected")

    with open(filepath, "wb") as f:
        f.write(content)

    return stored_name
```

**Key changes summarized:**
- Parameterized queries everywhere (fixes SQL injection)
- `bcrypt` replaces MD5 (proper salted hashing)
- Path traversal blocked via `basename()`, extension allowlist, realpath check, and UUID renaming
- All DB connections use `with` (auto-close)
- Error handling added throughout
- File size limit enforced
- `SELECT *` replaced with explicit columns