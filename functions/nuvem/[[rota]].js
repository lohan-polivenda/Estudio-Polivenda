// Pasta de trabalho na nuvem: as pastas "Estudio Polivenda" (fotos) e "_sistema" (cadastro, demandas, registro…)
// guardadas no Cloudflare R2 (ligação "ARQUIVOS"). O app usa como se fosse uma pasta do computador.
// Pasta = prefixo do caminho; pasta vazia = objeto marcador terminado em "/".
// Só quem entrou no Estúdio chega aqui (functions/_middleware.js).
// Rotas: GET estado · GET lista?c= · GET arvore?c= · GET arquivo?c= · PUT arquivo?c= · POST pasta?c= · POST apagar?c= · POST mover?de=&para=
import { usuarioDaSessao } from '../_middleware.js';

const RAIZES = ['Estudio Polivenda', '_sistema'];
const PROTEGIDOS = /^_sistema\/dados\/(organizador|planejamento)\.json$/;
const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' } });
const erro = (mensagem, status = 400) => json({ erro: mensagem }, status);
// caminho seguro: dentro de uma das raízes, sem "..", sem barras sobrando
function caminhoOk(c, vazioOk = false){
  if (c === '' && vazioOk) return true;
  const ps = String(c).split('/');
  return RAIZES.includes(ps[0]) && ps.every(p => p && p !== '.' && p !== '..' && !/[\\\0]/.test(p) && p.length <= 200);
}
// todos os objetos com o prefixo (pasta inteira, com subpastas)
async function tudoCom(b, prefixo){
  const out = []; let cursor;
  do { const l = await b.list({ prefix: prefixo, cursor, limit: 1000 }); out.push(...l.objects.map(o => o.key)); cursor = l.truncated ? l.cursor : null; } while (cursor);
  return out;
}
async function apagarVarios(b, chaves){ for (let i = 0; i < chaves.length; i += 1000) await b.delete(chaves.slice(i, i + 1000)); }
async function copiar(b, de, para){
  const o = await b.get(de); if (!o) return false;
  await b.put(para, o.body, { httpMetadata: o.httpMetadata, customMetadata: o.customMetadata });
  return true;
}

export async function onRequest({ request, env, params }){
  const b = env.ARQUIVOS;
  const rota = [].concat(params.rota || []).join('/'), q = new URL(request.url).searchParams, m = request.method, c = q.get('c') ?? '';
  if (!env.OLIST || !await usuarioDaSessao(request, env)) return erro('Entre no Estúdio de novo.', 401);
  if (rota === 'estado') return b ? json({ ok: true }) : erro('Falta ligar o armazenamento R2 "ARQUIVOS" na Cloudflare.', 503);
  if (!b) return erro('Falta ligar o armazenamento R2 "ARQUIVOS" na Cloudflare.', 503);

  if (rota === 'lista' && m === 'GET'){
    if (!caminhoOk(c, true)) return erro('Caminho inválido.');
    const prefixo = c ? c + '/' : '', pastas = new Set(), arquivos = []; let cursor, algo = !c;
    do {
      const l = await b.list({ prefix: prefixo, delimiter: '/', cursor, limit: 1000 });
      for (const p of l.delimitedPrefixes) pastas.add(p.slice(prefixo.length, -1));
      for (const o of l.objects){
        algo = true;
        if (o.key === prefixo) continue; // marcador da própria pasta
        arquivos.push({ nome: o.key.slice(prefixo.length), tamanho: o.size, mod: o.uploaded.getTime(), etag: o.httpEtag });
      }
      if (l.delimitedPrefixes.length) algo = true;
      cursor = l.truncated ? l.cursor : null;
    } while (cursor);
    if (!c) RAIZES.forEach(r => pastas.add(r));
    return json({ existe: algo, pastas: [...pastas], arquivos });
  }
  // a pasta inteira, com subpastas, num pedido só (o app monta todas as listagens de uma vez)
  if (rota === 'arvore' && m === 'GET'){
    if (!caminhoOk(c)) return erro('Caminho inválido.');
    const itens = []; let cursor;
    do {
      const l = await b.list({ prefix: c + '/', cursor, limit: 1000 });
      for (const o of l.objects) itens.push({ k: o.key.slice(c.length + 1), tamanho: o.size, mod: o.uploaded.getTime(), etag: o.httpEtag });
      cursor = l.truncated ? l.cursor : null;
    } while (cursor);
    return json({ itens });
  }
  if (rota === 'arquivo' && m === 'GET'){
    if (!caminhoOk(c)) return erro('Caminho inválido.');
    const se = request.headers.get('If-None-Match');
    const o = await b.get(c, se ? { onlyIf: { etagDoesNotMatch: se } } : {});
    if (!o) return erro('Não existe.', 404);
    const h = { ETag: o.httpEtag, 'X-Mod': String(o.uploaded.getTime()), 'Cache-Control': 'no-store', 'Content-Type': o.httpMetadata?.contentType || 'application/octet-stream' };
    return 'body' in o ? new Response(o.body, { headers: h }) : new Response(null, { status: 304, headers: h });
  }
  if (rota === 'arquivo' && m === 'PUT'){
    if (!caminhoOk(c)) return erro('Caminho inválido.');
    // cadastro e demandas da equipe: só grava quem leu a versão mais nova (If-Match = etiqueta lida;
    // "novo" = o arquivo não existia; "*" = de propósito por cima). Sem isso, uma janela antiga apagava o trabalho dos outros.
    const se = request.headers.get('If-Match');
    if (PROTEGIDOS.test(c) && !se) return erro('Esta janela do Estúdio está desatualizada. Aperte F5 para carregar a versão nova (nada foi gravado).', 428);
    let onlyIf;
    if (se && se !== '*'){
      const atual = await b.head(c);
      if (se === 'novo' ? !!atual : atual?.httpEtag !== se) return erro('Outra pessoa salvou antes.', 412);
      // a conferência e a gravação num passo só no R2: duas pessoas salvando no mesmo instante não passam uma por cima da outra
      if (atual) onlyIf = { etagMatches: atual.etag };
    }
    const o = await b.put(c, request.body, { httpMetadata: { contentType: request.headers.get('Content-Type') || 'application/octet-stream' }, ...(onlyIf ? { onlyIf } : {}) });
    if (!o) return erro('Outra pessoa salvou antes.', 412);
    return json({ tamanho: o.size, mod: o.uploaded.getTime(), etag: o.httpEtag });
  }
  if (m !== 'POST') return erro('Rota desconhecida.', 404);
  if (rota === 'pasta'){
    if (!caminhoOk(c)) return erro('Caminho inválido.');
    await b.put(c + '/', new Uint8Array(0));
    return json({ ok: true });
  }
  if (rota === 'apagar'){
    if (!caminhoOk(c) || RAIZES.includes(c)) return erro('Caminho inválido.');
    const pasta = await tudoCom(b, c + '/');
    if (pasta.length) await apagarVarios(b, pasta); else await b.delete(c);
    return json({ ok: true, apagados: pasta.length || 1 });
  }
  if (rota === 'mover'){
    const de = q.get('de') || '', para = q.get('para') || '';
    if (!caminhoOk(de) || !caminhoOk(para) || RAIZES.includes(de) || para.startsWith(de + '/')) return erro('Caminho inválido.');
    const pasta = await tudoCom(b, de + '/');
    if (pasta.length){
      if ((await b.list({ prefix: para + '/', limit: 1 })).objects.length) return erro('Já existe uma pasta com esse nome.', 409);
      for (const k of pasta) await copiar(b, k, para + k.slice(de.length));
      await apagarVarios(b, pasta);
      return json({ ok: true, movidos: pasta.length });
    }
    if (!await copiar(b, de, para)) return erro('Não existe.', 404);
    await b.delete(de);
    return json({ ok: true, movidos: 1 });
  }
  return erro('Rota desconhecida.', 404);
}
