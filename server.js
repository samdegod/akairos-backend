require('dotenv').config();
const express = require('express');
const cors    = require('cors');
const bcrypt  = require('bcryptjs');
const jwt     = require('jsonwebtoken');
const low     = require('lowdb');
const FileSync = require('lowdb/adapters/FileSync');
const { randomUUID } = require('crypto');

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));

const db = low(new FileSync('db.json'));
db.defaults({ psicologas:[], pacientes:[], sessoes:[], prontuarios:[], agendamentos:[], lancamentos:[], espera:[] }).write();

if (db.get('psicologas').size().value() === 0) {
  db.get('psicologas').push({
    id: randomUUID(), nome: 'Administrador',
    email: 'admin@akairos.com',
    senha: bcrypt.hashSync('akairos2025', 10),
    abordagem: 'TCC', perfil: 'admin', crp: '', gcalLink: '',
    ativo: true, criadoEm: new Date().toISOString(),
  }).write();
  console.log('\n✅ Admin criado: admin@akairos.com / akairos2025\n⚠️  Troque a senha apos o primeiro login!\n');
}

function auth(req, res, next) {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ erro: 'Nao autenticado' });
  try { req.user = jwt.verify(token, process.env.JWT_SECRET || 'dev-secret'); next(); }
  catch { res.status(401).json({ erro: 'Token invalido' }); }
}
function adminOnly(req, res, next) {
  const psi = db.get('psicologas').find({ id: req.user.id }).value();
  if (psi?.perfil !== 'admin') return res.status(403).json({ erro: 'Acesso restrito a administradores' });
  next();
}

app.post('/auth/login', async (req, res) => {
  const { email, senha } = req.body;
  const psi = db.get('psicologas').find({ email }).value();
  if (!psi || !bcrypt.compareSync(senha, psi.senha)) return res.status(401).json({ erro: 'E-mail ou senha incorretos' });
  const token = jwt.sign({ id: psi.id, nome: psi.nome, email: psi.email, perfil: psi.perfil || 'psicologa' }, process.env.JWT_SECRET || 'dev-secret', { expiresIn: '7d' });
  const { senha: _, ...dados } = psi;
  res.json({ token, psicologa: dados });
});

app.get('/auth/me', auth, (req, res) => {
  const psi = db.get('psicologas').find({ id: req.user.id }).value();
  if (!psi) return res.status(404).json({ erro: 'Nao encontrado' });
  const { senha, ...dados } = psi;
  res.json(dados);
});

app.get('/pacientes', auth, (req, res) => {
  let lista = db.get('pacientes');
  if (req.user.perfil !== 'admin') lista = lista.filter({ psiId: req.user.id });
  res.json(lista.value());
});

app.post('/pacientes', auth, (req, res) => {
  if (!req.body.nome) return res.status(400).json({ erro: 'Nome obrigatorio' });
  const p = { id: randomUUID(), nome: req.body.nome, cpf: req.body.cpf||'', dataNascimento: req.body.dataNascimento||'', telefone: req.body.telefone||'', email: req.body.email||'', origem: req.body.origem||'', emergNome: req.body.emergNome||'', emergTel: req.body.emergTel||'', emergRel: req.body.emergRel||'', abordagem: req.body.abordagem||'TCC', psiId: req.body.psiId||req.user.id, valorSessao: req.body.valorSessao||null, convenio: req.body.convenio||'', pgtoPreferido: req.body.pgtoPreferido||'Pix', queixa: req.body.queixa||'', histClinico: req.body.histClinico||'', observacoes: req.body.observacoes||'', cor: req.body.cor||'#e8f4e4', totalSessoes: 0, ativo: req.body.ativo !== false, criadoEm: new Date().toISOString() };
  db.get('pacientes').push(p).write();
  res.status(201).json(p);
});

app.get('/pacientes/:id', auth, (req, res) => {
  const p = db.get('pacientes').find({ id: req.params.id }).value();
  if (!p) return res.status(404).json({ erro: 'Nao encontrado' });
  if (req.user.perfil !== 'admin' && p.psiId !== req.user.id) return res.status(403).json({ erro: 'Acesso negado' });
  res.json(p);
});

app.patch('/pacientes/:id', auth, (req, res) => {
  const p = db.get('pacientes').find({ id: req.params.id });
  if (!p.value()) return res.status(404).json({ erro: 'Nao encontrado' });
  p.assign({ ...req.body, atualizadoEm: new Date().toISOString() }).write();
  res.json(p.value());
});

app.get('/prontuarios', auth, (req, res) => {
  const { pacienteId } = req.query;
  let lista = db.get('prontuarios');
  if (pacienteId) lista = lista.filter({ pacienteId });
  else if (req.user.perfil !== 'admin') lista = lista.filter({ psiId: req.user.id });
  res.json(lista.orderBy('criadoEm', 'desc').value());
});

app.post('/sessoes', auth, async (req, res) => {
  const { pacienteId, data, numSessao, abordagem, transcricao, anotacoes } = req.body;
  if (!pacienteId) return res.status(400).json({ erro: 'pacienteId obrigatorio' });
  const paciente = db.get('pacientes').find({ id: pacienteId }).value();
  const psi = db.get('psicologas').find({ id: req.user.id }).value();
  const sessao = { id: randomUUID(), pacienteId, psiId: req.user.id, data: data||new Date().toISOString().slice(0,10), numSessao: numSessao||'', abordagem: abordagem||paciente?.abordagem||'TCC', status: 'realizada', criadoEm: new Date().toISOString() };
  db.get('sessoes').push(sessao).write();
  db.get('pacientes').find({ id: pacienteId }).assign({ totalSessoes: (paciente?.totalSessoes||0)+1 }).write();
  const textoBase = transcricao||anotacoes||'';
  let evolucao = null;
  if (textoBase && process.env.ANTHROPIC_API_KEY) {
    try { evolucao = await gerarEvolucaoIA({ paciente: paciente?.nome||'Paciente', psi: psi?.nome||'Psicologa', abordagem: sessao.abordagem, numSessao: sessao.numSessao, data: sessao.data, texto: textoBase }); }
    catch (err) { console.error('Claude error:', err.message); }
  }
  const prontuario = { id: randomUUID(), sessaoId: sessao.id, pacienteId, psiId: req.user.id, data: sessao.data, transcricao: transcricao||'', anotacoes: anotacoes||'', resumo: evolucao?.resumo||'', conteudo: evolucao?.conteudo||'', intervencoes: evolucao?.intervencoes||'', evolucaoClinica: evolucao?.evolucao_clinica||'', plano: evolucao?.plano||'', geradoPorIA: !!evolucao, criadoEm: new Date().toISOString(), atualizadoEm: new Date().toISOString() };
  db.get('prontuarios').push(prontuario).write();
  res.status(201).json({ sessao, prontuario });
});

app.patch('/prontuarios/:id', auth, (req, res) => {
  const p = db.get('prontuarios').find({ id: req.params.id });
  if (!p.value()) return res.status(404).json({ erro: 'Nao encontrado' });
  p.assign({ ...req.body, atualizadoEm: new Date().toISOString() }).write();
  res.json(p.value());
});

app.get('/agendamentos', auth, (req, res) => {
  const { data, psiId } = req.query;
  let lista = db.get('agendamentos');
  if (req.user.perfil !== 'admin') lista = lista.filter({ psiId: req.user.id });
  if (data) lista = lista.filter({ data });
  if (psiId && req.user.perfil === 'admin') lista = lista.filter({ psiId });
  res.json(lista.orderBy(['data','hora']).value());
});

app.post('/agendamentos', auth, (req, res) => {
  const { pacienteId, data, hora, tipo, observacoes, psiId, status } = req.body;
  if (!pacienteId||!data||!hora) return res.status(400).json({ erro: 'pacienteId, data e hora obrigatorios' });
  const ag = { id: randomUUID(), pacienteId, psiId: psiId||req.user.id, data, hora, tipo: tipo||'Regular', observacoes: observacoes||'', status: status||'confirmado', criadoEm: new Date().toISOString() };
  db.get('agendamentos').push(ag).write();
  db.get('pacientes').find({ id: pacienteId }).assign({ proximaSessao: data+' '+hora }).write();
  res.status(201).json(ag);
});

app.patch('/agendamentos/:id', auth, (req, res) => {
  const ag = db.get('agendamentos').find({ id: req.params.id });
  if (!ag.value()) return res.status(404).json({ erro: 'Nao encontrado' });
  ag.assign(req.body).write();
  res.json(ag.value());
});

app.get('/lancamentos', auth, adminOnly, (req, res) => {
  const { mes, ano } = req.query;
  let lista = db.get('lancamentos');
  if (mes && ano) lista = lista.filter(l => l.data?.startsWith(`${ano}-${String(mes).padStart(2,'0')}`));
  res.json(lista.orderBy('data','desc').value());
});

app.post('/lancamentos', auth, adminOnly, (req, res) => {
  if (!req.body.valor) return res.status(400).json({ erro: 'valor obrigatorio' });
  const lanc = { id: randomUUID(), pacienteId: req.body.pacienteId||null, psiId: req.body.psiId||req.user.id, tipo: req.body.tipo||'Sessao', valor: parseFloat(req.body.valor), data: req.body.data||new Date().toISOString().slice(0,10), descricao: req.body.descricao||'', status: req.body.status||'pago', criadoEm: new Date().toISOString() };
  db.get('lancamentos').push(lanc).write();
  res.status(201).json(lanc);
});

app.get('/financeiro/resumo', auth, adminOnly, (req, res) => {
  const mes = new Date().toISOString().slice(0,7);
  const lan = db.get('lancamentos').filter(l => l.data?.startsWith(mes)).value();
  const pago = lan.filter(l=>l.status==='pago').reduce((s,l)=>s+l.valor,0);
  const pend = lan.filter(l=>l.status==='pendente').reduce((s,l)=>s+l.valor,0);
  res.json({ mes, totalPago: pago, totalPendente: pend, totalSessoes: lan.length, ticketMedio: lan.length?+(pago/lan.length).toFixed(2):0 });
});

app.get('/espera', auth, (req, res) => {
  res.json(db.get('espera').orderBy('criadoEm').value());
});

app.post('/espera', auth, (req, res) => {
  if (!req.body.nome||!req.body.telefone) return res.status(400).json({ erro: 'nome e telefone obrigatorios' });
  const p = { id: randomUUID(), nome: req.body.nome, telefone: req.body.telefone, email: req.body.email||'', origem: req.body.origem||'Instagram', observacoes: req.body.observacoes||'', status: 'aguardando', criadoEm: new Date().toISOString() };
  db.get('espera').push(p).write();
  res.status(201).json(p);
});

app.post('/espera/:id/converter', auth, (req, res) => {
  const pessoa = db.get('espera').find({ id: req.params.id }).value();
  if (!pessoa) return res.status(404).json({ erro: 'Nao encontrado' });
  const paciente = { id: randomUUID(), nome: pessoa.nome, email: pessoa.email||'', telefone: pessoa.telefone||'', origem: pessoa.origem||'', abordagem: req.body.abordagem||'TCC', psiId: req.body.psiId||req.user.id, cor: '#e8f4e4', totalSessoes: 0, ativo: true, criadoEm: new Date().toISOString() };
  db.get('pacientes').push(paciente).write();
  db.get('espera').find({ id: req.params.id }).assign({ status: 'convertido' }).write();
  res.json({ paciente });
});

app.get('/psicologas', auth, (req, res) => {
  res.json(db.get('psicologas').map(p => { const { senha, ...d } = p; return d; }).value());
});

app.post('/psicologas', auth, adminOnly, async (req, res) => {
  const { nome, email, senha, abordagem, perfil, crp, gcalLink } = req.body;
  if (!nome||!email||!senha) return res.status(400).json({ erro: 'nome, email e senha obrigatorios' });
  if (db.get('psicologas').find({ email }).value()) return res.status(400).json({ erro: 'E-mail ja cadastrado' });
  const psi = { id: randomUUID(), nome, email, senha: await bcrypt.hash(senha, 10), abordagem: abordagem||'TCC', perfil: perfil||'psicologa', crp: crp||'', gcalLink: gcalLink||'', ativo: true, criadoEm: new Date().toISOString() };
  db.get('psicologas').push(psi).write();
  const { senha: _, ...retorno } = psi;
  res.status(201).json(retorno);
});

app.patch('/psicologas/:id', auth, async (req, res) => {
  if (req.user.perfil !== 'admin' && req.user.id !== req.params.id) return res.status(403).json({ erro: 'Acesso negado' });
  const psi = db.get('psicologas').find({ id: req.params.id });
  if (!psi.value()) return res.status(404).json({ erro: 'Nao encontrado' });
  const update = { ...req.body };
  if (update.senha) update.senha = await bcrypt.hash(update.senha, 10);
  psi.assign(update).write();
  const { senha, ...retorno } = psi.value();
  res.json(retorno);
});

async function gerarEvolucaoIA({ paciente, psi, abordagem, numSessao, data, texto }) {
  const system = `Voce e um assistente de psicologia clinica especializado em ${abordagem}. Gere uma evolucao de prontuario estruturada. Escreva em linguagem tecnica, terceira pessoa. Responda SOMENTE com JSON valido.`;
  const user = `Paciente: ${paciente}\nPsicologa: ${psi}\nAbordagem: ${abordagem}${numSessao?'\nSessao: '+numSessao:''}\nData: ${data}\n\nCONTEUDO:\n${texto}\n\nRetorne: {"resumo":"...","conteudo":"...","intervencoes":"...","evolucao_clinica":"...","plano":"..."}`;
  const r = await fetch('https://api.anthropic.com/v1/messages', { method:'POST', headers:{'Content-Type':'application/json','x-api-key':process.env.ANTHROPIC_API_KEY,'anthropic-version':'2023-06-01'}, body: JSON.stringify({ model:'claude-sonnet-4-20250514', max_tokens:2000, system, messages:[{role:'user',content:user}] }) });
  if (!r.ok) { const e=await r.json(); throw new Error(e.error?.message||'API error '+r.status); }
  const d = await r.json();
  return JSON.parse(d.content?.[0]?.text?.replace(/```json|```/g,'').trim()||'{}');
}

app.post('/admin/reset', auth, adminOnly, (req, res) => {
  ['pacientes','sessoes','prontuarios','agendamentos','lancamentos','espera'].forEach(t => db.set(t,[]).write());
  console.log('Reset por', req.user.email);
  res.json({ ok: true });
});

app.get('/health', (req, res) => {
  res.json({ status:'ok', pacientes: db.get('pacientes').size().value(), prontuarios: db.get('prontuarios').size().value(), version:'2.0.0' });
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`\n✅ Akairos backend v2 na porta ${PORT}`);
  console.log(`🔑 Anthropic API key: ${process.env.ANTHROPIC_API_KEY?'configurada':'NAO configurada'}`);
});
