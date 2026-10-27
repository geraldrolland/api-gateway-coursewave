import { Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import config from '../config';
import redis from '../config/redis';
import { JwtPayload } from '../types';
import { logger } from '../middleware/logger';

/**
 * Token refresh handler (gateway-side implementation).
 *
 * Reads the signed refresh token from the `refresh` httpOnly cookie, verifies
 * it, reuses the existing session, and issues a fresh access + refresh token
 * pair bound to the same session ID.
 *
 * This is the gateway's own refresh handler — the auth service has an
 * identical implementation for direct access.
 *
 * @param req.signedCookies.refresh - The current signed refresh token cookie
 * @returns 200 with `{ accessToken }` and new signed refresh cookie
 * @returns 401 if refresh token is missing, invalid, or session has expired
 * @returns 500 on unexpected errors
 */
export async function refreshTokenHandler(req: Request, res: Response): Promise<void> {
  const refreshToken = req.signedCookies?.refresh;

  if (!refreshToken || typeof refreshToken !== 'string') {
    res.status(401).json({ error: 'Missing refresh token' });
    return;
  }

  try {
    const decoded = jwt.verify(refreshToken, config.auth.jwtSecret) as JwtPayload;

    if (decoded.type !== 'refresh') {
      res.status(401).json({ error: 'Invalid token type' });
      return;
    }

    if (!decoded.sessionId) {
      res.status(401).json({ error: 'Invalid refresh token payload' });
      return;
    }

    const sessionId = decoded.sessionId;

    const sessionRaw = await redis.get(`session:${sessionId}`);
    if (!sessionRaw) {
      res.status(401).json({ error: 'Session expired or not found' });
      return;
    }

    // Extend the existing session's lifetime without rotating its ID.
    await redis.expire(`session:${sessionId}`, 604800);

    const accessToken = jwt.sign(
      { sessionId, type: 'access' },
      config.auth.jwtSecret,
      { expiresIn: process.env.ACCESS_TOKEN_EXPIRY || '7m' } as jwt.SignOptions
    );

    const newRefreshToken = jwt.sign(
      { sessionId, type: 'refresh' },
      config.auth.jwtSecret,
      { expiresIn: process.env.REFRESH_TOKEN_EXPIRY || '7d' } as jwt.SignOptions
    );

    res.cookie('refresh', newRefreshToken, {
      signed: true,
      httpOnly: true,
      secure: true,
      sameSite: 'strict',
      path: '/auth/api/v1/token-refresh',
      maxAge: parseInt(process.env.REFRESH_TOKEN_MAX_AGE || '604800000', 10),
    });

    logger.info('Token refreshed', { sessionId });

    res.json({ accessToken });
  } catch (err) {
    if (err instanceof jwt.JsonWebTokenError) {
      res.status(401).json({ error: 'Invalid or expired refresh token' });
      return;
    }
    logger.error('Refresh token error', { error: (err as Error).message });
    res.status(500).json({ error: 'Token refresh failed' });
  }
}
