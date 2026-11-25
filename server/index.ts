import express, { type Request, type Response, type NextFunction } from 'express';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import multer from 'multer';
import { MongoClient, GridFSBucket, ObjectId } from 'mongodb';
import { createHash, randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { Readable } from 'node:stream';
import path from 'node:path';
import { existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { CognitoJwtVerifier } from 'aws-jwt-verify';
import { S3Client, PutObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { CognitoIdentityProviderClient, AdminCreateUserCommand, AdminDeleteUserCommand } from '@aws-sdk/client-cognito-identity-provider';
import { z } from 'zod';
import { applyAction, allowedSite, DomainError, demoUsers, seedData, visibleData, type AppData, type User } from '../src/domain.ts';
import { actionSchema, inviteSchema, loginSchema } from './validation.ts';

const production = process.env.NODE_ENV === 'production';
const port = Number(process.env.PORT || 4000);
const origin = new URL(process.env.APP_ORIGIN || 'http://localhost:5173').origin;
const cognitoDomain = process.env.COGNITO_DOMAIN;
const poolId = process.env.COGNITO_USER_POOL_ID;
const clientId = process.env.COGNITO_CLIENT_ID;
const cognito = Boolean(cognitoDomain && poolId && clientId);
if (production && (!cognito || !process.env.S3_BUCKET || !origin.startsWith('https://'))) throw new Error('Production requires HTTPS APP_ORIGIN, Cognito settings and S3_BUCKET. See docs/AWS-DEPLOYMENT.md.');
if (production && process.env.SEED_DEMO === 'true') throw new Error('Sample data and demo users cannot be seeded in production.');
if (!process.env.MONGODB_URI) throw new Error('MONGODB_URI is required. Copy .env.example to .env and start MongoDB with docker compose up -d.');
let tlsCAFile: string | undefined;
if (process.env.MONGODB_CA_PEM) { tlsCAFile = path.join(tmpdir(), 'haya-mongo-ca.pem'); writeFileSync(tlsCAFile, process.env.MONGODB_CA_PEM, { mode: 0o600 }); }
const mongo = new MongoClient(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 10000, ...(tlsCAFile ? { tlsCAFile } : {}) });
await mongo.connect();
const db = mongo.db(process.env.MONGODB_DATABASE || 'haya');
type DbUser = User & { _id: string; passwordHash?: string; cognitoSub?: string };
const users = db.collection<DbUser>('users');
const organisations = db.collection<{ _id: string; data: AppData }>('organisations');
const sessions = db.collection<{ _id: string; userId: string; expiresAt: Date }>('sessions');
const oauth = db.collection<{ _id: string; verifier: string; expiresAt: Date }>('oauth');
const limits = db.collection<{ _id: string; hits: number; expiresAt: Date }>('requestLimits');
type Media = { _id: string; organisationId: string; siteId: string; authorId: string; type: string; sha256: string; size: number; key?: string; versionId?: string; gridId?: ObjectId; createdAt: Date };
const media = db.collection<Media>('media');
const bucket = new GridFSBucket(db, { bucketName: 'evidence' });
const s3 = new S3Client({ region: process.env.AWS_REGION || 'ap-south-1' });
const cognitoApi = new CognitoIdentityProviderClient({ region: process.env.AWS_REGION || 'ap-south-1' });
const verifier = cognito ? CognitoJwtVerifier.create({ userPoolId: poolId!, clientId: clientId!, tokenUse: 'id' }) : null;
await Promise.all([
  users.createIndex({ organisationId: 1, email: 1 }, { unique: true }),
  sessions.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }),
  oauth.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }),
  limits.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }),
  media.createIndex({ organisationId: 1, siteId: 1 }),
]);
const digest = (s: string) => createHash('sha256').update(s).digest('hex');
const scrypt = promisify(scryptCallback);
async function hashPassword(password: string) { const salt = randomBytes(16).toString('hex'); return `${salt}:${(await scrypt(password, salt, 64) as Buffer).toString('hex')}`; }
async function validPassword(password: string, encoded?: string) { const [salt, stored] = (encoded || `${'0'.repeat(32)}:${'0'.repeat(128)}`).split(':'); const derived = await scrypt(password, salt, 64) as Buffer; return timingSafeEqual(derived, Buffer.from(stored, 'hex')); }
const publicUser = (u: DbUser): User => ({ id: u.id, name: u.name, email: u.email, role: u.role, siteIds: u.siteIds, organisationId: u.organisationId });
await organisations.updateOne({ _id: 'haya' }, { $setOnInsert: { data: seedData(!production && process.env.SEED_DEMO === 'true') } }, { upsert: true });
if (!production && !cognito && process.env.LOCAL_ADMIN_PASSWORD) {
  if (process.env.LOCAL_ADMIN_PASSWORD.length < 12) throw new Error('LOCAL_ADMIN_PASSWORD must contain at least 12 characters.');
  const accounts = process.env.SEED_DEMO === 'true' ? demoUsers : [{ ...demoUsers[0], email: process.env.BOOTSTRAP_OWNER_EMAIL || 'owner@haya.local' }];
  for (const user of accounts) await users.updateOne({ _id: user.id }, { $setOnInsert: { ...user, passwordHash: await hashPassword(process.env.LOCAL_ADMIN_PASSWORD) } }, { upsert: true });
}

const app = express();
app.disable('x-powered-by');
// CloudFront -> ALB -> API. Direct ALB application traffic is rejected by the origin secret.
app.set('trust proxy', production ? 2 : false);
app.use(helmet({ contentSecurityPolicy: { directives: { defaultSrc: ["'self'"], scriptSrc: ["'self'"], styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'], fontSrc: ["'self'", 'https://fonts.gstatic.com'], imgSrc: ["'self'", 'blob:', 'data:', 'https://*.amazonaws.com'], connectSrc: ["'self'"], frameAncestors: ["'none'"] } }, crossOriginEmbedderPolicy: false }));
app.use(express.json({ limit: '96kb' }));
app.use(cookieParser());
app.use((req, res, next) => { res.setHeader('Cache-Control', 'no-store'); res.setHeader('X-Request-Id', randomBytes(12).toString('hex')); next(); });
app.use('/api', (req, res, next) => {
  if (production && process.env.ORIGIN_SECRET && req.path !== '/health' && digest(req.get('x-haya-origin') || '') !== digest(process.env.ORIGIN_SECRET)) return res.status(403).json({ error: 'Open the application using its CloudFront address.' });
  if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method) && req.get('origin') !== origin) return res.status(403).json({ error: 'Request origin is not allowed. Reload the application from its configured address.' });
  next();
});
async function rateLimit(key: string, max: number, seconds: number) {
  const window = Math.floor(Date.now() / (seconds * 1000));
  const result = await limits.findOneAndUpdate({ _id: `${key}:${window}` }, { $inc: { hits: 1 }, $setOnInsert: { expiresAt: new Date((window + 1) * seconds * 1000) } }, { upsert: true, returnDocument: 'after' });
  return (result?.hits || 0) <= max;
}
const cookieOptions = { httpOnly: true, secure: production, sameSite: 'lax' as const, path: '/' };
const sessionCookie = production ? '__Host-haya' : 'haya-session';
async function startSession(res: Response, userId: string) { const token = randomBytes(32).toString('base64url'); await sessions.insertOne({ _id: digest(token), userId, expiresAt: new Date(Date.now() + 8 * 3600000) }); res.cookie(sessionCookie, token, { ...cookieOptions, maxAge: 8 * 3600000 }); }
type AuthRequest = Request & { user: User };
async function authenticate(req: Request, res: Response, next: NextFunction) {
  try {
    const token = req.cookies[sessionCookie];
    const session = token && await sessions.findOne({ _id: digest(token), expiresAt: { $gt: new Date() } });
    const user = session && await users.findOne({ _id: session.userId });
    if (!user) return res.status(401).json({ error: 'Sign in to open your workspace.' });
    (req as AuthRequest).user = publicUser(user); next();
  } catch (error) { next(error); }
}
app.get('/api/health', async (_req, res) => { await db.command({ ping: 1 }); res.json({ status: 'ok' }); });
app.get('/api/auth/config', (_req, res) => res.json({ cognito }));
app.post('/api/auth/login', async (req, res) => {
  if (cognito || production) return res.status(400).json({ error: 'Use the organisation sign-in button.' });
  if (!await rateLimit(`login:${req.ip}`, 10, 900)) return res.status(429).json({ error: 'Too many sign-in attempts. Try again in 15 minutes.' });
  const { email, password } = loginSchema.parse(req.body);
  const user = await users.findOne({ organisationId: 'haya', email });
  const valid = await validPassword(password, user?.passwordHash);
  if (!user || !valid) return res.status(401).json({ error: 'Email or password is incorrect.' });
  const existing = req.cookies[sessionCookie]; if (existing) await sessions.deleteOne({ _id: digest(existing) });
  await startSession(res, user.id); res.json({ user: publicUser(user) });
});
app.post('/api/auth/logout', async (req, res) => { if (req.cookies[sessionCookie]) await sessions.deleteOne({ _id: digest(req.cookies[sessionCookie]) }); res.clearCookie(sessionCookie, cookieOptions); res.json({ ok: true }); });
app.get('/api/auth/cognito', async (_req, res) => {
  if (!cognito) return res.status(404).json({ error: 'Cognito is not configured.' });
  const state = randomBytes(32).toString('base64url'); const pkce = randomBytes(48).toString('base64url');
  await oauth.insertOne({ _id: digest(state), verifier: pkce, expiresAt: new Date(Date.now() + 600000) });
  res.cookie('haya-oauth-state', state, { ...cookieOptions, maxAge: 600000 });
  const url = new URL('/oauth2/authorize', cognitoDomain);
  url.search = new URLSearchParams({ response_type: 'code', client_id: clientId!, redirect_uri: `${origin}/api/auth/callback`, scope: 'openid email profile', state, code_challenge: createHash('sha256').update(pkce).digest('base64url'), code_challenge_method: 'S256' }).toString();
  res.redirect(url.href);
});
app.get('/api/auth/callback', async (req, res) => {
  if (!cognito || !verifier) return res.status(404).json({ error: 'Cognito is not configured.' });
  const state = String(req.query.state || ''); const cookie = req.cookies['haya-oauth-state'];
  if (!state || state !== cookie || !req.query.code) return res.status(400).json({ error: 'Sign-in session expired. Open the application and sign in again.' });
  const auth = await oauth.findOneAndDelete({ _id: digest(state), expiresAt: { $gt: new Date() } });
  res.clearCookie('haya-oauth-state', cookieOptions);
  if (!auth) return res.status(400).json({ error: 'Sign-in request expired or already used.' });
  const result = await fetch(new URL('/oauth2/token', cognitoDomain), { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'authorization_code', client_id: clientId!, code: String(req.query.code), redirect_uri: `${origin}/api/auth/callback`, code_verifier: auth.verifier }), signal: AbortSignal.timeout(15000) });
  if (!result.ok) return res.status(401).json({ error: 'Sign-in could not be completed. Please try again.' });
  const tokens = await result.json() as { id_token: string };
  const claims = await verifier.verify(tokens.id_token);
  if (!claims.email || claims.email_verified !== true) return res.status(403).json({ error: 'A verified email address is required.' });
  const email = String(claims.email).toLowerCase();
  let user = await users.findOne({ organisationId: 'haya', email });
  if (!user && email === process.env.BOOTSTRAP_OWNER_EMAIL?.toLowerCase()) {
    const owner: DbUser = { _id: randomBytes(16).toString('hex'), id: '', name: String(claims.name || 'HAYA Owner'), email, role: 'Owner', siteIds: [], organisationId: 'haya', cognitoSub: claims.sub }; owner.id = owner._id;
    await users.updateOne({ organisationId: 'haya', email }, { $setOnInsert: owner }, { upsert: true }); user = await users.findOne({ organisationId: 'haya', email });
  }
  if (!user || user.cognitoSub && user.cognitoSub !== claims.sub) return res.status(403).json({ error: 'Your account has not been assigned access. Contact the HAYA owner.' });
  await users.updateOne({ _id: user._id }, { $set: { cognitoSub: claims.sub } });
  const existing = req.cookies[sessionCookie]; if (existing) await sessions.deleteOne({ _id: digest(existing) });
  await startSession(res, user.id); res.redirect('/');
});
app.use('/api', authenticate);
app.use('/api', async (req, res, next) => { if (!await rateLimit(`api:${(req as AuthRequest).user.id}`, 300, 60)) return res.status(429).json({ error: 'Too many requests. Please try again shortly.' }); next(); });
app.get('/api/workspace', async (req, res) => {
  const user = (req as AuthRequest).user;
  const record = await organisations.findOne({ _id: user.organisationId });
  if (!record) return res.status(404).json({ error: 'Workspace not found.' });
  const team = await users.find({ organisationId: user.organisationId }).toArray();
  const people = team.filter(p => user.role === 'Owner' || p.id === user.id || user.role === 'Manager' && p.siteIds.some(s => user.siteIds.includes(s))).map(publicUser);
  res.json({ user, data: visibleData(record.data, user), people });
});
app.post('/api/actions', async (req, res) => {
  const user = (req as AuthRequest).user;
  const action = actionSchema.parse(req.body.action);
  if ((action.type === 'checkIn' || action.type === 'checkOut') && action.location) {
    const age = Date.now() - new Date(action.location.capturedAt).getTime();
    if (age > 120000 || age < -30000) return res.status(422).json({ error: 'Location reading is stale or in the future. Capture a fresh location or submit an exception without GPS.' });
  }
  for (let attempt = 0; attempt < 5; attempt++) {
    const record = await organisations.findOne({ _id: user.organisationId });
    if (!record) return res.status(404).json({ error: 'Workspace not found.' });
    let siteId = 'siteId' in action ? action.siteId : undefined;
    if (action.type === 'defectAction') siteId = record.data.defects.find(d => d.id === action.id)?.siteId;
    if ('evidence' in action && action.evidence?.length) {
      const photos = await media.find({ _id: { $in: action.evidence }, organisationId: user.organisationId, siteId, authorId: user.id }).toArray();
      if (photos.length !== new Set(action.evidence).size) return res.status(403).json({ error: 'Every evidence photo must belong to you and the selected site.' });
    }
    const next = applyAction(record.data, user, action);
    if (next === record.data) return res.json({ data: visibleData(record.data, user), receipt: { revision: record.data.revision, duplicate: true } });
    // A single conditional MongoDB document update commits the decision, ledger and audit atomically.
    // The revision compare-and-set serialises concurrent approvals and makes retries idempotent.
    const result = await organisations.updateOne({ _id: user.organisationId, 'data.revision': record.data.revision }, { $set: { data: next } });
    if (result.modifiedCount === 1) return res.json({ data: visibleData(next, user), receipt: { revision: next.revision, receivedAt: new Date().toISOString() } });
  }
  res.status(409).json({ error: 'The workspace changed while saving. Refresh and try again; the same request ID prevents duplicate submission.' });
});
app.post('/api/users', async (req, res) => {
  const owner = (req as AuthRequest).user;
  if (owner.role !== 'Owner') return res.status(403).json({ error: 'Only an owner can manage access.' });
  const input = inviteSchema.parse(req.body);
  const organisation = await organisations.findOne({ _id: owner.organisationId });
  if (!input.siteIds.every(id => organisation?.data.sites.some(s => s.id === id))) return res.status(400).json({ error: 'Choose valid site assignments.' });
  if (await users.findOne({ organisationId: owner.organisationId, email: input.email })) return res.status(409).json({ error: 'This email already has workspace access.' });
  const userId = randomBytes(16).toString('hex'); const temporaryPassword = randomBytes(18).toString('base64url') + 'Aa1!';
  let sub: string | undefined;
  if (cognito) {
    const result = await cognitoApi.send(new AdminCreateUserCommand({ UserPoolId: poolId, Username: input.email, UserAttributes: [{ Name: 'email', Value: input.email }, { Name: 'email_verified', Value: 'true' }, { Name: 'name', Value: input.name }], DesiredDeliveryMediums: ['EMAIL'] }));
    sub = result.User?.Attributes?.find(a => a.Name === 'sub')?.Value;
  }
  try {
    await users.insertOne({ _id: userId, id: userId, organisationId: owner.organisationId, ...input, siteIds: input.role === 'Owner' ? [] : input.siteIds, ...(cognito ? { cognitoSub: sub } : { passwordHash: await hashPassword(temporaryPassword) }) });
  } catch (error) {
    if (cognito) await cognitoApi.send(new AdminDeleteUserCommand({ UserPoolId: poolId, Username: input.email })).catch(() => {});
    throw error;
  }
  // Access events are attributed server-side; use the same revision CAS as normal business actions.
  for (let attempt = 0; attempt < 5; attempt++) {
    const record = await organisations.findOne({ _id: owner.organisationId }); if (!record) break;
    const result = await organisations.updateOne({ _id: owner.organisationId, 'data.revision': record.data.revision }, { $inc: { 'data.revision': 1 }, $push: { 'data.audit': { $each: [{ id: randomBytes(12).toString('hex'), actorId: owner.id, action: `granted ${input.role.toLowerCase()} access to ${input.email}`, createdAt: new Date().toISOString() }], $position: 0 } } });
    if (result.modifiedCount) break;
  }
  res.status(201).json({ id: userId, ...(cognito ? {} : { temporaryPassword }) });
});
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 8 * 1024 * 1024, files: 1, fields: 1, fieldSize: 160 } });
function imageType(buffer: Buffer) {
  if (buffer.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))) return 'image/jpeg';
  if (buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (buffer.subarray(0, 4).toString() === 'RIFF' && buffer.subarray(8, 12).toString() === 'WEBP') return 'image/webp';
  return null;
}
app.post('/api/media', upload.single('photo'), async (req, res) => {
  const user = (req as AuthRequest).user; const siteId = String(req.body.siteId || '');
  const organisation = await organisations.findOne({ _id: user.organisationId });
  if (user.role === 'Client' || !allowedSite(user, siteId) || !organisation?.data.sites.some(s => s.id === siteId)) return res.status(403).json({ error: 'You cannot upload evidence to this site.' });
  if (!req.file) return res.status(400).json({ error: 'Choose a photo to upload.' });
  const type = imageType(req.file.buffer); if (!type) return res.status(415).json({ error: 'Only genuine JPEG, PNG and WebP files are supported.' });
  const mediaId = randomBytes(16).toString('hex');
  const record: Media = { _id: mediaId, organisationId: user.organisationId, siteId, authorId: user.id, type, sha256: createHash('sha256').update(req.file.buffer).digest('hex'), size: req.file.size, createdAt: new Date() };
  if (process.env.S3_BUCKET) {
    record.key = `${user.organisationId}/${siteId}/${mediaId}`;
    const result = await s3.send(new PutObjectCommand({ Bucket: process.env.S3_BUCKET, Key: record.key, Body: req.file.buffer, ContentType: type, ServerSideEncryption: 'AES256', ChecksumSHA256: createHash('sha256').update(req.file.buffer).digest('base64') })); record.versionId = result.VersionId;
  } else {
    const stream = bucket.openUploadStream(mediaId, { metadata: { siteId, organisationId: user.organisationId, type } });
    await new Promise<void>((resolve, reject) => { Readable.from(req.file!.buffer).pipe(stream).on('finish', resolve).on('error', reject); }); record.gridId = stream.id;
  }
  await media.insertOne(record); res.status(201).json({ id: mediaId });
});
async function getMedia(req: Request, res: Response) {
  const user = (req as AuthRequest).user; const record = await media.findOne({ _id: String(req.params.id), organisationId: user.organisationId });
  if (!record || !allowedSite(user, record.siteId) || user.role === 'Client' || user.role === 'Supervisor' && record.authorId !== user.id) { res.status(404).json({ error: 'Photo not found or not accessible.' }); return null; }
  return record;
}
app.get('/api/media/:id', async (req, res) => { const record = await getMedia(req, res); if (!record) return; const url = record.key ? await getSignedUrl(s3, new GetObjectCommand({ Bucket: process.env.S3_BUCKET, Key: record.key, VersionId: record.versionId }), { expiresIn: 300 }) : `/api/media/${record._id}/content`; res.json({ url }); });
app.get('/api/media/:id/content', async (req, res) => { const record = await getMedia(req, res); if (!record) return; if (!record.gridId) return res.status(404).json({ error: 'Use the signed photo link.' }); res.type(record.type); res.setHeader('Content-Disposition', 'inline'); bucket.openDownloadStream(record.gridId).on('error', () => { if (!res.headersSent) res.sendStatus(404); else res.destroy(); }).pipe(res); });
app.use('/api', (_req, res) => res.status(404).json({ error: 'API route not found.' }));
const staticDirectory = path.resolve('dist');
if (existsSync(path.join(staticDirectory, 'index.html'))) { app.use(express.static(staticDirectory, { index: false })); app.get('/{*path}', (_req, res) => res.sendFile(path.join(staticDirectory, 'index.html'))); }
app.use((error: Error & { code?: number | string; status?: number }, _req: Request, res: Response, _next: NextFunction) => {
  if (error instanceof z.ZodError) return res.status(422).json({ error: error.issues.map(i => `${i.path.join('.')}: ${i.message}`).slice(0, 3).join('; ') });
  if (error instanceof multer.MulterError) return res.status(400).json({ error: error.code === 'LIMIT_FILE_SIZE' ? 'Photo exceeds the 8 MB limit.' : 'The photo upload could not be completed.' });
  if (error.code === 11000) return res.status(409).json({ error: 'This record already exists. Refresh and try again.' });
  if (error instanceof DomainError) return res.status(422).json({ error: error.message });
  console.error(JSON.stringify({ level: 'error', message: 'Request failed', name: error.name }));
  res.status(500).json({ error: 'The server could not complete this request. Your draft is still available; try again.' });
});
const server = app.listen(port, '0.0.0.0', () => console.log(`HAYA API ready on port ${port} (${production ? 'production' : 'development'}).`));
async function shutdown() { server.close(async () => { await mongo.close(); process.exit(0); }); setTimeout(() => process.exit(1), 20000).unref(); }
process.on('SIGTERM', shutdown); process.on('SIGINT', shutdown);
