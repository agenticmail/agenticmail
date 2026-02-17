/**
 * Authentication Routes
 * 
 * Handles login (email/password), JWT issuance, SAML, and OIDC callbacks.
 */

import { Hono } from 'hono';
import type { DatabaseAdapter } from '../db/adapter.js';

export function createAuthRoutes(db: DatabaseAdapter, jwtSecret: string) {
  const auth = new Hono();

  // ─── Email/Password Login ───────────────────────────────

  auth.post('/login', async (c) => {
    const { email, password } = await c.req.json();
    if (!email || !password) {
      return c.json({ error: 'Email and password required' }, 400);
    }

    const user = await db.getUserByEmail(email);
    if (!user || !user.passwordHash) {
      return c.json({ error: 'Invalid credentials' }, 401);
    }

    const { default: bcrypt } = await import('bcryptjs');
    const valid = await bcrypt.compare(password, user.passwordHash);
    if (!valid) {
      return c.json({ error: 'Invalid credentials' }, 401);
    }

    // Issue JWT
    const { SignJWT } = await import('jose');
    const secret = new TextEncoder().encode(jwtSecret);
    const token = await new SignJWT({ sub: user.id, email: user.email, role: user.role })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuedAt()
      .setExpirationTime('24h')
      .sign(secret);

    // Update last login
    await db.updateUser(user.id, { lastLoginAt: new Date() } as any);
    await db.logEvent({
      actor: user.id, actorType: 'user', action: 'auth.login',
      resource: `user:${user.id}`, details: { method: 'password' },
      ip: c.req.header('x-forwarded-for') || c.req.header('x-real-ip'),
    });

    return c.json({
      token,
      user: { id: user.id, email: user.email, name: user.name, role: user.role },
    });
  });

  // ─── Token Refresh ──────────────────────────────────────

  auth.post('/refresh', async (c) => {
    const authHeader = c.req.header('Authorization');
    if (!authHeader?.startsWith('Bearer ')) {
      return c.json({ error: 'Token required' }, 401);
    }

    try {
      const { jwtVerify, SignJWT } = await import('jose');
      const secret = new TextEncoder().encode(jwtSecret);
      const { payload } = await jwtVerify(authHeader.slice(7), secret);

      const user = await db.getUser(payload.sub as string);
      if (!user) return c.json({ error: 'User not found' }, 401);

      const token = await new SignJWT({ sub: user.id, email: user.email, role: user.role })
        .setProtectedHeader({ alg: 'HS256' })
        .setIssuedAt()
        .setExpirationTime('24h')
        .sign(secret);

      return c.json({ token });
    } catch {
      return c.json({ error: 'Invalid token' }, 401);
    }
  });

  // ─── Current User ───────────────────────────────────────

  auth.get('/me', async (c) => {
    const authHeader = c.req.header('Authorization');
    if (!authHeader?.startsWith('Bearer ')) {
      return c.json({ error: 'Token required' }, 401);
    }

    try {
      const { jwtVerify } = await import('jose');
      const secret = new TextEncoder().encode(jwtSecret);
      const { payload } = await jwtVerify(authHeader.slice(7), secret);
      const user = await db.getUser(payload.sub as string);
      if (!user) return c.json({ error: 'User not found' }, 404);
      const { passwordHash, ...safe } = user;
      return c.json(safe);
    } catch {
      return c.json({ error: 'Invalid token' }, 401);
    }
  });

  // ─── SAML 2.0 (Placeholder) ────────────────────────────

  auth.post('/saml/callback', async (c) => {
    // TODO: Implement SAML assertion parsing
    // Will use saml2-js or passport-saml
    return c.json({ error: 'SAML not yet configured' }, 501);
  });

  auth.get('/saml/metadata', async (c) => {
    // TODO: Generate SP metadata XML
    return c.json({ error: 'SAML not yet configured' }, 501);
  });

  // ─── OIDC (Placeholder) ────────────────────────────────

  auth.get('/oidc/authorize', async (c) => {
    // TODO: Redirect to IdP authorization endpoint
    return c.json({ error: 'OIDC not yet configured' }, 501);
  });

  auth.get('/oidc/callback', async (c) => {
    // TODO: Handle OIDC callback, exchange code for tokens
    return c.json({ error: 'OIDC not yet configured' }, 501);
  });

  return auth;
}
