const express = require('express');
const cors = require('cors');

const changellyRouter = require('./routes/changelly');
const swapRouter = require('./routes/swap');

const app = express();
const PORT = process.env.PORT ?? 8080;

app.use(cors());
app.use(express.json());

// ─── Health ────────────────────────────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'TapForge Backend' });
});

// ─── Changelly: debe ir ANTES para que /swap/changelly/* no lo capture swapRouter ──
app.use('/swap/changelly', changellyRouter);

// ─── Swap: proveedor unificado (Bitcoin.me DEX) ────────────────────────────
app.use('/swap', swapRouter);

// ─── 404 ───────────────────────────────────────────────────────────────────
app.use((req, res) => {
  res.status(404).json({ error: 'Endpoint no encontrado' });
});

app.listen(PORT, () => {
  console.log(`TapForge Backend corriendo en puerto ${PORT}`);
});
