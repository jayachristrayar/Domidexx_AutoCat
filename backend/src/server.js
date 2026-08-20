import cors from 'cors';
import dotenv from 'dotenv';
import express from 'express';
import authRouter from './routes/auth.js';
import meRouter from './routes/me.js';
import recordsRouter from './routes/records.js';
import { startModelRefreshSchedule } from './services/openaiModelSelector.js';

dotenv.config();

const app = express();
const port = process.env.PORT || 10000;

// The only client is the browser extension, calling this API directly from
// its popup/content scripts (Manifest V3, so requests carry a
// chrome-extension:// origin, not a normal http(s):// one). Requests with
// no Origin header (server-to-server calls, curl, health checks) aren't
// subject to CORS at all and are let through; anything else is rejected
// rather than reflected back like a blanket `origin: true` would.
class CorsOriginError extends Error {}

app.use(
  cors({
    origin: (origin, callback) => {
      if (!origin || origin.startsWith('chrome-extension://')) {
        callback(null, true);
      } else {
        callback(new CorsOriginError('Not allowed by CORS'));
      }
    },
    credentials: true,
  })
);
app.use(express.json());

app.get('/health', (_req, res) => {
  res.json({ status: 'ok' });
});

app.use('/auth', authRouter);
app.use('/me', meRouter);
app.use('/records', recordsRouter);

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
