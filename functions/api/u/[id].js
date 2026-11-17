// Link público temporário de uma foto (modo ponte com o chat): abre sem login, em janela anônima.
// Serve só a imagem guardada, byte a byte (sem recompressão), com o tipo certo. Sem listagem, sem indexação.
// O id tem 128 bits aleatórios (22 caracteres base64url). Vencido, apagado ou inventado: 404.
// O envio e o "apagar agora" ficam em functions/api/ponte (só quem entrou no Estúdio).
const ID = /^[A-Za-z0-9_-]{22}$/;
const EXT = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };
const BASE = {
  'Cache-Control': 'no-store',
  'X-Robots-Tag': 'noindex, nofollow, noarchive, noimageindex',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Content-Security-Policy': "default-src 'none'; sandbox",
};
const naoExiste = () => new Response('Não encontrado.', { status: 404, headers: { ...BASE, 'Content-Type': 'text/plain; charset=utf-8' } });

export async function onRequest({ request, env, params, waitUntil }){
  const m = request.method;
  if (m !== 'GET' && m !== 'HEAD') return new Response('Método não permitido.', { status: 405, headers: { ...BASE, Allow: 'GET, HEAD' } });
  const id = String(params.id || '');
  const b = env.ARQUIVOS;
  if (!ID.test(id) || !b) return naoExiste();
  const chave = '_ponte/' + id;
  const o = m === 'HEAD' ? await b.head(chave) : await b.get(chave);
  if (!o) return naoExiste();
  // a validade é conferida a cada leitura: o link morre na hora certa, mesmo antes da limpeza do R2
  if (!(+o.customMetadata?.expira > Date.now())){
    waitUntil(b.delete(chave));
    return naoExiste();
  }
  const tipo = o.httpMetadata?.contentType;
  if (!EXT[tipo]) return naoExiste();
  const h = { ...BASE, 'Content-Type': tipo, 'Content-Length': String(o.size), ETag: o.httpEtag,
    'Content-Disposition': `inline; filename="imagem-${id.slice(0, 6)}.${EXT[tipo]}"` };
  return new Response(m === 'HEAD' ? null : o.body, { headers: h });
}
