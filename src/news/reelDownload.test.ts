import { describe, expect, it } from 'vitest';
import { downloadVideo, DownloadError, instagramCode, isDirectVideoLink, looksLikeVideo, videoUrlsIn, type DlHttp } from './reelDownload';

const mp4 = () => {
  const b = new Uint8Array(80 * 1024);
  b.set([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70], 0); // ....ftyp
  return b;
};
const PAGE = '<html>"LSD",[],{"token":"TOK123"}</html>';

function fakeHttp(post: (body: string) => { status: number; text: string }, files: Record<string, Uint8Array> = {}): DlHttp & { posts: number } {
  const h = {
    posts: 0,
    async get(url: string) {
      return { status: 200, text: url.includes('embed') ? '<html></html>' : PAGE, url, cookies: ['csrftoken=CS', 'mid=M'] };
    },
    async post(_url: string, _h: Record<string, string>, body: string) {
      h.posts++;
      return { ...post(body), url: '', cookies: [] };
    },
    async binary(url: string) {
      const b = files[url];
      return b ? { status: 200, contentType: 'video/mp4', bytes: b } : { status: 403, contentType: 'text/html', bytes: new Uint8Array(10) };
    },
  };
  return h;
}

describe('baixar Reels', () => {
  it('reconhece links (reel, reels, p, tv, com ?igsh=) e link direto', () => {
    expect(instagramCode('https://www.instagram.com/reel/DepPzIRiWda/?igsh=abc')).toBe('DepPzIRiWda');
    expect(instagramCode('https://instagram.com/reels/AbC_12-x/')).toBe('AbC_12-x');
    expect(instagramCode('https://www.instagram.com/conta.x/p/XYZ12345/')).toBe('XYZ12345');
    expect(instagramCode('https://youtube.com/watch?v=1')).toBeNull();
    expect(isDirectVideoLink('https://site.com/a/b.mp4?x=1')).toBe(true);
  });

  it('acha o link do vídeo (video_url, video_versions da maior qualidade, og:video)', () => {
    const t = '{"video_versions":[{"width":480,"height":854,"url":"https://cdn/x480.mp4?a=1"},{"width":1080,"height":1920,"url":"https://cdn/x1080.mp4?a=1"}],"video_url":"https:\\/\\/cdn\\/v.mp4?a=1\\u0026b=2"}';
    const urls = videoUrlsIn(t);
    expect(urls[0]).toBe('https://cdn/v.mp4?a=1&b=2');
    expect(urls.indexOf('https://cdn/x1080.mp4?a=1')).toBeLessThan(urls.indexOf('https://cdn/x480.mp4?a=1'));
  });

  it('confere se é vídeo de verdade (não aceita lixo/HTML)', () => {
    expect(looksLikeVideo(mp4())).toBe(true);
    expect(looksLikeVideo(new Uint8Array(100_000))).toBe(false);
    expect(looksLikeVideo(mp4().slice(0, 1000))).toBe(false); // pequeno demais = incompleto
  });

  it('caminho principal: consulta pública com token e cookies → baixa e confere', async () => {
    let body = '';
    const http = fakeHttp(
      (b) => {
        body = b;
        return { status: 200, text: '{"data":{"xdt_shortcode_media":{"is_video":true,"video_url":"https://cdn/ok.mp4"}}}' };
      },
      { 'https://cdn/ok.mp4': mp4() },
    );
    const r = await downloadVideo('https://www.instagram.com/reel/ABC12345/', http);
    expect(r.via).toBe('instagram');
    expect(r.fileName).toBe('reels-ABC12345.mp4');
    expect(body).toContain('lsd=TOK123');
    expect(body).toContain(encodeURIComponent('{"shortcode":"ABC12345"}'));
  });

  it('arquivo corrompido numa qualidade → tenta a outra', async () => {
    const http = fakeHttp(() => ({ status: 200, text: '{"video_versions":[{"width":1080,"url":"https://cdn/ruim.mp4"},{"width":720,"url":"https://cdn/bom.mp4"}]}' }), {
      'https://cdn/ruim.mp4': new Uint8Array(90_000),
      'https://cdn/bom.mp4': mp4(),
    });
    const r = await downloadVideo('https://www.instagram.com/reel/ABC12345/', http);
    expect(r.via).toBe('instagram');
    expect(r.steps.some((s) => s.includes('não é vídeo'))).toBe(true);
  });

  it('Instagram limitando: tenta de novo e, sem sucesso, explica (sem quebrar)', async () => {
    const http = fakeHttp(() => ({ status: 401, text: '{"message":"Please wait a few minutes before you try again.","status":"fail"}' }));
    await expect(downloadVideo('https://www.instagram.com/reel/ABC12345/', http)).rejects.toThrow(/limitando/);
    expect(http.posts).toBe(2); // tentou, esperou e tentou mais uma vez
  }, 15_000);

  it('post de foto: avisa que não é vídeo', async () => {
    const http = fakeHttp(() => ({ status: 200, text: '{"data":{"xdt_shortcode_media":{"is_video":false}}}' }));
    const err = await downloadVideo('https://www.instagram.com/p/ABC12345/', http).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DownloadError);
    expect((err as Error).message).toMatch(/foto/);
  });

  it('link inválido e site sem vídeo: mensagens claras', async () => {
    const http = fakeHttp(() => ({ status: 200, text: '' }));
    await expect(downloadVideo('instagram.com/reel/x', http)).rejects.toThrow(/https/);
    await expect(downloadVideo('https://exemplo.com/noticia', http)).rejects.toThrow(/Não achei um vídeo/);
  });
});
