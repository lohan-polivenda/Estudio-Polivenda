// Geração de packshots pela API de edição de imagem da OpenAI (POST /v1/images/edits).
// A chave fica só no segredo OPENAI_API_KEY da Cloudflare: nunca vai para o navegador nem para o registro.
// Cada pedido guarda uma cópia PRIVADA das referências e da imagem gerada em _sistema/packshots/<id>/ e o
// registro completo em _sistema/packshots/<id>.json (prompt, anexos, parâmetros, tamanho real, uso, custo, conferência).
// A imagem gerada também ganha um link público temporário (_ponte/), igual às fotos enviadas, para levar ao chat.
// Rotas: GET estado · POST criar (resposta em linhas JSON, com sinal de vida enquanto a OpenAI trabalha)
//        POST conferencia?id= · POST externa?alvo=&nome= (imagem feita fora do Estúdio) · GET registro?id= · GET lista
//        POST referencias?id= (fotos reais para comparar, nas imagens feitas fora) · POST produto?id= (liga ao SKU)
//        POST decidir?id= (aprovar / reprovar com motivo; liberado a todos que entraram) · POST colocado?id= (foi para o checklist)
import { usuarioDaSessao } from '../../_middleware.js';
import { novoId, lerImagem, ID, EXT } from '../../_lib/imagem.js';

const PASTA = '_sistema/packshots/';
const PONTE = '_ponte/';
const MODELOS = ['gpt-image-2.6-sunburst', 'gpt-image-2.6-flare'];
const QUALIDADES = ['high', 'xhigh', 'max'];
const COMPLEXIDADES = ['low', 'medium', 'high'];
const MAX_REFS = 8, MAX_PROMPT = 32000;
const LIMITE_DIA_PADRAO = 30;          // gerações por dia (equipe toda); muda com a variável PACKSHOT_LIMITE_DIA
const HORAS_LINK = 24;
const JPEG_QUALIDADE = 95;
// preço por 1M de tokens (página de preços da OpenAI, lida em 17/11/2026) — só para estimar; o uso real fica guardado
const PRECO = { texto: 5, imagemEntrada: 8, imagemSaida: 30 };
const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' } });
const erro = (mensagem, status = 400) => json({ erro: mensagem }, status);

// tamanho aceito pela documentação: LxA múltiplos de 16, proporção entre 1:3 e 3:1, lado até 3840, 655.360 a 8.294.400 pixels
function tamanhoOk(s){
  const m = /^(\d{3,4})x(\d{3,4})$/.exec(s || ''); if (!m) return null;
  const w = +m[1], h = +m[2], px = w * h;
  if (w % 16 || h % 16 || Math.max(w, h) > 3840 || px < 655360 || px > 8294400 || w / h > 3 || h / w > 3) return null;
  return { w, h };
}
function custo(u){
  if (!u) return null;
  const d = u.input_tokens_details || {}, img = d.image_tokens ?? 0, txt = d.text_tokens ?? Math.max(0, (u.input_tokens || 0) - img);
  return +((txt * PRECO.texto + img * PRECO.imagemEntrada + (u.output_tokens || 0) * PRECO.imagemSaida) / 1e6).toFixed(4);
}
const b64Bytes = b64 => { const s = atob(b64), u = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) u[i] = s.charCodeAt(i); return u; };
const hoje = () => new Date().toISOString().slice(0, 10);
// resumo guardado junto do registro (metadados do R2): a lista do histórico sai sem abrir cada arquivo
const corta = (v, n = 80) => String(v ?? '').replace(/[^\p{L}\p{N} .,_()\/#-]/gu, '').slice(0, n);
function resumo(r){
  return { origem: r.origem || '', criado: String(r.criado || 0), por: corta(r.por, 40), alvo: r.alvo || '',
    status: r.erro ? 'erro' : !r.recebido ? 'gerando' : (r.decisao?.status || 'pendente'), conf: r.conferencia?.status || '',
    sku: corta(r.produto?.sku, 40), produto: corta(r.produto?.nome, 80), pid: corta(r.produto?.id, 40),
    arquivo: r.recebido?.arquivo || '', ref: r.referencias?.[0]?.arquivo || '', noProduto: r.noProduto ? '1' : '' };
}
// metadados do R2 só em ASCII (nome do produto pode ter acento): o resumo vai como JSON codificado, num campo só
async function gravarRegistro(b, r){ await b.put(PASTA + r.id + '.json', JSON.stringify(r, null, 2), { httpMetadata: { contentType: 'application/json; charset=utf-8' }, customMetadata: { v: '2', j: encodeURIComponent(JSON.stringify(resumo(r))) } }); }
const lerResumo = c => { try { return c?.v === '2' ? JSON.parse(decodeURIComponent(c.j)) : null; } catch { return null; } };
async function lerRegistro(b, id){ if (!ID.test(id)) return null; const o = await b.get(PASTA + id + '.json'); return o ? o.json() : null; }
// produto do cadastro do app (id interno, SKU, nome e variação); null tira a ligação
function lerProduto(o){
  if (!o || typeof o !== 'object') return null;
  const p = { id: corta(o.id, 40), sku: corta(o.sku, 40), nome: corta(o.nome, 80), variacao: corta(o.variacao, 60) };
  return p.id || p.sku ? p : null;
}
const MOTIVOS = ['cor', 'forma', 'quantidade', 'material', 'inventou', 'cortou', 'fundo', 'luz', 'tamanho', 'outro'];
async function corpoJson(request){ const t = await request.text(); if (t.length > 20000) return null; try { return JSON.parse(t); } catch { return null; } }

export async function onRequest(ctx){
  try { return await rotas(ctx); }
  catch (e) { return erro('Erro na geração: ' + (e?.message || e), 500); }
}
async function rotas(ctx){
  const { request, env, params } = ctx, b = env.ARQUIVOS;
  const rota = [].concat(params.rota || []).join('/'), q = new URL(request.url).searchParams, m = request.method;
  const eu = env.OLIST ? await usuarioDaSessao(request, env) : null;
  if (!eu) return erro('Entre no Estúdio de novo.', 401);
  if (!b) return erro('Falta ligar o armazenamento R2 "ARQUIVOS" na Cloudflare.', 503);
  const limiteDia = Math.max(0, +env.PACKSHOT_LIMITE_DIA || LIMITE_DIA_PADRAO), chaveDia = 'packshot:dia:' + hoje();

  if (rota === 'estado' && m === 'GET'){
    const feitas = +(await env.OLIST.get(chaveDia) || 0);
    return json({ chave: !!env.OPENAI_API_KEY, modelos: MODELOS, qualidades: QUALIDADES, maxRefs: MAX_REFS, limiteDia, feitasHoje: feitas });
  }
  // histórico: um resumo por pedido (registro antigo, sem resumo, é aberto uma vez e ganha o resumo)
  if (rota === 'lista' && m === 'GET'){
    const itens = []; let cursor;
    do {
      const l = await b.list({ prefix: PASTA, delimiter: '/', cursor, limit: 1000, include: ['customMetadata'] });
      for (const o of l.objects){
        if (!o.key.endsWith('.json')) continue;
        const id = o.key.slice(PASTA.length, -5);
        let c = lerResumo(o.customMetadata);
        if (!c){ const r = await lerRegistro(b, id); if (!r) continue; await gravarRegistro(b, r); c = resumo(r); }
        itens.push({ id, ...c, criado: +c.criado || o.uploaded.getTime(), noProduto: c.noProduto === '1' });
      }
      cursor = l.truncated ? l.cursor : null;
    } while (cursor);
    return json({ itens: itens.sort((a, z) => z.criado - a.criado) });
  }
  if (rota === 'registro' && m === 'GET'){
    const id = q.get('id') || '';
    if (!ID.test(id)) return erro('Id inválido.');
    const r = await lerRegistro(b, id);
    return r ? json(r) : erro('Não existe.', 404);
  }
  // arquivo privado do registro (referência ou imagem gerada): só para quem entrou no Estúdio
  if (rota === 'arquivo' && m === 'GET'){
    const id = q.get('id') || '', nome = q.get('nome') || '';
    if (!ID.test(id) || !/^(ref-\d{1,2}|gerada)\.(jpg|png|webp)$/.test(nome)) return erro('Caminho inválido.');
    const o = await b.get(PASTA + id + '/' + nome);
    if (!o) return erro('Não existe.', 404);
    return new Response(o.body, { headers: { 'Content-Type': o.httpMetadata?.contentType || 'application/octet-stream', 'Cache-Control': 'private, max-age=3600', 'X-Content-Type-Options': 'nosniff' } });
  }
  // resultado da conferência automática (feita no navegador): só informa, não aprova nada
  if (rota === 'conferencia' && m === 'POST'){
    const id = q.get('id') || '';
    if (!ID.test(id)) return erro('Id inválido.');
    const r = await lerRegistro(b, id); if (!r) return erro('Não existe.', 404);
    let c; try { c = await request.json(); } catch { return erro('Conferência inválida.'); }
    if (!c || typeof c !== 'object' || JSON.stringify(c).length > 20000) return erro('Conferência inválida.');
    r.conferencia = { ...c, em: Date.now(), por: eu.usuario };
    await gravarRegistro(b, r);
    return json({ ok: true });
  }
  // imagem feita fora do Estúdio (ex.: a que veio do chat): guarda os bytes como vieram e abre um registro para conferir
  if (rota === 'externa' && m === 'POST'){
    const corpo = new Uint8Array(await request.arrayBuffer());
    if (!corpo.length || corpo.length > 30 * 1024 * 1024) return erro('Arquivo vazio ou maior que 30 MB.', 413);
    const img = lerImagem(corpo);
    if (!img) return erro('Formato não aceito: JPG, PNG ou WebP.', 415);
    const id = novoId(), nome = 'gerada.' + EXT[img.tipo];
    await b.put(PASTA + id + '/' + nome, corpo, { httpMetadata: { contentType: img.tipo } });
    const r = { id, versao: 1, origem: 'externa', criado: Date.now(), por: eu.usuario,
      nomeOriginal: String(q.get('nome') || '').slice(0, 120), alvo: q.get('alvo') === 'FFFFFF' ? 'FFFFFF' : 'F4F4F4',
      recebido: { arquivo: nome, tipo: img.tipo, w: img.w, h: img.h, bytes: corpo.length }, referencias: [], conferencia: null, decisao: null,
      produto: lerProduto({ id: q.get('pid'), sku: q.get('sku'), nome: q.get('pnome'), variacao: q.get('var') }) };
    await gravarRegistro(b, r);
    return json(r);
  }
  // fotos reais para comparar na revisão (imagem feita fora): copiadas da ponte para o registro, como na geração
  if (rota === 'referencias' && m === 'POST'){
    const r = await lerRegistro(b, q.get('id') || ''); if (!r) return erro('Não existe.', 404);
    const c = await corpoJson(request), refs = Array.isArray(c?.refs) ? c.refs.slice(0, MAX_REFS) : null;
    if (!refs) return erro('Pedido inválido.');
    const lista = [];
    for (let i = 0; i < refs.length; i++){
      const id = String(refs[i]?.id || '');
      if (!ID.test(id)) return erro(`Referência ${i + 1} inválida.`);
      const o = await b.get(PONTE + id);
      if (!o || !(+o.customMetadata?.expira > Date.now())) return erro(`A foto da Imagem ${i + 1} venceu ou foi apagada.`, 410);
      const bytes = new Uint8Array(await o.arrayBuffer()), img = lerImagem(bytes);
      if (!img) return erro(`A foto da Imagem ${i + 1} não é JPG, PNG ou WebP.`, 415);
      const arquivo = `ref-${i + 1}.${EXT[img.tipo]}`;
      await b.put(PASTA + r.id + '/' + arquivo, bytes, { httpMetadata: { contentType: img.tipo } });
      lista.push({ ordem: i + 1, papel: String(refs[i]?.papel || '').slice(0, 40), idLink: id, arquivo, tipo: img.tipo, w: img.w, h: img.h, bytes: bytes.length });
    }
    r.referencias = lista;
    await gravarRegistro(b, r);
    return json(r);
  }
  // liga (ou desliga, com produto null) o pedido a um produto do cadastro, pelo SKU
  if (rota === 'produto' && m === 'POST'){
    const r = await lerRegistro(b, q.get('id') || ''); if (!r) return erro('Não existe.', 404);
    const c = await corpoJson(request); if (!c || typeof c !== 'object') return erro('Pedido inválido.');
    r.produto = lerProduto(c.produto);
    await gravarRegistro(b, r);
    return json(r);
  }
  // decisão da revisão: aprovado, reprovado (com pelo menos um motivo) ou de volta a pendente. Toda decisão fica guardada.
  if (rota === 'decidir' && m === 'POST'){
    const r = await lerRegistro(b, q.get('id') || ''); if (!r) return erro('Não existe.', 404);
    if (!r.recebido) return erro('Este pedido não tem imagem para revisar.', 409);
    const c = await corpoJson(request); if (!c) return erro('Pedido inválido.');
    const status = ['aprovado', 'reprovado', 'pendente'].includes(c.status) ? c.status : null;
    if (!status) return erro('Decisão inválida.');
    const motivos = [...new Set((Array.isArray(c.motivos) ? c.motivos : []).filter(x => MOTIVOS.includes(x)))];
    const detalhe = String(c.detalhe || '').trim().slice(0, 500);
    if (status === 'reprovado' && !motivos.length) return erro('Escolha pelo menos um motivo para reprovar.');
    if (status === 'reprovado' && motivos.includes('outro') && !detalhe) return erro('Escreva qual é o outro motivo.');
    const d = { status, motivos: status === 'reprovado' ? motivos : [], detalhe: status === 'reprovado' ? detalhe : '', por: eu.usuario, em: Date.now() };
    r.decisoes = [...(r.decisoes || []), d];
    r.decisao = status === 'pendente' ? null : d;
    await gravarRegistro(b, r);
    return json(r);
  }
  // a imagem aprovada entrou no checklist do produto (o app grava o arquivo; aqui fica onde ela foi parar)
  if (rota === 'colocado' && m === 'POST'){
    const r = await lerRegistro(b, q.get('id') || ''); if (!r) return erro('Não existe.', 404);
    if (r.decisao?.status !== 'aprovado') return erro('Só imagem aprovada vai para o produto.', 409);
    const c = await corpoJson(request), p = lerProduto(c?.produto);
    if (!p) return erro('Falta o produto.');
    r.produto = p;
    r.noProduto = { item: corta(c.item, 80), arquivo: corta(c.arquivo, 160), medida: corta(c.medida, 80), variacao: p.variacao, por: eu.usuario, em: Date.now() };
    await gravarRegistro(b, r);
    return json(r);
  }
  if (rota === 'criar' && m === 'POST') return criar(ctx, eu, limiteDia, chaveDia);
  return erro('Rota desconhecida.', 404);
}

async function criar({ request, env, waitUntil }, eu, limiteDia, chaveDia){
  const b = env.ARQUIVOS;
  if (!env.OPENAI_API_KEY) return erro('Falta a chave da OpenAI: cadastre o segredo OPENAI_API_KEY no projeto do Cloudflare Pages.', 503);
  let p; try { p = await request.json(); } catch { return erro('Pedido inválido.'); }
  const prompt = String(p.prompt || '').trim();
  if (!prompt) return erro('Falta o prompt.');
  if (prompt.length > MAX_PROMPT) return erro(`O prompt passa de ${MAX_PROMPT} caracteres.`);
  const refs = Array.isArray(p.refs) ? p.refs : [];
  if (!refs.length) return erro('Escolha pelo menos uma foto de referência.');
  if (refs.length > MAX_REFS) return erro(`No máximo ${MAX_REFS} referências por pedido.`);
  const modelo = MODELOS.includes(p.modelo) ? p.modelo : MODELOS[0];
  const qualidade = QUALIDADES.includes(p.qualidade) ? p.qualidade : 'high';
  const complexidade = COMPLEXIDADES.includes(p.complexidade) ? p.complexidade : 'high';
  const tam = tamanhoOk(p.tamanho || '1664x1968'); // mesma proporção da medida padrão 1300×1540
  if (!tam) return erro('Tamanho fora das regras da OpenAI (múltiplos de 16, lado até 3840, proporção até 3:1).');
  const alvo = p.alvo === 'FFFFFF' ? 'FFFFFF' : 'F4F4F4';
  const feitas = +(await env.OLIST.get(chaveDia) || 0);
  if (feitas >= limiteDia) return erro(`Limite de ${limiteDia} gerações por dia atingido.`, 429);

  // referências: precisam existir e estar dentro da validade; vão na ordem pedida (Imagem 1, Imagem 2…)
  const anexos = [];
  for (let i = 0; i < refs.length; i++){
    const id = String(refs[i]?.id || ''), papel = String(refs[i]?.papel || '').slice(0, 40);
    if (!ID.test(id)) return erro(`Referência ${i + 1} inválida.`);
    const o = await b.get(PONTE + id);
    if (!o || !(+o.customMetadata?.expira > Date.now())) return erro(`A foto da Imagem ${i + 1} venceu ou foi apagada. Envie de novo.`, 410);
    const bytes = new Uint8Array(await o.arrayBuffer()), img = lerImagem(bytes);
    if (!img) return erro(`A foto da Imagem ${i + 1} não é JPG, PNG ou WebP.`, 415);
    anexos.push({ ordem: i + 1, papel, id, bytes, img });
  }
  await env.OLIST.put(chaveDia, String(feitas + 1), { expirationTtl: 3 * 86400 });

  const gid = novoId(), inicio = Date.now();
  const parametros = { model: modelo, size: `${tam.w}x${tam.h}`, quality: qualidade, complexity: complexidade, output_format: 'jpeg', output_compression: JPEG_QUALIDADE, background: 'opaque', n: 1 };
  const registro = { id: gid, versao: 1, origem: 'openai', criado: inicio, por: eu.usuario, alvo, prompt, parametros,
    referencias: anexos.map(a => ({ ordem: a.ordem, papel: a.papel, idLink: a.id, arquivo: `ref-${a.ordem}.${EXT[a.img.tipo]}`, tipo: a.img.tipo, w: a.img.w, h: a.img.h, bytes: a.bytes.length })),
    pedido: { w: tam.w, h: tam.h }, recebido: null, uso: null, custoEstimadoUSD: null, conferencia: null, decisao: null, erro: null,
    produto: lerProduto(p.produto) };
  for (const a of anexos) await b.put(PASTA + gid + '/' + `ref-${a.ordem}.${EXT[a.img.tipo]}`, a.bytes, { httpMetadata: { contentType: a.img.tipo } });
  await gravarRegistro(b, registro);

  // a OpenAI pode levar até ~2 minutos: a resposta sai na hora e manda um sinal de vida a cada 10 s
  const { readable, writable } = new TransformStream(), w = writable.getWriter(), enc = new TextEncoder();
  const linha = o => w.write(enc.encode(JSON.stringify(o) + '\n')).catch(() => {});
  linha({ etapa: 'gerando', id: gid });
  const vida = setInterval(() => linha({ etapa: 'gerando', s: Math.round((Date.now() - inicio) / 1000) }), 10000);

  const trabalho = (async () => {
    try {
      const f = new FormData();
      for (const [k, v] of Object.entries(parametros)) f.append(k, String(v));
      f.append('prompt', prompt);
      for (const a of anexos) f.append('image[]', new Blob([a.bytes], { type: a.img.tipo }), `imagem-${a.ordem}.${EXT[a.img.tipo]}`);
      const r = await fetch((env.OPENAI_BASE || 'https://api.openai.com/v1') + '/images/edits', { method: 'POST', headers: { Authorization: 'Bearer ' + env.OPENAI_API_KEY }, body: f });
      const d = await r.json().catch(() => ({}));
      registro.openai = { status: r.status, requestId: r.headers.get('x-request-id') || null, ms: Date.now() - inicio };
      if (!r.ok || !d.data?.[0]?.b64_json) throw new Error(d.error?.message || `A OpenAI respondeu ${r.status}.`);
      const bytes = b64Bytes(d.data[0].b64_json), img = lerImagem(bytes);
      if (!img) throw new Error('A OpenAI devolveu um arquivo que não é imagem.');
      const nome = 'gerada.' + EXT[img.tipo], idLink = novoId();
      await b.put(PASTA + gid + '/' + nome, bytes, { httpMetadata: { contentType: img.tipo } });
      await b.put(PONTE + idLink, bytes, { httpMetadata: { contentType: img.tipo },
        customMetadata: { expira: String(Date.now() + HORAS_LINK * 3600e3), criado: String(Date.now()), por: eu.usuario, nome: `gerada-${gid.slice(0, 6)}.${EXT[img.tipo]}`, w: String(img.w), h: String(img.h) } });
      registro.recebido = { arquivo: nome, tipo: img.tipo, w: img.w, h: img.h, bytes: bytes.length, idLink, tamanhoIgualAoPedido: img.w === tam.w && img.h === tam.h };
      registro.uso = d.usage || null;
      registro.custoEstimadoUSD = custo(d.usage);
      registro.revisedPrompt = d.data[0].revised_prompt || null;
      await gravarRegistro(b, registro);
      await linha({ etapa: 'pronto', registro });
    } catch (e) {
      registro.erro = String(e?.message || e).slice(0, 500);
      await gravarRegistro(b, registro).catch(() => {});
      await linha({ etapa: 'erro', erro: registro.erro, id: gid });
    } finally {
      clearInterval(vida);
      await w.close().catch(() => {});
    }
  })();
  waitUntil(trabalho);
  return new Response(readable, { headers: { 'Content-Type': 'application/x-ndjson; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });
}
