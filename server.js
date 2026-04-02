require('dotenv').config();
const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const low = require('lowdb');
const FileSync = require('lowdb/adapters/FileSync');
const { randomUUID } = require('crypto');

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));

// ── Banco de dados (arquivo JSON local) ──
const adapter = new FileSync('db.json');
const db = low(adapter);

db.defaults({
  psicologas: [],
  pacientes: [],
  sessoes: [],
  prontuarios: [],
  agendamentos: [],
  lancamentos: [],
  espera: [],
}).write();

// Seed inicial se banco vazio
if (db.get('psicologas').size().value() === 0) {
  const hash = bcrypt.hashSync('senha123', 10);
  db.get('psicologas').push({
    id: randomUUID(),
    nome: 'Dra. Carol Martins',
    email: 'carol@clinica.com',
    senha: hash,
    abordagem: 'TCC · ACT',
    ativo: true,
    criadoEm: new Date().toISOString(),
  }).write();
  console.log('✓ Psicóloga padrão criada: carol@clinica.com / senha123');
}

// ── Middleware de autenticação ──
function auth(req, res, next) {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ erro: 'Não autenticado' });
  try {
    req.user = jwt.verify(token, process.env.JWT_SECRET || 'dev-secret');
    next();
  } catch {
    res.status(401).json({ erro: 'Token inválido' });
  }
}

// ── ROTAS: Auth ──

// POST /auth/login
app.post('/auth/login', async (req, res) => {
  const { email, senha } = req.body;
  const psi = db.get('psicologas').find({ email }).value();
  if (!psi || !bcrypt.compareSync(senha, psi.senha)) {
    return res.status(401).json({ erro: 'E-mail ou senha incorretos' });
  }
  const token = jwt.sign(
    { id: psi.id, nome: psi.nome, email: psi.email },
    process.env.JWT_SECRET || 'dev-secret',
    { expiresIn: '7d' }
  );
  res.json({ token, psicóloga: { id: psi.id, nome: psi.nome, email: psi.email, abordagem: psi.abordagem } });
});

// GET /auth/me
app.get('/auth/me', auth, (req, res) => {
  const psi = db.get('psicologas').find({ id: req.user.id }).value();
  if (!psi) return res.status(404).json({ erro: 'Não encontrado' });
  const { senha, ...dados } = psi;
  res.json(dados);
});

// ── ROTAS: Pacientes ──

// GET /pacientes
app.get('/pacientes', auth, (req, res) => {
  const lista = db.get('pacientes').filter({ ativo: true }).value();
  res.json(lista);
});

// POST /pacientes
app.post('/pacientes', auth, (req, res) => {
  const { nome, email, telefone, dataNascimento, abordagem, psiId, observacoes } = req.body;
  if (!nome) return res.status(400).json({ erro: 'Nome obrigatório' });
  const paciente = {
    id: randomUUID(),
    nome, email, telefone, dataNascimento,
    abordagem: abordagem || 'TCC',
    psiId: psiId || req.user.id,
    observacoes: observacoes || '',
    totalSessoes: 0,
    ativo: true,
    criadoEm: new Date().toISOString(),
  };
  db.get('pacientes').push(paciente).write();
  res.status(201).json(paciente);
});

// GET /pacientes/:id
app.get('/pacientes/:id', auth, (req, res) => {
  const p = db.get('pacientes').find({ id: req.params.id }).value();
  if (!p) return res.status(404).json({ erro: 'Paciente não encontrado' });
  res.json(p);
});

// PATCH /pacientes/:id
app.patch('/pacientes/:id', auth, (req, res) => {
  const p = db.get('pacientes').find({ id: req.params.id });
  if (!p.value()) return res.status(404).json({ erro: 'Não encontrado' });
  p.assign(req.body).write();
  res.json(p.value());
});

// ── ROTAS: Sessões e Prontuários ──

// GET /prontuarios?pacienteId=...
app.get('/prontuarios', auth, (req, res) => {
  const { pacienteId } = req.query;
  let lista = db.get('prontuarios');
  if (pacienteId) lista = lista.filter({ pacienteId });
  res.json(lista.orderBy('criadoEm', 'desc').value());
});

// POST /sessoes - cria sessão + prontuário via IA
app.post('/sessoes', auth, async (req, res) => {
  const { pacienteId, data, numSessao, abordagem, transcricao, anotacoes } = req.body;
  if (!pacienteId) return res.status(400).json({ erro: 'pacienteId obrigatório' });

  const paciente = db.get('pacientes').find({ id: pacienteId }).value();
  const psi = db.get('psicologas').find({ id: req.user.id }).value();

  // Criar registro de sessão
  const sessao = {
    id: randomUUID(),
    pacienteId,
    psiId: req.user.id,
    data: data || new Date().toISOString().slice(0, 10),
    numSessao: numSessao || '',
    abordagem: abordagem || paciente?.abordagem || 'TCC',
    status: 'realizada',
    criadoEm: new Date().toISOString(),
  };
  db.get('sessoes').push(sessao).write();

  // Atualizar contador de sessões do paciente
  db.get('pacientes').find({ id: pacienteId })
    .assign({ totalSessoes: (paciente?.totalSessoes || 0) + 1 })
    .write();

  // Chamar Claude para gerar a evolução
  const textoBase = transcricao || anotacoes || '';
  let evolucao = null;

  if (textoBase && process.env.ANTHROPIC_API_KEY) {
    try {
      evolucao = await gerarEvolucaoIA({
        paciente: paciente?.nome || 'Paciente',
        psi: psi?.nome || 'Psicóloga',
        abordagem: sessao.abordagem,
        numSessao: sessao.numSessao,
        data: sessao.data,
        texto: textoBase,
      });
    } catch (err) {
      console.error('Erro ao chamar Claude:', err.message);
    }
  }

  // Salvar prontuário
  const prontuario = {
    id: randomUUID(),
    sessaoId: sessao.id,
    pacienteId,
    psiId: req.user.id,
    data: sessao.data,
    transcricao: transcricao || '',
    anotacoes: anotacoes || '',
    resumo: evolucao?.resumo || '',
    conteudo: evolucao?.conteudo || '',
    intervencoes: evolucao?.intervencoes || '',
    evolucaoClinica: evolucao?.evolucao_clinica || '',
    plano: evolucao?.plano || '',
    geradoPorIA: !!evolucao,
    criadoEm: new Date().toISOString(),
    atualizadoEm: new Date().toISOString(),
  };
  db.get('prontuarios').push(prontuario).write();

  res.status(201).json({ sessao, prontuario });
});

// PATCH /prontuarios/:id - editar prontuário
app.patch('/prontuarios/:id', auth, (req, res) => {
  const p = db.get('prontuarios').find({ id: req.params.id });
  if (!p.value()) return res.status(404).json({ erro: 'Não encontrado' });
  p.assign({ ...req.body, atualizadoEm: new Date().toISOString() }).write();
  res.json(p.value());
});

// POST /prontuarios/:id/regerar - regerar com IA
app.post('/prontuarios/:id/regerar', auth, async (req, res) => {
  const pront = db.get('prontuarios').find({ id: req.params.id }).value();
  if (!pront) return res.status(404).json({ erro: 'Não encontrado' });

  const paciente = db.get('pacientes').find({ id: pront.pacienteId }).value();
  const sessao = db.get('sessoes').find({ id: pront.sessaoId }).value();

  if (!process.env.ANTHROPIC_API_KEY) {
    return res.status(400).json({ erro: 'ANTHROPIC_API_KEY não configurada no .env' });
  }

  try {
    const evolucao = await gerarEvolucaoIA({
      paciente: paciente?.nome || 'Paciente',
      psi: req.user.nome,
      abordagem: sessao?.abordagem || 'TCC',
      numSessao: sessao?.numSessao || '',
      data: pront.data,
      texto: pront.transcricao || pront.anotacoes,
    });

    db.get('prontuarios').find({ id: req.params.id }).assign({
      ...evolucao,
      evolucaoClinica: evolucao.evolucao_clinica,
      geradoPorIA: true,
      atualizadoEm: new Date().toISOString(),
    }).write();

    res.json(db.get('prontuarios').find({ id: req.params.id }).value());
  } catch (err) {
    res.status(500).json({ erro: err.message });
  }
});

// ── ROTAS: Agendamentos ──

// GET /agendamentos?data=YYYY-MM-DD
app.get('/agendamentos', auth, (req, res) => {
  const { data, psiId } = req.query;
  let lista = db.get('agendamentos');
  if (data) lista = lista.filter({ data });
  if (psiId) lista = lista.filter({ psiId });
  res.json(lista.orderBy('hora').value());
});

// POST /agendamentos
app.post('/agendamentos', auth, (req, res) => {
  const { pacienteId, data, hora, tipo, observacoes } = req.body;
  if (!pacienteId || !data || !hora) {
    return res.status(400).json({ erro: 'pacienteId, data e hora obrigatórios' });
  }
  const ag = {
    id: randomUUID(),
    pacienteId,
    psiId: req.body.psiId || req.user.id,
    data, hora,
    tipo: tipo || 'Regular',
    observacoes: observacoes || '',
    status: 'confirmado',
    criadoEm: new Date().toISOString(),
  };
  db.get('agendamentos').push(ag).write();
  res.status(201).json(ag);
});

// PATCH /agendamentos/:id
app.patch('/agendamentos/:id', auth, (req, res) => {
  const ag = db.get('agendamentos').find({ id: req.params.id });
  if (!ag.value()) return res.status(404).json({ erro: 'Não encontrado' });
  ag.assign(req.body).write();
  res.json(ag.value());
});

// ── ROTAS: Financeiro ──

// GET /lancamentos
app.get('/lancamentos', auth, (req, res) => {
  const { mes, ano } = req.query;
  let lista = db.get('lancamentos');
  if (mes && ano) {
    lista = lista.filter(l => l.data?.startsWith(`${ano}-${mes.padStart(2,'0')}`));
  }
  res.json(lista.orderBy('data', 'desc').value());
});

// POST /lancamentos
app.post('/lancamentos', auth, (req, res) => {
  const { pacienteId, tipo, valor, data, descricao, status } = req.body;
  if (!valor) return res.status(400).json({ erro: 'valor obrigatório' });
  const lanc = {
    id: randomUUID(),
    pacienteId: pacienteId || null,
    psiId: req.user.id,
    tipo: tipo || 'Sessão',
    valor: parseFloat(valor),
    data: data || new Date().toISOString().slice(0, 10),
    descricao: descricao || '',
    status: status || 'pago',
    criadoEm: new Date().toISOString(),
  };
  db.get('lancamentos').push(lanc).write();
  res.status(201).json(lanc);
});

// GET /financeiro/resumo
app.get('/financeiro/resumo', auth, (req, res) => {
  const agora = new Date();
  const mesAtual = `${agora.getFullYear()}-${String(agora.getMonth()+1).padStart(2,'0')}`;
  const lancMes = db.get('lancamentos')
    .filter(l => l.data?.startsWith(mesAtual))
    .value();
  const totalPago = lancMes.filter(l => l.status === 'pago').reduce((s, l) => s + l.valor, 0);
  const totalPendente = lancMes.filter(l => l.status === 'pendente').reduce((s, l) => s + l.valor, 0);
  res.json({
    mes: mesAtual,
    totalPago,
    totalPendente,
    totalSessoes: lancMes.length,
    ticketMedio: lancMes.length ? (totalPago / lancMes.length).toFixed(2) : 0,
  });
});

// ── ROTAS: Lista de espera ──

// GET /espera
app.get('/espera', auth, (req, res) => {
  res.json(db.get('espera').orderBy('posicao').value());
});

// POST /espera
app.post('/espera', auth, (req, res) => {
  const { nome, email, telefone, origem, observacoes } = req.body;
  if (!nome) return res.status(400).json({ erro: 'nome obrigatório' });
  const total = db.get('espera').size().value();
  const pessoa = {
    id: randomUUID(),
    nome, email, telefone,
    origem: origem || 'Instagram',
    observacoes: observacoes || '',
    posicao: total + 1,
    status: 'aguardando',
    criadoEm: new Date().toISOString(),
  };
  db.get('espera').push(pessoa).write();
  res.status(201).json(pessoa);
});

// POST /espera/:id/converter - move da lista de espera para paciente ativo
app.post('/espera/:id/converter', auth, (req, res) => {
  const pessoa = db.get('espera').find({ id: req.params.id }).value();
  if (!pessoa) return res.status(404).json({ erro: 'Não encontrado' });

  const paciente = {
    id: randomUUID(),
    nome: pessoa.nome,
    email: pessoa.email,
    telefone: pessoa.telefone,
    abordagem: req.body.abordagem || 'TCC',
    psiId: req.body.psiId || req.user.id,
    totalSessoes: 0,
    ativo: true,
    criadoEm: new Date().toISOString(),
  };
  db.get('pacientes').push(paciente).write();
  db.get('espera').find({ id: req.params.id }).assign({ status: 'convertido' }).write();

  res.json({ paciente, mensagem: 'Convertido para paciente ativo com sucesso' });
});

// ── ROTAS: Psicólogas ──

// GET /psicologas
app.get('/psicologas', auth, (req, res) => {
  const lista = db.get('psicologas').map(p => {
    const { senha, ...dados } = p;
    return dados;
  }).value();
  res.json(lista);
});

// POST /psicologas
app.post('/psicologas', auth, async (req, res) => {
  const { nome, email, senha, abordagem } = req.body;
  if (!nome || !email || !senha) {
    return res.status(400).json({ erro: 'nome, email e senha obrigatórios' });
  }
  if (db.get('psicologas').find({ email }).value()) {
    return res.status(400).json({ erro: 'E-mail já cadastrado' });
  }
  const hash = await bcrypt.hash(senha, 10);
  const psi = {
    id: randomUUID(),
    nome, email,
    senha: hash,
    abordagem: abordagem || 'TCC',
    ativo: true,
    criadoEm: new Date().toISOString(),
  };
  db.get('psicologas').push(psi).write();
  const { senha: _, ...retorno } = psi;
  res.status(201).json(retorno);
});

// ── IA: Gerar evolução com Claude ──
async function gerarEvolucaoIA({ paciente, psi, abordagem, numSessao, data, texto }) {
  const systemPrompt = `Você é um assistente especializado em psicologia clínica, com profundo conhecimento de ${abordagem}. Analise o conteúdo da sessão terapêutica e gere uma evolução de prontuário estruturada, profissional e clinicamente relevante. Escreva em linguagem técnica, na terceira pessoa. Responda SOMENTE com JSON válido, sem texto antes ou depois.`;

  const userPrompt = `Paciente: ${paciente}
Psicóloga: ${psi}
Abordagem: ${abordagem}
${numSessao ? `Sessão: ${numSessao}` : ''}
Data: ${data}

CONTEÚDO:
${texto}

Retorne JSON:
{
  "resumo": "...",
  "conteudo": "...",
  "intervencoes": "...",
  "evolucao_clinica": "...",
  "plano": "..."
}`;

  const resp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 2000,
      system: systemPrompt,
      messages: [{ role: 'user', content: userPrompt }],
    }),
  });

  if (!resp.ok) {
    const err = await resp.json();
    throw new Error(err.error?.message || `API error ${resp.status}`);
  }

  const data_resp = await resp.json();
  const raw = data_resp.content?.[0]?.text || '';
  const cleaned = raw.replace(/```json|```/g, '').trim();
  return JSON.parse(cleaned);
}

// ── Health check ──
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    pacientes: db.get('pacientes').size().value(),
    prontuarios: db.get('prontuarios').size().value(),
    version: '1.0.0',
  });
});

// ── Start ──
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`\n✅ Servidor rodando em http://localhost:${PORT}`);
  console.log(`📋 Health check: http://localhost:${PORT}/health`);
  console.log(`🔑 API key: ${process.env.ANTHROPIC_API_KEY ? '✓ configurada' : '✗ não configurada (configure no .env)'}`);
});
