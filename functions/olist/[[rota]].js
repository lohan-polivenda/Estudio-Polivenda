// Ponte entre o Estúdio (site na Cloudflare) e a API do Olist ERP.
// A chave secreta do Olist e o login ficam aqui, na Cloudflare; o navegador nunca vê.
// Configuração no painel da Cloudflare (Pages → projeto → Configurações):
//   variáveis OLIST_CLIENT_ID, OLIST_CLIENT_SECRET e ESTUDIO_CHAVE (a senha da equipe) e
//   a ligação de KV chamada OLIST (guarda o login).
// Rotas: POST /olist/entrar · GET /olist/retorno · GET /olist/status · POST /olist/api · POST /olist/sair
import { usuarioDaSessao } from '../_middleware.js';

const API = 'https://api.tiny.com.br/public-api/v3';
const CONTA = 'https://accounts.tiny.com.br/realms/tiny/protocol/openid-connect';
// o que o app pode pedir ao Olist: ler produtos e cuidar dos anexos (imagens) deles
const PERMITIDO = [
  ['GET', /^\/produtos\?[\w%.=&+-]*$/],
  ['GET', /^\/produtos\/\d+$/],
  ['GET', /^\/produtos\/\d+\/anexos$/],
  ['POST', /^\/produtos\/\d+\/anexos$/],
  ['DELETE', /^\/produtos\/\d+\/anexos$/],
];
const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' } });
const pagina = (titulo, texto, ok) => new Response(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${titulo}</title>
<body style="font-family:system-ui,sans-serif;display:grid;place-items:center;min-height:90vh;margin:0;background:#f4f5f7;color:#1d2330">
<div style="background:#fff;border:1px solid #e1e4ea;border-radius:12px;padding:24px 28px;max-width:420px;text-align:center"><h2 style="margin:0 0 8px">${titulo}</h2><p style="margin:0;color:#6b7385">${texto}</p></div>
<script>try{opener&&opener.postMessage({olist:${ok ? "'ok'" : "'erro'"}},location.origin)}catch(e){}${ok ? 'setTimeout(()=>close(),1500)' : ''}</script>`,
  { headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' } });

async function trocarToken(env, dados){
  const r = await fetch(CONTA + '/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: env.OLIST_CLIENT_ID, client_secret: env.OLIST_CLIENT_SECRET, ...dados }) });
  if (!r.ok) return null;
  const t = await r.json(), agora = Date.now();
  const salvo = { access: t.access_token, ate: agora + (t.expires_in || 300) * 1000, refresh: t.refresh_token, desde: agora };
  const ant = await env.OLIST.get('tokens', 'json');
  if (ant?.desde && dados.grant_type === 'refresh_token') salvo.desde = ant.desde;
  await env.OLIST.put('tokens', JSON.stringify(salvo));
  return salvo;
}
// token válido (renova sozinho pelo refresh token); null = precisa entrar de novo
async function token(env){
  const t = await env.OLIST.get('tokens', 'json');
  if (!t) return null;
  if (t.access && t.ate - 60000 > Date.now()) return t.access;
  const novo = t.refresh && await trocarToken(env, { grant_type: 'refresh_token', refresh_token: t.refresh });
  if (!novo){ await env.OLIST.delete('tokens'); return null; }
  return novo.access;
}

export async function onRequest({ request, env, params }){
  const rota = [].concat(params.rota || []).join('/'), url = new URL(request.url), metodo = request.method;
  const falta = ['OLIST_CLIENT_ID', 'OLIST_CLIENT_SECRET', 'ESTUDIO_CHAVE'].filter(k => !env[k]);
  if (!env.OLIST) falta.push('OLIST (ligação de KV)');
  const retorno = url.origin + '/olist/retorno';

  // volta do login no Olist (aberta numa janelinha)
  if (rota === 'retorno'){
    if (falta.length) return pagina('Olist não configurado', 'Falta configurar a ligação na Cloudflare.', false);
    const estado = url.searchParams.get('state'), code = url.searchParams.get('code');
    if (!estado || !code || !await env.OLIST.get('estado:' + estado)) return pagina('Não deu certo', 'O link de login venceu. Volte ao Estúdio e clique em Entrar no Olist de novo.', false);
    await env.OLIST.delete('estado:' + estado);
    const t = await trocarToken(env, { grant_type: 'authorization_code', code, redirect_uri: retorno });
    return t ? pagina('Olist conectado', 'Pode fechar esta janela e voltar ao Estúdio.', true)
      : pagina('Não deu certo', 'O Olist recusou o login. Confira o ID do cliente, a chave secreta e o endereço de retorno no aplicativo do Olist.', false);
  }

  // daqui para baixo, só quem entrou no Estúdio (ou com a senha da equipe)
  if (falta.length) return json({ erro: 'configuracao', falta }, 503);
  if (request.headers.get('X-Estudio-Chave') !== env.ESTUDIO_CHAVE && !await usuarioDaSessao(request, env))
    return json({ erro: 'chave', mensagem: 'Entre no Estúdio (ou confira a senha da equipe para o Olist).' }, 403);

  if (rota === 'status' && metodo === 'GET'){
    const t = await env.OLIST.get('tokens', 'json');
    return json({ conectado: !!t, desde: t?.desde || null, retorno });
  }
  if (rota === 'entrar' && metodo === 'POST'){
    const estado = crypto.randomUUID();
    await env.OLIST.put('estado:' + estado, '1', { expirationTtl: 900 });
    const q = new URLSearchParams({ client_id: env.OLIST_CLIENT_ID, redirect_uri: retorno, response_type: 'code', scope: 'openid', state: estado });
    return json({ url: CONTA + '/auth?' + q });
  }
  if (rota === 'sair' && metodo === 'POST'){ await env.OLIST.delete('tokens'); return json({ ok: true }); }
  if (rota === 'api' && metodo === 'POST'){
    let pedido;
    try { pedido = await request.json(); } catch { return json({ erro: 'pedido', mensagem: 'Pedido inválido.' }, 400); }
    const m = String(pedido.metodo || 'GET').toUpperCase(), caminho = String(pedido.caminho || '');
    if (!PERMITIDO.some(([pm, re]) => pm === m && re.test(caminho))) return json({ erro: 'proibido', mensagem: 'O Estúdio não tem permissão para esse pedido ao Olist.' }, 403);
    const tk = await token(env);
    if (!tk) return json({ erro: 'login', mensagem: 'Entre no Olist de novo (Configurações → Conexões → Olist ERP).' }, 401);
    const r = await fetch(API + caminho, { method: m, headers: { Authorization: 'Bearer ' + tk, Accept: 'application/json', ...(pedido.corpo !== undefined ? { 'Content-Type': 'application/json' } : {}) },
      body: pedido.corpo !== undefined ? JSON.stringify(pedido.corpo) : undefined });
    const texto = await r.text();
    let dados = null; try { dados = texto ? JSON.parse(texto) : null; } catch { dados = { mensagem: texto.slice(0, 300) }; }
    if (r.status === 401) await env.OLIST.delete('tokens');
    return r.ok ? json({ dados }) : json({ erro: r.status === 401 ? 'login' : 'olist', mensagem: dados?.mensagem || `O Olist respondeu ${r.status}.`, detalhes: dados?.detalhes || [] }, r.status);
  }
  return json({ erro: 'rota', mensagem: 'Rota desconhecida.' }, 404);
}
