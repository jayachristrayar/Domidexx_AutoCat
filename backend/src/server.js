import cors from 'cors';
import dotenv from 'dotenv';
import express from 'express';
import authRouter from './routes/auth.js';
import meRouter from './routes/me.js';

dotenv.config();

const app = express();
const port = process.env.PORT || 10000;

app.use(
  cors({
    origin: true,
    credentials: true,
  })
);
app.use(express.json());

app.get('/health', (_req, res) => {
  res.json({ status: 'ok' });
});

app.use('/auth', authRouter);
app.use('/me', meRouter);

app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({ error: 'Internal server error' });
});

app.listen(port, '0.0.0.0', () => {
  console.log(`AutoCat backend listening on port ${port}`);
});
