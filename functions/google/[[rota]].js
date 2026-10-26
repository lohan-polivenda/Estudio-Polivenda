// Login do Google Drive guardado na Cloudflare, para o site não pedir login a cada hora.
// Mesmo combinado do atalho local (servidor.js): status · token · troca · sair.
// Fica no KV "OLIST", chave "google" = { clientId, clientSecret, refresh_token } — vale para toda a equipe.
// A chave secreta vem do app na primeira vez (ou do segredo GOOGLE_CLIENT_SECRET, se existir na Cloudflare).
// Só quem entrou no Estúdio chega aqui (functions/_middleware.js).
import { usuarioDaSessao } from '../_middleware.js';

const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' } });
async function googleToken(params){
  const r = await fetch('https://oauth2.googleapis.com/token', { method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(params) });
  return { ok: r.ok, j: await r.json().catch(() => ({})) };
}

export async function onRequest({ request, env, params }){
  if (!env.OLIST) return json({ erro: 'O login guardado precisa da ligação de KV "OLIST" na Cloudflare.' }, 503);
  if (!await usuarioDaSessao(request, env)) return json({ erro: 'Entre no Estúdio de novo.' }, 401);
  const rota = [].concat(params.rota || []).join('/'), q = new URL(request.url).searchParams;
  const a = (await env.OLIST.get('google', 'json')) || {}, gravar = x => env.OLIST.put('google', JSON.stringify(x));
  const segredoDe = id => (a.clientId === id && a.clientSecret) || env.GOOGLE_CLIENT_SECRET || '';

  // há login guardado para este Client ID?
  if (rota === 'status') return json({ conectado: !!a.refresh_token && a.clientId === q.get('client'), temSegredo: !!segredoDe(q.get('client')) });
  // novo acesso de 1 hora a partir do login guardado (sem janela do Google)
  if (rota === 'token'){
    if (!a.refresh_token || a.clientId !== q.get('client')) return json({ erro: 'sem-login' }, 401);
    const { ok, j } = await googleToken({ client_id: a.clientId, client_secret: segredoDe(a.clientId), refresh_token: a.refresh_token, grant_type: 'refresh_token' });
    if (!ok){
      if (j.error === 'invalid_grant'){ delete a.refresh_token; await gravar(a); }
      return json({ erro: j.error_description || j.error || 'expirou' }, 401);
    }
    return json({ access_token: j.access_token, expires_in: j.expires_in });
  }
  if (request.method !== 'POST') return json({ erro: 'método' }, 405);
  let b = {}; try { b = await request.json(); } catch {}
  // primeiro login: troca o código da janela do Google pela autorização permanente
  if (rota === 'troca'){
    const segredo = b.clientSecret || segredoDe(b.clientId);
    if (!b.code || !b.clientId) return json({ erro: 'Pedido incompleto.' }, 400);
    if (!segredo) return json({ erro: 'Falta a chave secreta do cliente (Client secret) em Configurações → Conexões → Google Drive.' }, 400);
    const { ok, j } = await googleToken({ code: b.code, client_id: b.clientId, client_secret: segredo, redirect_uri: 'postmessage', grant_type: 'authorization_code' });
    if (!ok) return json({ erro: j.error === 'invalid_client' ? 'Chave secreta do cliente incorreta. Confira em Configurações → Conexões → Google Drive.' : (j.error_description || j.error || 'O Google recusou o login.') }, 400);
    const refresh = j.refresh_token || (a.clientId === b.clientId ? a.refresh_token : undefined);
    await gravar({ clientId: b.clientId, clientSecret: b.clientSecret || (a.clientId === b.clientId ? a.clientSecret : undefined), refresh_token: refresh });
    return json({ access_token: j.access_token, expires_in: j.expires_in, guardado: !!refresh });
  }
  // sair: revoga no Google e apaga daqui (a chave secreta fica, para entrar de novo sem colar)
  if (rota === 'sair'){
    if (a.refresh_token) await fetch('https://oauth2.googleapis.com/revoke?token=' + encodeURIComponent(a.refresh_token), { method: 'POST' }).catch(() => {});
    delete a.refresh_token; await gravar(a);
    return json({ ok: true });
  }
  return json({ erro: 'rota' }, 404);
}
