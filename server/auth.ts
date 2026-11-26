import express, { Router, type Request } from 'express';
import { createHash, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';

const sessionLifetime = 8 * 60 * 60 * 1000;
const attemptWindow = 60_000;

export interface AuthConfig {
  origin: string;
  username: string;
  hash: string;
}

export function localAuth(config: AuthConfig | null, now = Date.now) {
  const router = Router();
  const parsed = config && /^scrypt\$([0-9a-f]{32})\$([0-9a-f]{64})$/.exec(config.hash);
  if (config && (!parsed || !/^[a-zA-Z0-9_.-]{1,64}$/.test(config.username))) throw new Error('Invalid credentials');
  const salt = parsed ? Buffer.from(parsed[1], 'hex') : null;
  const digest = parsed ? Buffer.from(parsed[2], 'hex') : null;
  const secure = config?.origin.startsWith('https://') ?? true;
  const cookieName = secure ? '__Host-mon-session' : 'mon-dev-session';
  const cookieOptions = { httpOnly: true, secure, sameSite: 'strict' as const, path: '/' };
  const sessions = new Map<string, number>();
  const attempts = new Map<string, number[]>();
  let recentAttempts: number[] = [];
  let verifying = 0;

  function sessionKey(req: Request) {
    const entries = req.get('cookie')?.split(';').map((entry) => entry.trim()) ?? [];
    const cookie = entries.find((entry) => entry.startsWith(cookieName + '='));
    const token = cookie?.slice(cookieName.length + 1);
    return token && /^[A-Za-z0-9_-]{43}$/.test(token)
      ? createHash('sha256').update(token).digest('hex') : null;
  }

  function authenticated(req: Request) {
    const key = sessionKey(req);
    const expires = key && sessions.get(key);
    if (!key || !expires) return false;
    if (expires > now()) return true;
    sessions.delete(key);
    return false;
  }

  function reserveAttempt(ip: string) {
    const time = now();
    if (verifying >= 2) return false;
    recentAttempts = recentAttempts.filter((attempt) => attempt > time - attemptWindow);
    if (recentAttempts.length >= 120) return false;
    for (const [address, timestamps] of attempts) {
      if (timestamps[timestamps.length - 1] <= time - attemptWindow) attempts.delete(address);
    }
    const timestamps = (attempts.get(ip) ?? []).filter((attempt) => attempt > time - attemptWindow);
    if (timestamps.length >= 5) return false;
    timestamps.push(time);
    attempts.set(ip, timestamps);
    recentAttempts.push(time);
    return true;
  }

  router.use((_req, res, next) => {
    res.set('Cache-Control', 'private, no-store');
    next();
  });

  router.get('/session', (req, res) => {
    if (!config) {
      res.status(503).json({ error: 'O acesso ao painel ainda não foi configurado.' });
      return;
    }
    res.json({ authenticated: authenticated(req) });
  });

  router.post('/login', express.json({ limit: '4kb' }), async (req, res) => {
    if (!config || !salt || !digest) {
      res.status(503).json({ error: 'O acesso ao painel ainda não foi configurado.' });
      return;
    }
    if (req.get('origin') !== config.origin) {
      res.status(403).json({ error: 'Origem da solicitação inválida.' });
      return;
    }
    const { username, password } = req.body ?? {};
    if (typeof username !== 'string' || username.length > 64 ||
        typeof password !== 'string' || !password || Buffer.byteLength(password) > 512) {
      res.status(400).json({ error: 'Preencha o usuário e a senha.' });
      return;
    }
    if (!reserveAttempt(req.ip ?? 'unknown')) {
      res.set('Retry-After', '60').status(429).json({ error: 'Aguarde um minuto e tente novamente.' });
      return;
    }
    let derived: Buffer;
    verifying++;
    try {
      derived = await new Promise<Buffer>((resolve, reject) => {
        scrypt(password, salt, digest.length, { N: 32768, r: 8, p: 3, maxmem: 64 * 1024 * 1024 },
          (error, key) => error ? reject(error) : resolve(key));
      });
    } catch {
      res.status(503).json({ error: 'Não foi possível verificar o acesso. Tente novamente.' });
      return;
    } finally {
      verifying--;
    }
    if (!timingSafeEqual(digest, derived) || username !== config.username) {
      res.status(401).json({ error: 'Usuário ou senha inválidos.' });
      return;
    }
    const oldKey = sessionKey(req);
    if (oldKey) sessions.delete(oldKey);
    const time = now();
    for (const [key, expires] of sessions) {
      if (expires <= time) sessions.delete(key);
    }
    if (sessions.size >= 128) {
      const oldest = sessions.keys().next().value;
      if (oldest) sessions.delete(oldest);
    }
    const token = randomBytes(32).toString('base64url');
    sessions.set(createHash('sha256').update(token).digest('hex'), time + sessionLifetime);
    res.cookie(cookieName, token, { ...cookieOptions, maxAge: sessionLifetime }).status(204).end();
  });

  router.post('/logout', (req, res) => {
    if (!config || req.get('origin') !== config.origin) {
      res.status(403).json({ error: 'Origem da solicitação inválida.' });
      return;
    }
    const key = sessionKey(req);
    if (key) sessions.delete(key);
    res.clearCookie(cookieName, cookieOptions).status(204).end();
  });

  router.use((error: { status?: number }, _req: Request, res: express.Response, _next: express.NextFunction) => {
    const status = error.status === 413 ? 413 : 400;
    res.status(status).json({ error: 'Formato da solicitação inválido.' });
  });

  return { router, authenticated };
}
