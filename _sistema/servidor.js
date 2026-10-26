// Servidor local do Estúdio de Fotos (Polivenda).
// O login do Google não funciona em arquivos abertos direto do disco (file://),
// então o app passa a ser aberto em http://localhost:8765 — só neste computador.
// Ele também guarda a autorização do Google (refresh token) para o app não pedir login toda vez
// e guarda o cadastro, as configurações, o manifesto, os backups e a lixeira em _sistema (a pasta Estudio Polivenda fica só com os produtos).
const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn, exec } = require('child_process');

const VERSAO = '5';
const PORT = +process.env.ESTUDIO_PORTA || 8765; // a variável só serve para testes
const URL = `http://localhost:${PORT}/`;
const NO_BROWSER = process.argv.includes('--sem-navegador');
// onde procurar o app, nesta ordem (procura a cada acesso: mover o arquivo entre esses lugares não quebra nada)
const APP_NAME = 'organizador-fotos.html';
const CANDIDATOS = [
  ...process.argv.slice(2).filter(a => !a.startsWith('--')),
  path.join(__dirname, APP_NAME),
  path.join(__dirname, '..', APP_NAME),
  path.join(process.env.USERPROFILE || '', 'Desktop', APP_NAME),
];
const findApp = () => CANDIDATOS.find(f => fs.existsSync(f));

function openBrowser(){
  if (NO_BROWSER) return;
  const cands = [
    path.join(process.env.ProgramFiles || '', 'Google/Chrome/Application/chrome.exe'),
    path.join(process.env['ProgramFiles(x86)'] || '', 'Google/Chrome/Application/chrome.exe'),
    path.join(process.env.LOCALAPPDATA || '', 'Google/Chrome/Application/chrome.exe'),
    path.join(process.env['ProgramFiles(x86)'] || '', 'Microsoft/Edge/Application/msedge.exe'),
    path.join(process.env.ProgramFiles || '', 'Microsoft/Edge/Application/msedge.exe'),
  ];
  const exe = cands.find(f => fs.existsSync(f));
  if (exe) spawn(exe, ['--app=' + URL], { detached: true, stdio: 'ignore' }).unref();
  else exec(`start "" "${URL}"`);
}

// ---------- autorização do Google guardada neste computador ----------
// google-acesso.json fica nesta pasta: tem a chave secreta do cliente e o refresh token. Não compartilhe.
const ACESSO = path.join(__dirname, 'google-acesso.json');
const lerAcesso = () => { try { return JSON.parse(fs.readFileSync(ACESSO, 'utf8')); } catch { return {}; } };
const gravarAcesso = a => fs.writeFileSync(ACESSO, JSON.stringify(a, null, 2));
async function googleToken(params){
  const r = await fetch('https://oauth2.googleapis.com/token', { method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(params) });
  return { ok: r.ok, j: await r.json().catch(() => ({})) };
}
const json = (res, status, obj) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(obj)); };
const lerCorpo = req => new Promise(ok => { let b = ''; req.on('data', c => { b += c; if (b.length > 1e5) req.destroy(); }); req.on('end', () => { try { ok(JSON.parse(b || '{}')); } catch { ok({}); } }); });

async function rotaGoogle(req, res, p, q){
  const a = lerAcesso();
  // há login guardado para este Client ID?
  if (p === '/google/status') return json(res, 200, { conectado: !!a.refresh_token && a.clientId === q.get('client'), temSegredo: !!a.clientSecret && a.clientId === q.get('client') });
  // novo acesso de 1 hora a partir do login guardado (sem janela do Google)
  if (p === '/google/token'){
    if (!a.refresh_token || a.clientId !== q.get('client')) return json(res, 401, { erro: 'sem-login' });
    const { ok, j } = await googleToken({ client_id: a.clientId, client_secret: a.clientSecret, refresh_token: a.refresh_token, grant_type: 'refresh_token' });
    if (!ok){
      if (j.error === 'invalid_grant'){ delete a.refresh_token; gravarAcesso(a); }
      return json(res, 401, { erro: j.error_description || j.error || 'expirou' });
    }
    return json(res, 200, { access_token: j.access_token, expires_in: j.expires_in });
  }
  if (req.method !== 'POST') return json(res, 405, { erro: 'método' });
  const b = await lerCorpo(req);
  // primeiro login: troca o código da janela do Google pela autorização permanente
  if (p === '/google/troca'){
    const segredo = b.clientSecret || (a.clientId === b.clientId ? a.clientSecret : '');
    if (!b.code || !b.clientId) return json(res, 400, { erro: 'Pedido incompleto.' });
    if (!segredo) return json(res, 400, { erro: 'Falta a chave secreta do cliente (Client secret) em Configurações → Conexões → Google Drive.' });
    const { ok, j } = await googleToken({ code: b.code, client_id: b.clientId, client_secret: segredo, redirect_uri: 'postmessage', grant_type: 'authorization_code' });
    if (!ok) return json(res, 400, { erro: j.error === 'invalid_client' ? 'Chave secreta do cliente incorreta. Confira em Configurações → Conexões → Google Drive.' : (j.error_description || j.error || 'O Google recusou o login.') });
    gravarAcesso({ clientId: b.clientId, clientSecret: segredo, refresh_token: j.refresh_token || (a.clientId === b.clientId ? a.refresh_token : undefined) });
    return json(res, 200, { access_token: j.access_token, expires_in: j.expires_in, guardado: !!(j.refresh_token || a.refresh_token) });
  }
  // sair: revoga no Google e apaga daqui (a chave secreta fica, para entrar de novo sem colar)
  if (p === '/google/sair'){
    if (a.refresh_token) await fetch('https://oauth2.googleapis.com/revoke?token=' + encodeURIComponent(a.refresh_token), { method: 'POST' }).catch(() => {});
    delete a.refresh_token; gravarAcesso(a);
    return json(res, 200, { ok: true });
  }
  return json(res, 404, { erro: 'rota' });
}

// ---------- dados do app: tudo que NÃO é foto de produto fica aqui, em _sistema ----------
// O navegador não consegue gravar fora da pasta principal; por isso ele pede ao servidor.
// Só estas pastas aceitam leitura e gravação (o resto de _sistema, como o login do Google, fica fora de alcance).
const PERMITIDAS = ['dados', 'backup/cadastro', 'lixeira', 'registro', 'fornecedor'];
const LIMITE_MB = 800;
function caminhoSeguro(rel, ehPasta){
  const partes = String(rel || '').split('/');
  if (!partes.length || partes.length > 8) return null;
  if (partes.some(s => !s || s === '.' || s === '..' || s.length > 150 || /[\\:*?"<>|\x00-\x1f]/.test(s) || /[. ]$/.test(s))) return null;
  const junto = partes.join('/');
  if (!PERMITIDAS.some(b => junto === b ? ehPasta : junto.startsWith(b + '/'))) return null;
  const abs = path.join(__dirname, ...partes);
  return abs.startsWith(__dirname + path.sep) ? abs : null;
}
function rotaSistema(req, res, p, q){
  const ehPasta = p === '/sistema/listar';
  const abs = caminhoSeguro(q.get(ehPasta ? 'pasta' : 'arq'), ehPasta);
  if (!abs) return json(res, 400, { erro: 'Caminho não permitido.' });
  const escreve = req.method === 'POST';
  // quem grava ou apaga precisa mandar o cabeçalho do app (um formulário de outro site não consegue)
  if (escreve && req.headers['x-estudio'] !== '1') return json(res, 403, { erro: 'Pedido não reconhecido.' });
  if (p === '/sistema/ler' && req.method === 'GET'){
    fs.stat(abs, (e, st) => {
      if (e || !st.isFile()) return json(res, 404, { erro: 'não existe' });
      res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': st.size, 'X-Mtime': String(Math.round(st.mtimeMs)), 'Cache-Control': 'no-store' });
      fs.createReadStream(abs).pipe(res);
    });
    return;
  }
  if (p === '/sistema/listar' && req.method === 'GET'){
    fs.readdir(abs, { withFileTypes: true }, (e, itens) => json(res, 200, e ? [] : itens.filter(i => i.isFile()).map(i => i.name)));
    return;
  }
  if (p === '/sistema/apagar' && escreve){
    fs.unlink(abs, e => json(res, e && e.code !== 'ENOENT' ? 500 : 200, e && e.code !== 'ENOENT' ? { erro: e.message } : { ok: true }));
    return;
  }
  if (p === '/sistema/gravar' && escreve){
    // grava num arquivo temporário e só troca no fim: se algo falhar no meio, o arquivo bom não é perdido
    const tmp = abs + '.gravando-' + process.pid;
    let total = 0, falhou = false;
    const falha = (status, msg) => { if (falhou) return; falhou = true; out.destroy(); fs.unlink(tmp, () => {}); if (!res.headersSent) json(res, status, { erro: msg }); };
    try { fs.mkdirSync(path.dirname(abs), { recursive: true }); } catch (e) { return json(res, 500, { erro: e.message }); }
    const out = fs.createWriteStream(tmp);
    req.on('data', c => { total += c.length; if (total > LIMITE_MB * 1048576){ falha(413, 'Arquivo grande demais.'); req.destroy(); } });
    req.on('error', () => falha(400, 'Envio interrompido.'));
    out.on('error', e => falha(500, e.message));
    out.on('finish', () => {
      if (falhou) return;
      fs.rename(tmp, abs, e => e ? (fs.unlink(tmp, () => {}), json(res, 500, { erro: e.message })) : json(res, 200, { ok: true, bytes: total }));
    });
    req.pipe(out);
    return;
  }
  return json(res, 405, { erro: 'método' });
}

const server = http.createServer(async (req, res) => {
  // só atende o próprio app: bloqueia sites de fora que tentem falar com este servidor
  if (!new RegExp('^(localhost|127\\.0\\.0\\.1):' + PORT + '$').test(req.headers.host || '')){ res.writeHead(403); return res.end(); }
  const origem = req.headers.origin;
  if (origem && !new RegExp('^http://(localhost|127\\.0\\.0\\.1):' + PORT + '$').test(origem)){ res.writeHead(403); return res.end(); }
  const u = new globalThis.URL(req.url, URL), p = u.pathname;
  if (p === '/__estudio'){ res.writeHead(200, { 'Content-Type': 'text/plain' }); return res.end('ok v' + VERSAO); }
  // versão nova do servidor pedindo a vez
  if (p === '/__encerrar' && req.method === 'POST'){ res.end('ok'); return setTimeout(() => process.exit(0), 100); }
  if (p.startsWith('/sistema/')){
    try { return rotaSistema(req, res, p, u.searchParams); }
    catch (e){ return json(res, 500, { erro: e.message }); }
  }
  if (p.startsWith('/google/')){
    try { return await rotaGoogle(req, res, p, u.searchParams); }
    catch (e){ return json(res, 500, { erro: 'Sem conexão com o Google: ' + e.message }); }
  }
  if (p !== '/' && p !== '/index.html'){ res.writeHead(404); return res.end(); }
  // lê o arquivo a cada acesso: editar o HTML e recarregar a página já basta
  const app = findApp();
  fs.readFile(app || CANDIDATOS[0], (err, data) => {
    if (err){
      res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end(`Não encontrei o app (${APP_NAME}). Procurei em:\n` + CANDIDATOS.join('\n') + '\n\nColoque o arquivo na pasta _sistema e recarregue (Ctrl + R).');
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(data);
  });
});

let tentativas = 0;
server.on('error', e => {
  if (e.code !== 'EADDRINUSE') process.exit(1);
  // já há um servidor rodando: se for desta versão, só abre a janela; se for antigo, pede para ele sair e assume
  http.get(URL + '__estudio', r => {
    let t = ''; r.on('data', c => t += c);
    r.on('end', () => {
      if (t.trim() === 'ok v' + VERSAO || ++tentativas > 3){ openBrowser(); return setTimeout(() => process.exit(0), 500); }
      const pedido = http.request(URL + '__encerrar', { method: 'POST' }, rr => rr.resume());
      pedido.on('error', () => {}); pedido.end();
      setTimeout(() => server.listen(PORT, '127.0.0.1', openBrowser), 800);
    });
  }).on('error', () => process.exit(1));
});

server.listen(PORT, '127.0.0.1', openBrowser);
