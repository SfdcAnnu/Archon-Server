import type { NextFunction, Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import { config } from '../config';
import { logger } from '../logger';

export interface JwtClaims {
  orgId?: string;
  userId?: string;
  agentApiName?: string;
  iat: number;
  exp?: number;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      jwt?: JwtClaims;
    }
  }
}

/**
 * Verify the JWT minted by the Salesforce Named Credential.
 *
 * Salesforce signs the JWT with HMAC over `JWT_SECRET` and sends it as
 * `Authorization: Bearer <token>`. We verify, decode, and attach claims
 * to `req.jwt` for downstream handlers.
 */
export function jwtAuth(req: Request, res: Response, next: NextFunction): void {
  const header = req.header('Authorization') ?? req.header('authorization');
  if (!header || !header.startsWith('Bearer ')) {
    res.status(401).json({ error: 'missing_authorization' });
    return;
  }

  const token = header.slice('Bearer '.length).trim();

  try {
    const claims = jwt.verify(token, config.jwt.secret, {
      algorithms: [config.jwt.alg],
    }) as JwtClaims;
    req.jwt = claims;
    next();
  } catch (err) {
    logger.warn({ err }, 'jwt_verification_failed');
    res.status(401).json({ error: 'invalid_token' });
  }
}
