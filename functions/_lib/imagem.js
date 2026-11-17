// Ajudantes de imagem usados pelas rotas /api (sem rota própria: este arquivo não exporta onRequest).

// 128 bits aleatórios em base64url (22 caracteres)
export function novoId(){
  const b = crypto.getRandomValues(new Uint8Array(16));
  return btoa(String.fromCharCode(...b)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
export const ID = /^[A-Za-z0-9_-]{22}$/;
export const EXT = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };

// tipo e tamanho lidos dos próprios bytes (não confia no nome nem no cabeçalho)
export function lerImagem(u){
  const n = u.length, be16 = i => u[i] << 8 | u[i + 1], le16 = i => u[i] | u[i + 1] << 8, le24 = i => u[i] | u[i + 1] << 8 | u[i + 2] << 16;
  const txt = (i, k) => String.fromCharCode(...u.subarray(i, i + k));
  if (n > 24 && u[0] === 0x89 && txt(1, 3) === 'PNG' && txt(12, 4) === 'IHDR'){
    const dv = new DataView(u.buffer, u.byteOffset);
    return { tipo: 'image/png', w: dv.getUint32(16), h: dv.getUint32(20) };
  }
  if (n > 30 && txt(0, 4) === 'RIFF' && txt(8, 4) === 'WEBP'){
    const c = txt(12, 4);
    if (c === 'VP8 ') return { tipo: 'image/webp', w: le16(26) & 0x3fff, h: le16(28) & 0x3fff };
    if (c === 'VP8L'){ const v = (u[21] | u[22] << 8 | u[23] << 16 | u[24] << 24) >>> 0; return { tipo: 'image/webp', w: (v & 0x3fff) + 1, h: ((v >>> 14) & 0x3fff) + 1 }; }
    if (c === 'VP8X') return { tipo: 'image/webp', w: le24(24) + 1, h: le24(27) + 1 };
    return null;
  }
  if (n > 4 && u[0] === 0xFF && u[1] === 0xD8){
    let i = 2;
    while (i + 9 < n){
      if (u[i] !== 0xFF) return null;
      const m = u[i + 1];
      if (m === 0xFF){ i++; continue; }
      if (m === 0xD8 || m === 0x01 || (m >= 0xD0 && m <= 0xD7)){ i += 2; continue; }
      if (m >= 0xC0 && m <= 0xCF && m !== 0xC4 && m !== 0xC8 && m !== 0xCC) return { tipo: 'image/jpeg', w: be16(i + 7), h: be16(i + 5) };
      i += 2 + be16(i + 2);
    }
  }
  return null;
}
