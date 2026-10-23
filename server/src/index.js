import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import mongoose from 'mongoose';
import { projectsRouter } from './routes/projects.js';
import { aiRouter } from './routes/ai.js';
import { authRouter } from './routes/auth.js';

const app = express();
const PORT = process.env.PORT || 4000;
const CLIENT_ORIGIN = process.env.CLIENT_ORIGIN || 'http://localhost:5173';

app.use(cors({ origin: CLIENT_ORIGIN }));
app.use(express.json({ limit: '2mb' }));

app.get('/api/health', (_req, res) => {
  res.json({
    ok: true,
    service: 'scenetics-server',
    mongo: mongoose.connection.readyState === 1 ? 'connected' : 'not connected',
    ai: process.env.XAI_API_KEY ? 'configured' : 'not configured',
  });
});

app.use('/api/projects', projectsRouter);
app.use('/api/ai', aiRouter);
app.use('/auth', authRouter);

// Connect to MongoDB WITHOUT blocking startup: the demo (health, AI stub,
// client local save) must run anywhere. Failures are logged as warnings
// and project routes answer 503 until a database is available.
if (process.env.MONGODB_URI) {
  mongoose
    .connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 5000 })
    .then(() => console.log('[scenetics] MongoDB connected'))
    .catch((err) => console.warn(`[scenetics] WARNING: MongoDB not connected (${err.message}). Project routes will return 503.`));
} else {
  console.warn('[scenetics] WARNING: MONGODB_URI not set — project routes will return 503. Copy .env.example to .env to configure.');
}

app.listen(PORT, () => {
  console.log(`[scenetics] Server listening on http://localhost:${PORT}`);
});
