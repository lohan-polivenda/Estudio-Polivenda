// Contas do Estúdio: usuário e senha de cada pessoa (todas podem fazer tudo).
// KV "OLIST": usuario:<login> = { nome, usuario, sal, hash, criado, por } · usuarios = [logins]
//             sessao:<token> = login (30 dias) · falhas:<login> = tentativas erradas (15 min)
// Rotas: POST entrar · POST primeiro · POST sair · GET eu · GET usuarios · POST usuarios · POST senha · POST remover
import { usuarioDaSessao } from '../_middleware.js';

const DIAS = 30, MAX_FALHAS = 8;
const json = (o, status = 200, extra = {}) => new Response(JSON.stringify(o), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...extra } });
const erro = (mensagem, status = 400) => json({ mensagem }, status);
const hex = b => [...new Uint8Array(b)].map(x => x.toString(16).padStart(2, '0')).join('');
async function hashSenha(senha, sal){
  const k = await crypto.subtle.importKey('raw', new TextEncoder().encode(senha), 'PBKDF2', false, ['deriveBits']);
  return hex(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: new TextEncoder().encode(sal), iterations: 100000 }, k, 256));
}
// compara sem revelar pelo tempo onde a diferença está
const iguais = (a, b) => { if (a.length !== b.length) return false; let d = 0; for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i); return d === 0; };
const loginOk = s => /^[a-z0-9._-]{3,30}$/.test(s);
function validar({ nome, usuario, senha }, comNome = true){
  if (comNome && !String(nome || '').trim()) return 'Falta o nome.';
  if (!loginOk(usuario)) return 'Usuário: de 3 a 30 letras minúsculas, números, ponto, hífen ou sublinhado (sem espaço nem acento).';
  if (String(senha || '').length < 6) return 'A senha precisa ter pelo menos 6 caracteres.';
  return '';
}
async function lista(env){ return (await env.OLIST.get('usuarios', 'json')) || []; }
async function gravarUsuario(env, { nome, usuario, senha }, por, existente){
  const sal = crypto.randomUUID();
  const u = { nome: String(nome).trim().slice(0, 60), usuario, sal, hash: await hashSenha(senha, sal), criado: existente?.criado || new Date().toISOString(), por: existente?.por || por };
  await env.OLIST.put('usuario:' + usuario, JSON.stringify(u));
  const l = await lista(env);
  if (!l.includes(usuario)){ l.push(usuario); await env.OLIST.put('usuarios', JSON.stringify(l)); }
  return u;
}
async function abrirSessao(env, usuario){
  const t = crypto.randomUUID().replace(/-/g, '') + crypto.randomUUID().replace(/-/g, '');
  await env.OLIST.put('sessao:' + t, usuario, { expirationTtl: DIAS * 86400 });
  return `estudio_sessao=${t}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${DIAS * 86400}`;
}

export async function onRequest({ request, env, params }){
  if (!env.OLIST) return erro('As contas precisam da ligação de KV "OLIST" na Cloudflare.', 503);
  const rota = [].concat(params.rota || []).join('/'), m = request.method;
  let corpo = {};
  if (m === 'POST'){ try { corpo = await request.json(); } catch {} }

  if (rota === 'entrar' && m === 'POST'){
    const usuario = String(corpo.usuario || '').trim().toLowerCase(), chaveF = 'falhas:' + usuario;
    if (!loginOk(usuario)) return erro('Usuário ou senha errados.', 401);
    const falhas = +(await env.OLIST.get(chaveF) || 0);
    if (falhas >= MAX_FALHAS) return erro('Muitas tentativas erradas. Espere 15 minutos e tente de novo.', 429);
    const u = await env.OLIST.get('usuario:' + usuario, 'json');
    if (!u || !iguais(await hashSenha(String(corpo.senha || ''), u.sal), u.hash)){
      await env.OLIST.put(chaveF, String(falhas + 1), { expirationTtl: 900 });
      return erro('Usuário ou senha errados.', 401);
    }
    await env.OLIST.delete(chaveF);
    return json({ nome: u.nome, usuario }, 200, { 'Set-Cookie': await abrirSessao(env, usuario) });
  }
  // com a senha da equipe (ESTUDIO_CHAVE): primeiro acesso, acesso novo ou senha nova para um usuário que já existe
  if (rota === 'primeiro' && m === 'POST'){
    const falhas = +(await env.OLIST.get('falhas:chave') || 0);
    if (falhas >= MAX_FALHAS) return erro('Muitas tentativas erradas. Espere 15 minutos e tente de novo.', 429);
    if (!env.ESTUDIO_CHAVE || !iguais(String(corpo.chave || ''), env.ESTUDIO_CHAVE)){
      await env.OLIST.put('falhas:chave', String(falhas + 1), { expirationTtl: 900 });
      return erro('Senha da equipe errada.', 403);
    }
    await env.OLIST.delete('falhas:chave');
    const usuario = String(corpo.usuario || '').trim().toLowerCase(), existe = await env.OLIST.get('usuario:' + usuario, 'json');
    const d = { nome: existe?.nome || corpo.nome, usuario, senha: corpo.senha }, v = validar(d);
    if (v) return erro(v);
    const u = await gravarUsuario(env, d, (await lista(env)).length ? 'senha da equipe' : 'primeiro acesso', existe);
    return json({ nome: u.nome, usuario: u.usuario, senhaNova: !!existe }, 200, { 'Set-Cookie': await abrirSessao(env, u.usuario) });
  }

  // daqui para baixo, só quem já entrou
  const eu = await usuarioDaSessao(request, env);
  if (!eu) return erro('Entre no Estúdio de novo.', 401);
  if (rota === 'eu' && m === 'GET') return json({ nome: eu.nome, usuario: eu.usuario });
  if (rota === 'sair' && m === 'POST'){
    await env.OLIST.delete('sessao:' + eu.sessao);
    return json({ ok: true }, 200, { 'Set-Cookie': 'estudio_sessao=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0' });
  }
  if (rota === 'usuarios' && m === 'GET'){
    const out = [];
    for (const l of await lista(env)){ const u = await env.OLIST.get('usuario:' + l, 'json'); if (u) out.push({ nome: u.nome, usuario: u.usuario, criado: u.criado, por: u.por }); }
    return json(out);
  }
  if (rota === 'usuarios' && m === 'POST'){
    const d = { nome: corpo.nome, usuario: String(corpo.usuario || '').trim().toLowerCase(), senha: corpo.senha }, v = validar(d);
    if (v) return erro(v);
    if (await env.OLIST.get('usuario:' + d.usuario)) return erro(`O usuário "${d.usuario}" já existe.`, 409);
    const u = await gravarUsuario(env, d, eu.nome);
    return json({ nome: u.nome, usuario: u.usuario });
  }
  if (rota === 'senha' && m === 'POST'){
    const usuario = String(corpo.usuario || '').trim().toLowerCase(), u = await env.OLIST.get('usuario:' + usuario, 'json');
    if (!u) return erro('Esse usuário não existe.', 404);
    const v = validar({ usuario, senha: corpo.senha }, false);
    if (v) return erro(v);
    await gravarUsuario(env, { nome: u.nome, usuario, senha: corpo.senha }, eu.nome, u);
    return json({ ok: true });
  }
  if (rota === 'remover' && m === 'POST'){
    const usuario = String(corpo.usuario || '').trim().toLowerCase(), l = await lista(env);
    if (usuario === eu.usuario) return erro('Você não pode remover o seu próprio acesso.');
    if (!l.includes(usuario)) return erro('Esse usuário não existe.', 404);
    await env.OLIST.delete('usuario:' + usuario);
    await env.OLIST.put('usuarios', JSON.stringify(l.filter(x => x !== usuario)));
    return json({ ok: true });
  }
  return erro('Rota desconhecida.', 404);
}
