// Ponte com o chat: guarda fotos no R2 privado ("ARQUIVOS", prefixo _ponte/) e devolve um link público temporário
// (functions/api/u/[id].js). O app converte a foto antes (JPG sRGB, lado maior 2048); aqui o arquivo é guardado
// como chegou, sem recompressão. Só quem entrou no Estúdio envia, lista e apaga.
// Rotas: POST enviar?horas=&nome=&prod= (corpo = a imagem) · GET lista · POST apagar?id= · POST produto?id= (corpo = {produto})
// Cada foto leva o produto (SKU) escolhido no app: a aba Packshots agrupa as fotos por produto.
import { usuarioDaSessao } from '../../_middleware.js';
import { novoId, lerImagem, ID } from '../../_lib/imagem.js';

const PREFIXO = '_ponte/';
const MAX_BYTES = 20 * 1024 * 1024;   // 20 MB por arquivo
const MAX_LADO = 4096;                // fotos do app têm até 2048; imagens geradas (fase 2) podem ser maiores
const HORAS_PADRAO = 24, HORAS_MAX = 168;
const POR_HORA = 200;                 // envios por pessoa por hora
const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' } });
const erro = (mensagem, status = 400) => json({ erro: mensagem }, status);

// produto da foto: { id, sku, nome, variacao }. Metadado do R2 só aceita ASCII: vai como JSON codificado
const corta = (v, n = 80) => String(v ?? '').replace(/[^\p{L}\p{N} .,_()\/#-]/gu, '').slice(0, n);
function lerProduto(o){
  if (!o || typeof o !== 'object') return null;
  const p = { id: corta(o.id, 40), sku: corta(o.sku, 40), nome: corta(o.nome, 80), variacao: corta(o.variacao, 60) };
  return p.id || p.sku ? p : null;
}
const produtoDoTexto = t => { try { return lerProduto(JSON.parse(t)); } catch { return null; } };
const produtoDoMeta = c => { try { return c?.prod ? lerProduto(JSON.parse(decodeURIComponent(c.prod))) : null; } catch { return null; } };
const metaProduto = p => p ? { prod: encodeURIComponent(JSON.stringify(p)) } : {};

const horaAtual = () => new Date().toISOString().slice(0, 13).replace(/\D/g, '');

export async function onRequest(ctx){
  try { return await rotas(ctx); }
  catch (e) { return erro('Erro na ponte: ' + (e?.message || e), 500); }
}
async function rotas({ request, env, params }){
  const b = env.ARQUIVOS;
  const rota = [].concat(params.rota || []).join('/'), q = new URL(request.url).searchParams, m = request.method;
  const eu = env.OLIST ? await usuarioDaSessao(request, env) : null;
  if (!eu) return erro('Entre no Estúdio de novo.', 401);
  if (!b) return erro('Falta ligar o armazenamento R2 "ARQUIVOS" na Cloudflare.', 503);

  if (rota === 'enviar' && m === 'POST'){
    const tam = +request.headers.get('Content-Length') || 0;
    if (tam > MAX_BYTES) return erro('Arquivo grande demais (máximo 20 MB).', 413);
    const chaveTaxa = `ponte:n:${eu.usuario}:${horaAtual()}`, feitos = +(await env.OLIST.get(chaveTaxa) || 0);
    if (feitos >= POR_HORA) return erro(`Limite de ${POR_HORA} envios por hora. Espere um pouco.`, 429);
    const corpo = new Uint8Array(await request.arrayBuffer());
    if (!corpo.length) return erro('Arquivo vazio.');
    if (corpo.length > MAX_BYTES) return erro('Arquivo grande demais (máximo 20 MB).', 413);
    const img = lerImagem(corpo);
    if (!img) return erro('Formato não aceito: envie JPG, PNG ou WebP (o HEIC é convertido no navegador).', 415);
    if (!img.w || !img.h || Math.max(img.w, img.h) > MAX_LADO) return erro(`Tamanho inválido (${img.w}×${img.h}); o lado maior pode ter até ${MAX_LADO}.`, 422);
    const horas = Math.min(HORAS_MAX, Math.max(1, Math.round(+q.get('horas') || HORAS_PADRAO)));
    const id = novoId(), agora = Date.now(), expira = agora + horas * 3600e3;
    const nome = String(q.get('nome') || '').replace(/[^\w .()-]/g, '').slice(0, 80);
    const produto = produtoDoTexto(q.get('prod') || '');
    await b.put(PREFIXO + id, corpo, { httpMetadata: { contentType: img.tipo },
      customMetadata: { expira: String(expira), criado: String(agora), por: eu.usuario, nome, w: String(img.w), h: String(img.h), ...metaProduto(produto) } });
    await env.OLIST.put(chaveTaxa, String(feitos + 1), { expirationTtl: 7200 });
    return json({ id, url: new URL('/api/u/' + id, request.url).href, expira, tipo: img.tipo, w: img.w, h: img.h, bytes: corpo.length, produto });
  }
  // fotos que ainda valem; as vencidas encontradas no caminho são apagadas
  if (rota === 'lista' && m === 'GET'){
    const itens = [], vencidos = [], agora = Date.now(); let cursor;
    do {
      const l = await b.list({ prefix: PREFIXO, cursor, limit: 1000, include: ['customMetadata', 'httpMetadata'] });
      for (const o of l.objects){
        const c = o.customMetadata || {};
        if (!(+c.expira > agora)){ vencidos.push(o.key); continue; }
        const id = o.key.slice(PREFIXO.length);
        itens.push({ id, url: new URL('/api/u/' + id, request.url).href, expira: +c.expira, criado: +c.criado, por: c.por, nome: c.nome, w: +c.w, h: +c.h, tipo: o.httpMetadata?.contentType, bytes: o.size, produto: produtoDoMeta(c) });
      }
      cursor = l.truncated ? l.cursor : null;
    } while (cursor);
    for (let i = 0; i < vencidos.length; i += 1000) await b.delete(vencidos.slice(i, i + 1000));
    return json({ itens: itens.sort((a, z) => a.criado - z.criado), apagadosVencidos: vencidos.length });
  }
  // "apagar agora": o link passa a dar 404 na hora
  if (rota === 'apagar' && m === 'POST'){
    const id = q.get('id') || '';
    if (!ID.test(id)) return erro('Id inválido.');
    await b.delete(PREFIXO + id);
    return json({ ok: true });
  }
  // trocar o produto de uma foto (o R2 não edita metadados: o arquivo é regravado igual, com o produto novo)
  if (rota === 'produto' && m === 'POST'){
    const id = q.get('id') || '';
    if (!ID.test(id)) return erro('Id inválido.');
    const t = await request.text(); if (t.length > 2000) return erro('Pedido inválido.');
    let corpo; try { corpo = JSON.parse(t); } catch { return erro('Pedido inválido.'); }
    const produto = corpo?.produto === null ? null : lerProduto(corpo?.produto);
    if (corpo?.produto !== null && !produto) return erro('Produto inválido.');
    const o = await b.get(PREFIXO + id);
    if (!o || !(+o.customMetadata?.expira > Date.now())) return erro('A foto não existe mais (venceu ou foi apagada).', 404);
    const { prod, ...resto } = o.customMetadata || {};
    await b.put(PREFIXO + id, await o.arrayBuffer(), { httpMetadata: o.httpMetadata, customMetadata: { ...resto, ...metaProduto(produto) } });
    return json({ ok: true, produto });
  }
  return erro('Rota desconhecida.', 404);
}
