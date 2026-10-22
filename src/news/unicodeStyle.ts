/**
 * "Negrito" na legenda do Instagram. O Instagram não tem formatação (nem
 * negrito nem itálico); o que funciona é usar letras Unicode em negrito
 * (𝗔𝗕𝗖). Aparecem em negrito na legenda, mas a busca do Instagram não as
 * indexa — por isso só o título e o rótulo dos créditos ficam em negrito;
 * o corpo e as hashtags continuam normais.
 * Acentos são mantidos como sinais combinantes (Á = 𝗔 + ◌́).
 */
const BOLD_UPPER = 0x1d5d4; // 𝗔
const BOLD_LOWER = 0x1d5ee; // 𝗮
const BOLD_DIGIT = 0x1d7ec; // 𝟬

export function toBold(s: string): string {
  let out = '';
  for (const ch of s.normalize('NFD')) {
    const c = ch.codePointAt(0)!;
    if (c >= 65 && c <= 90) out += String.fromCodePoint(BOLD_UPPER + c - 65);
    else if (c >= 97 && c <= 122) out += String.fromCodePoint(BOLD_LOWER + c - 97);
    else if (c >= 48 && c <= 57) out += String.fromCodePoint(BOLD_DIGIT + c - 48);
    else out += ch;
  }
  return out;
}

export function fromBold(s: string): string {
  let out = '';
  for (const ch of s) {
    const c = ch.codePointAt(0)!;
    if (c >= BOLD_UPPER && c < BOLD_UPPER + 26) out += String.fromCharCode(65 + c - BOLD_UPPER);
    else if (c >= BOLD_LOWER && c < BOLD_LOWER + 26) out += String.fromCharCode(97 + c - BOLD_LOWER);
    else if (c >= BOLD_DIGIT && c < BOLD_DIGIT + 10) out += String.fromCharCode(48 + c - BOLD_DIGIT);
    else out += ch;
  }
  return out.normalize('NFC');
}

/** Título (1ª linha) e o rótulo "Créditos:" em negrito Unicode. */
export function styleCaption(text: string): string {
  const lines = fromBold(text).split('\n');
  const i = lines.findIndex((l) => l.trim());
  if (i >= 0 && !/^\s*#/.test(lines[i]!)) lines[i] = toBold(lines[i]!);
  return lines.map((l) => l.replace(/^(\s*)(Créditos:)/i, (_m, sp: string, lab: string) => sp + toBold(lab))).join('\n');
}

export const plainCaption = (text: string) => fromBold(text);
