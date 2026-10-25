import { describe, expect, it } from 'vitest';
import { dueSlot, emptyState, learnedBoost, measure, postingSlots, recordViews, writerRules } from './learning';

/** horário de Brasília → Date (UTC-3) */
const at = (day: string, hh: number, mm = 0) => {
  const [y, m, d] = day.split('-').map(Number);
  return new Date(Date.UTC(y!, m! - 1, d!, hh + 3, mm));
};

describe('aprendizado do Postador', () => {
  it('sem dados: usa a curva padrão e posta 25 min antes dos picos', () => {
    const { slots, source } = postingSlots(emptyState());
    expect(source).toMatch(/padrão/);
    expect(slots.length).toBe(4);
    expect(slots.every((s) => /^\d\d:35$/.test(s))).toBe(true);
  });

  it('acessos lidos de hora em hora viram a curva de audiência real; dispara 25 min antes do pico', () => {
    const st = emptyState();
    let total = 1000;
    for (let h = 0; h < 24; h++) {
      // pico às 20h (muito acesso entre 19h30 e 20h30)
      recordViews(st, at('2026-10-20', h, 30), [{ id: 1, views: total }]);
      total += h === 19 ? 900 : h === 12 ? 500 : 60; // entre 19h30 e 20h30 = hora das 20h
    }
    recordViews(st, at('2026-10-21', 0, 30), [{ id: 1, views: total }]);
    const { slots, peaks } = postingSlots(st, 2);
    expect(peaks).toContain(20);
    expect(slots).toContain('19:35');
    expect(dueSlot(st, at('2026-10-21', 19, 40), 35, 2)).toBe('2026-10-21 19:35');
    expect(dueSlot(st, at('2026-10-21', 17, 0), 35, 2)).toBeNull();
    st.slotsUsed.push('2026-10-21 19:35');
    expect(dueSlot(st, at('2026-10-21', 19, 50), 35, 2)).toBeNull();
  });

  it('mede com 36 h, aprende o que deu audiência e passa para o ranking e o redator', () => {
    const st = emptyState();
    const base = { categoria: 'Policial', keywords: ['operação'], postedAt: at('2026-10-10', 10).toISOString() };
    st.stories = [
      { ...base, url: 'a', title: 'Operação prende suspeitos em Bayeux', city: 'Bayeux', siteId: 1 },
      { ...base, url: 'b', title: 'Operação apreende drogas em Bayeux', city: 'Bayeux', siteId: 2 },
      { ...base, url: 'c', title: 'Feira de artesanato em Cabedelo', city: 'Cabedelo', categoria: 'Cultura', keywords: ['feira'], siteId: 3 },
      { ...base, url: 'd', title: 'Exposição de arte em Cabedelo', city: 'Cabedelo', categoria: 'Cultura', keywords: ['arte'], siteId: 4 },
    ];
    const n = measure(st, at('2026-10-20', 10), new Map([[1, 3000], [2, 2500], [3, 300], [4, 400]]), new Map());
    expect(n).toBe(4);
    expect(learnedBoost(st, { title: 'Nova operação em Bayeux', city: 'Bayeux' }).pts).toBeGreaterThan(0);
    expect(learnedBoost(st, { title: 'Show em Cabedelo', city: 'Cabedelo' }).pts).toBeLessThan(0);
    expect(writerRules(st)).toMatch(/bayeux/i);
  });
});

describe('renovação do token do Instagram', () => {
  it('só renova faltando 10 dias para vencer', async () => {
    const { igNeedsRefresh } = await import('./igToken');
    const now = new Date('2026-10-22T00:00:00Z');
    expect(igNeedsRefresh({ igExpiresAt: '2026-12-21T00:00:00Z' }, now)).toBe(false); // 60 dias: não
    expect(igNeedsRefresh({ igExpiresAt: '2026-11-15T00:00:00Z' }, now)).toBe(false); // 24 dias: não
    expect(igNeedsRefresh({ igExpiresAt: '2026-10-30T00:00:00Z' }, now)).toBe(true); // 8 dias: renova
    expect(igNeedsRefresh({}, now)).toBe(true); // sem data: renova uma vez para saber
  });
});

describe('renovação do token do Facebook', () => {
  const now = new Date('2027-01-10T00:00:00Z'); // faltam 10 dias para 20/01
  const fake = (newExp: number) => ({
    async get(url: string) {
      if (url.includes('oauth/access_token')) return { access_token: 'EAA-novo' };
      if (url.includes('debug_token')) return { data: { data_access_expires_at: url.includes('EAA-novo') ? newExp : Date.parse('2027-01-20T00:00:00Z') / 1000 } };
      return {};
    },
    async post() { return {}; },
    async upload() { return {}; },
  });
  it('faltando 15 dias, renova pela requisição e fica com o token novo se a Meta estender', async () => {
    const { maintainTokens } = await import('./igToken');
    const r = await maintainTokens(fake(Date.parse('2027-04-20T00:00:00Z') / 1000), { fbToken: 'EAA-velho', appToken: 'a|b', appId: 'a', appSecret: 'b' }, { igExpiresAt: '2027-03-01T00:00:00Z' }, now);
    expect(r.fbToken).toBe('EAA-novo');
    expect(r.meta.fbDataExpiresAt?.slice(0, 10)).toBe('2027-04-20');
    expect(r.warnings).toEqual([]);
  });
  it('se a Meta não estender, mantém o token e avisa', async () => {
    const { maintainTokens } = await import('./igToken');
    const r = await maintainTokens(fake(Date.parse('2027-01-20T00:00:00Z') / 1000), { fbToken: 'EAA-velho', appToken: 'a|b', appId: 'a', appSecret: 'b' }, { igExpiresAt: '2027-03-01T00:00:00Z' }, now);
    expect(r.fbToken).toBeUndefined();
    expect(r.warnings.join(' ')).toMatch(/gere outro/);
  });
});

describe('postador no celular: horário com novas tentativas', () => {
  it('abre no horário, segue aberto por 1h30 e fecha depois de 3 tentativas ou de usado', async () => {
    const { openSlot } = await import('./autopostApp');
    const { emptyState, postingSlots } = await import('./learning');
    const st = emptyState();
    const slot = postingSlots(st).slots[0]!; // ex.: 06:35
    const [hh, mm] = slot.split(':').map(Number);
    const at = (min: number) => new Date(Date.UTC(2026, 9, 23, hh! + 3, mm! + min));
    const key = `2026-10-23 ${slot}`;
    expect(openSlot(st, at(0), {})).toBe(key);
    expect(openSlot(st, at(60), {})).toBe(key); // celular estava dormindo: ainda tenta
    expect(openSlot(st, at(100), {})).toBeNull(); // passou de 1h30
    expect(openSlot(st, at(10), { [key]: 3 })).toBeNull(); // 3 tentativas
    st.slotsUsed.push(key);
    expect(openSlot(st, at(10), {})).toBe(key); // até 2 por horário de pico (briga de engajamento pode render 2 boas)
    st.slotsUsed.push(key);
    expect(openSlot(st, at(10), {})).toBeNull(); // esse horário já deu os 2
  });
});

describe('automático: blog e Instagram separados', () => {
  it('Instagram pega a do blog com mais visualizações por hora (1 h+ no ar, últimas 24 h, sem repetir)', async () => {
    const { bestForInstagram } = await import('./autopostApp');
    const now = new Date('2026-10-23T18:00:00-03:00');
    const n = (id: number, horas: number, views: number, status = 'Publicado') => ({ id, title: `m${id}`, url: '', views, status, date: new Date(now.getTime() - horas * 3600_000).toISOString() });
    const list = [n(1, 10, 500), n(2, 2, 300), n(3, 0.5, 900), n(4, 30, 9000), n(5, 3, 600, 'Revisão'), n(6, 4, 1000)];
    // 2: 150/h · 1: 50/h · 6: 250/h · (3 tem menos de 1 h, 4 tem mais de 24 h, 5 está em revisão)
    expect(bestForInstagram(list, new Set(), now)!.item.id).toBe(6);
    expect(bestForInstagram(list, new Set([6]), now)!.item.id).toBe(2);
    expect(bestForInstagram([n(3, 0.5, 900)], new Set(), now)).toBeNull();
  });
  it('blog: lote da manhã (6h), uma vez por dia; se parou no meio, continua 20 min depois (até 12h)', async () => {
    const { blogDue } = await import('./autopostApp');
    const at = (hh: number, mm = 0) => new Date(`2026-10-23T${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}:00-03:00`);
    const dia = '2026-10-23';
    const vazio = { lastTry: null, day: '', count: 0, done: false };
    expect(blogDue(vazio, at(5, 50))).toBe(false); // antes das 6h
    expect(blogDue(vazio, at(6, 5))).toBe(true);
    expect(blogDue({ ...vazio, day: '2026-10-22', count: 10, done: true }, at(7, 5))).toBe(true); // ontem não conta
    expect(blogDue({ lastTry: at(7).toISOString(), day: dia, count: 4, done: false }, at(7, 10))).toBe(false); // acabou de tentar
    expect(blogDue({ lastTry: at(7).toISOString(), day: dia, count: 4, done: false }, at(7, 25))).toBe(true); // continua o lote
    expect(blogDue({ lastTry: at(7).toISOString(), day: dia, count: 10, done: false }, at(9))).toBe(false); // lote completo
    expect(blogDue({ lastTry: at(7).toISOString(), day: dia, count: 3, done: true }, at(9))).toBe(false); // sem mais pautas boas
    expect(blogDue(vazio, at(12, 10))).toBe(false); // depois das 12h não publica lote
  });
});
