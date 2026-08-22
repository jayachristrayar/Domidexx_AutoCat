import cors from 'cors';
import dotenv from 'dotenv';
import express from 'express';
import adminRouter from './routes/admin.js';
import authRouter from './routes/auth.js';
import meRouter from './routes/me.js';
import recordsRouter from './routes/records.js';
import { startModelRefreshSchedule } from './services/openaiModelSelector.js';

dotenv.config();

const app = express();
const port = process.env.PORT || 10000;

// The extension calls this API directly from its popup/content scripts
// (Manifest V3, so requests carry a chrome-extension:// origin, not a
// normal http(s):// one). Requests with no Origin header (server-to-server
// calls, curl, health checks) aren't subject to CORS at all and are let
// through; anything else is rejected rather than reflected back like a
// blanket `origin: true` would. Scoped to just the extension-facing API
// routes -- /admin is a server-rendered dashboard navigated directly by a
// human's ordinary browser, whose same-origin form POSTs would otherwise
// get rejected by this same check (a same-origin form submission still
// carries an Origin header, just not a chrome-extension:// one).
class CorsOriginError extends Error {}

const extensionCors = cors({
  origin: (origin, callback) => {
    if (!origin || origin.startsWith('chrome-extension://')) {
      callback(null, true);
    } else {
      callback(new CorsOriginError('Not allowed by CORS'));
    }
  },
  credentials: true,
});

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.get('/health', (_req, res) => {
  res.json({ status: 'ok' });
});

app.use('/admin', adminRouter);
app.use('/auth', extensionCors, authRouter);
app.use('/me', extensionCors, meRouter);
app.use('/records', extensionCors, recordsRouter);

app.use((err, _req, res, _next) => {
  if (err instanceof CorsOriginError) {
    res.status(403).json({ error: 'Origin not allowed' });
    return;
  }
  console.error(err);
  res.status(500).json({ error: 'Internal server error' });
});

startModelRefreshSchedule();

app.listen(port, '0.0.0.0', () => {
  console.log(`AutoCat backend listening on port ${port}`);
});
