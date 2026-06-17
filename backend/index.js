import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3001;
const DATA_FILE = join(__dirname, process.env.DATA_FILE || 'data.json');
const ADMIN_API_KEY = process.env.ADMIN_API_KEY || 'dev-key-change-in-production';
const CORS_ORIGINS = process.env.CORS_ORIGINS
  ? process.env.CORS_ORIGINS.split(',').map(s => s.trim())
  : ['http://localhost:5173', 'http://localhost:4173'];

function loadData() {
  if (!existsSync(DATA_FILE)) {
    return {};
  }
  try {
    return JSON.parse(readFileSync(DATA_FILE, 'utf-8'));
  } catch {
    console.error('Corrupted data file, starting fresh');
    return {};
  }
}

function saveData(data) {
  writeFileSync(DATA_FILE, JSON.stringify(data, null, 2), 'utf-8');
}

function validateContractId(id) {
  return typeof id === 'string' && id.length >= 50 && id.startsWith('C');
}

function validateRwaBody(body) {
  const required = ['title', 'location', 'description', 'assetType'];
  const missing = required.filter(f => !body[f]);
  if (missing.length > 0) {
    return `Missing required fields: ${missing.join(', ')}`;
  }
  return null;
}

function adminAuth(req, res, next) {
  const apiKey = req.headers['x-api-key'];
  if (!apiKey || apiKey !== ADMIN_API_KEY) {
    return res.status(401).json({ error: 'Unauthorized: invalid or missing API key' });
  }
  next();
}

const app = express();

app.use(helmet());
app.use(cors({ origin: CORS_ORIGINS, methods: ['GET', 'POST', 'DELETE'], allowedHeaders: ['Content-Type', 'x-api-key'] }));
app.use(express.json({ limit: '10kb' }));

const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 200,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, please try again later' },
});
app.use('/api/', apiLimiter);

const writeLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many write requests, please try again later' },
});

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.get('/api/rwa', (_req, res) => {
  const data = loadData();
  const assets = Object.entries(data).map(([contractId, meta]) => ({
    contractId,
    ...meta,
  }));
  res.json(assets);
});

app.get('/api/rwa/:contractId', (req, res) => {
  const { contractId } = req.params;
  const data = loadData();
  const asset = data[contractId];

  if (!asset) {
    return res.status(404).json({ error: 'Asset metadata not found' });
  }

  res.json({ contractId, ...asset });
});

app.post('/api/rwa', adminAuth, writeLimiter, (req, res) => {
  const { contractId, ...metadata } = req.body;

  if (!contractId || !validateContractId(contractId)) {
    return res.status(400).json({ error: 'Invalid contract ID. Must start with C and be at least 50 characters.' });
  }

  const validationError = validateRwaBody(metadata);
  if (validationError) {
    return res.status(400).json({ error: validationError });
  }

  const data = loadData();
  data[contractId] = {
    id: metadata.id || contractId,
    title: metadata.title,
    location: metadata.location,
    description: metadata.description,
    assetType: metadata.assetType,
    imageUrl: metadata.imageUrl || '',
    totalValuation: metadata.totalValuation || '',
    documents: Array.isArray(metadata.documents) ? metadata.documents : [],
    createdAt: metadata.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  saveData(data);

  res.status(201).json({ contractId, ...data[contractId] });
});

app.delete('/api/rwa/:contractId', adminAuth, writeLimiter, (req, res) => {
  const { contractId } = req.params;
  const data = loadData();

  if (!data[contractId]) {
    return res.status(404).json({ error: 'Asset metadata not found' });
  }

  delete data[contractId];
  saveData(data);

  res.json({ message: 'Asset metadata deleted', contractId });
});

app.use((_req, res) => {
  res.status(404).json({ error: 'Not found' });
});

app.use((err, _req, res, _next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

app.listen(PORT, () => {
  console.log(`RWA Off-chain Metadata Backend running at http://localhost:${PORT}`);
});
