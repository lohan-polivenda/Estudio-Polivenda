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
.troca{display:block;width:auto;margin:14px auto 0;padding:4px;background:none;color:var(--accent);font-weight:400;font-size:13px}
.so-chave{display:none}form.chave .so-chave{display:block}form.chave .so-entrar{display:none}
</style></head><body>
<form id="f" autocomplete="on" class="${primeiro ? 'chave' : ''}">
  <h1>Estúdio Polivenda</h1>
  <p class="so-entrar">Entre com o seu usuário e senha.</p>
  <p class="so-chave">${primeiro ? 'Primeiro acesso: crie a sua conta.' : 'Com a senha da equipe você cria um acesso novo ou troca a senha de um usuário que já existe.'} A senha da equipe é a que está na Cloudflare (ESTUDIO_CHAVE).</p>
  <div class="so-chave"><label for="chave">Senha da equipe</label><input id="chave" type="password" autocomplete="off">
  <label for="nome">Seu nome</label><input id="nome" maxlength="60" autocomplete="name"></div>
  <label for="usuario">Usuário</label><input id="usuario" required autocomplete="username" autocapitalize="none" ${primeiro ? 'placeholder="ex.: ana"' : 'autofocus'}>
  <label for="senha" id="senhaRot">${primeiro ? 'Senha (mínimo 6 caracteres)' : 'Senha'}</label><input id="senha" type="password" required autocomplete="current-password">
  <button id="b">${primeiro ? 'Criar e entrar' : 'Entrar'}</button>
  <div id="erro" role="alert"></div>
  ${primeiro ? '' : '<button type="button" class="troca" id="troca">Não tenho acesso ou esqueci a senha</button>'}
</form>
<script>
const f = document.getElementById('f'), $ = id => document.getElementById(id), v = id => $(id)?.value.trim() ?? '';
const modo = () => f.classList.contains('chave');
function mostrar(){
  const c = modo();
  $('b').textContent = c ? ${primeiro ? "'Criar e entrar'" : "'Salvar e entrar'"} : 'Entrar';
  $('senhaRot').textContent = c ? 'Nova senha (mínimo 6 caracteres)' : 'Senha';
  $('senha').autocomplete = c ? 'new-password' : 'current-password';
  $('chave').required = c; if ($('troca')) $('troca').textContent = c ? 'Voltar para entrar' : 'Não tenho acesso ou esqueci a senha';
  $('erro').textContent = '';
}
$('troca')?.addEventListener('click', () => { f.classList.toggle('chave'); mostrar(); (modo() ? $('chave') : $('usuario')).focus(); });
mostrar();
f.onsubmit = async e => {
  e.preventDefault(); const b = $('b'); b.disabled = true; $('erro').textContent = '';
  const c = modo(), corpo = { usuario: v('usuario').toLowerCase(), senha: $('senha').value, ...(c ? { chave: v('chave'), nome: v('nome') } : {}) };
  try {
    const r = await fetch(c ? '/conta/primeiro' : '/conta/entrar', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(corpo) });
    const d = await r.json().catch(() => ({}));
    if (r.ok) return location.reload();
    $('erro').textContent = d.mensagem || 'Não deu certo. Tente de novo.';
  } catch { $('erro').textContent = 'Sem conexão. Confira a internet.'; }
  b.disabled = false;
};
</script></body></html>`;

export async function onRequest(ctx){
  const { request, env } = ctx, caminho = new URL(request.url).pathname;
  if (!env.OLIST) return ctx.next();
  // as rotas de conta, do Olist e do Google conferem o acesso elas mesmas (entrar, primeiro acesso, volta do login do Olist)
  if (/^\/(conta|olist|google|nuvem)\//.test(caminho)) return ctx.next();
  const u = await usuarioDaSessao(request, env);
  if (u){ ctx.data.usuario = u; return ctx.next(); }
  if (request.method !== 'GET' && request.method !== 'HEAD') return new Response('Entre no Estúdio primeiro.', { status: 401 });
  const primeiro = !(await env.OLIST.get('usuarios', 'json'))?.length;
  return new Response(telaDeEntrada(primeiro), { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex' } });
}
