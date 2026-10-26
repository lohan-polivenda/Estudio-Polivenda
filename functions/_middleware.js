// Porta de entrada do site: só entra quem tem usuário e senha (contas em functions/conta).
// As contas e as sessões ficam no KV "OLIST" (o mesmo da ligação com o Olist).
// Sem o KV ligado, o site fica aberto como antes.
const COOKIE = 'estudio_sessao';
export async function usuarioDaSessao(request, env){
  const t = (request.headers.get('Cookie') || '').match(new RegExp(`(?:^|;\\s*)${COOKIE}=([\\w-]+)`))?.[1];
  if (!t || !env.OLIST) return null;
  const login = await env.OLIST.get('sessao:' + t);
  if (!login) return null;
  const u = await env.OLIST.get('usuario:' + login, 'json');
  return u ? { nome: u.nome, usuario: u.usuario, sessao: t } : null;
}

const telaDeEntrada = primeiro => `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex"><title>Estúdio Polivenda · Entrar</title>
<style>
:root{--bg:#f4f5f7;--panel:#fff;--text:#1d2330;--muted:#6b7385;--border:#e1e4ea;--accent:#5d6ec8;--danger:#dc2626}
@media (prefers-color-scheme:dark){:root{--bg:#111318;--panel:#1a1d25;--text:#e7e9ee;--muted:#9aa2b3;--border:#2b303c}}
*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;background:var(--bg);color:var(--text);font:15px/1.45 'DM Sans',system-ui,'Segoe UI',sans-serif;padding:16px}
form{width:min(380px,100%);background:var(--panel);border:1px solid var(--border);border-radius:14px;padding:28px}
h1{margin:0;font-size:22px}p{margin:4px 0 18px;color:var(--muted);font-size:14px}
label{display:block;font-size:13px;font-weight:600;margin:12px 0 4px}
input{width:100%;padding:10px 12px;border:1px solid var(--border);border-radius:8px;background:var(--panel);color:var(--text);font:inherit}
input:focus{outline:2px solid var(--accent);outline-offset:-1px}
button{width:100%;margin-top:18px;padding:11px;border:0;border-radius:8px;background:var(--accent);color:#fff;font:inherit;font-weight:600;cursor:pointer}
button:disabled{opacity:.6}#erro{color:var(--danger);font-size:13px;min-height:18px;margin-top:10px}
</style></head><body>
<form id="f" autocomplete="on">
  <h1>Estúdio Polivenda</h1>
  ${primeiro ? `<p>Primeiro acesso: crie a sua conta. Use a senha da equipe que está na Cloudflare (ESTUDIO_CHAVE).</p>
  <label for="chave">Senha da equipe</label><input id="chave" type="password" required autocomplete="off">
  <label for="nome">Seu nome</label><input id="nome" required maxlength="60" autocomplete="name">
  <label for="usuario">Usuário</label><input id="usuario" required autocomplete="username" autocapitalize="none" placeholder="ex.: ana">
  <label for="senha">Senha</label><input id="senha" type="password" required minlength="6" autocomplete="new-password" placeholder="mínimo 6 caracteres">`
  : `<p>Entre com o seu usuário e senha.</p>
  <label for="usuario">Usuário</label><input id="usuario" required autocomplete="username" autocapitalize="none" autofocus>
  <label for="senha">Senha</label><input id="senha" type="password" required autocomplete="current-password">`}
  <button id="b">${primeiro ? 'Criar e entrar' : 'Entrar'}</button>
  <div id="erro" role="alert"></div>
</form>
<script>
const f = document.getElementById('f'), v = id => document.getElementById(id)?.value.trim() ?? '';
f.onsubmit = async e => {
  e.preventDefault(); const b = document.getElementById('b'); b.disabled = true; document.getElementById('erro').textContent = '';
  const corpo = ${primeiro ? `{ chave: v('chave'), nome: v('nome'), usuario: v('usuario').toLowerCase(), senha: document.getElementById('senha').value }`
    : `{ usuario: v('usuario').toLowerCase(), senha: document.getElementById('senha').value }`};
  try {
    const r = await fetch('/conta/${primeiro ? 'primeiro' : 'entrar'}', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(corpo) });
    const d = await r.json().catch(() => ({}));
    if (r.ok) return location.reload();
    document.getElementById('erro').textContent = d.mensagem || 'Não deu certo. Tente de novo.';
  } catch { document.getElementById('erro').textContent = 'Sem conexão. Confira a internet.'; }
  b.disabled = false;
};
</script></body></html>`;

export async function onRequest(ctx){
  const { request, env } = ctx, caminho = new URL(request.url).pathname;
  if (!env.OLIST) return ctx.next();
  // as rotas de conta, do Olist e do Google conferem o acesso elas mesmas (entrar, primeiro acesso, volta do login do Olist)
  if (/^\/(conta|olist|google)\//.test(caminho)) return ctx.next();
  const u = await usuarioDaSessao(request, env);
  if (u){ ctx.data.usuario = u; return ctx.next(); }
  if (request.method !== 'GET' && request.method !== 'HEAD') return new Response('Entre no Estúdio primeiro.', { status: 401 });
  const primeiro = !(await env.OLIST.get('usuarios', 'json'))?.length;
  return new Response(telaDeEntrada(primeiro), { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex' } });
}
