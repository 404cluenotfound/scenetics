import { Router } from 'express';

export const authRouter = Router();

/**
 * Google OAuth — SKELETON (honest stub, not a fake login).
 *
 * TODO(auth): complete the flow —
 *   1. Set GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET / SESSION_SECRET in .env.
 *   2. Either install passport + passport-google-oauth20 and wire the
 *      strategy here, or finish the manual code-exchange below
 *      (POST https://oauth2.googleapis.com/token, then fetch userinfo).
 *   3. On success, create a session/JWT, set req.ownerId for the projects
 *      routes, and redirect back to CLIENT_ORIGIN.
 *
 * Until GOOGLE_CLIENT_ID is set, these routes return 501 so nothing
 * pretends to work.
 */

authRouter.get('/google', (req, res) => {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  if (!clientId) {
    return res.status(501).json({
      error: 'Google login not configured. Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in server/.env.',
    });
  }
  const origin = process.env.CLIENT_ORIGIN || 'http://localhost:5173';
  const redirectUri = `${req.protocol}://${req.get('host')}/auth/google/callback`;
  const url =
    'https://accounts.google.com/o/oauth2/v2/auth' +
    `?client_id=${encodeURIComponent(clientId)}` +
    `&redirect_uri=${encodeURIComponent(redirectUri)}` +
    '&response_type=code&scope=openid%20email%20profile' +
    `&state=${encodeURIComponent(origin)}`;
  res.redirect(url);
});

authRouter.get('/google/callback', (_req, res) => {
  // TODO(auth): exchange req.query.code for tokens, load the Google
  // profile, create the session, redirect to CLIENT_ORIGIN.
  return res.status(501).json({ error: 'Google OAuth callback not implemented yet (MVP skeleton).' });
});
