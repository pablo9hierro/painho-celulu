/**
 * Publicar no Instagram o vídeo que o jornalista acabou de exportar, com a
 * legenda escrita na tela de Postagem: as mesmas regras do postador
 * automático (palavras sensíveis disfarçadas, convite de collab, descrição
 * também como comentário) e conta para o limite do dia.
 */
import { collabUsernames, postComment, publishReel } from './instagram';
import { censorCaption } from './censor';
import { getIgConfig, nativeIgHttp } from './postadorClient';
import { loadState } from './autopostApp';
import { normalizeState } from './learning';

export async function publishExported(video: Blob, caption: string, onStep: (s: string) => void): Promise<{ id: string; comentario: boolean }> {
  const ig = getIgConfig();
  const token = ig.fbToken || ig.igToken;
  if (!token || !ig.userId) throw new Error('Coloque o ID da conta e o token do Instagram em ⚙ Configurações.');
  const legenda = censorCaption(caption);
  onStep('Enviando o vídeo ao Instagram…');
  const bytes = new Uint8Array(await video.arrayBuffer());
  const r = await publishReel(nativeIgHttp, { userId: ig.userId, token }, bytes, legenda, {
    coverAtMs: 1500,
    collaborators: collabUsernames(ig.collab),
    audioName: 'Primeiras Notícias',
    log: (m) => onStep(m),
  });
  // entra no histórico do postador (conta no limite do dia e no aprendizado)
  try {
    const st = normalizeState(loadState());
    st.stories.push({ url: '', title: legenda.split('\n')[0]!.slice(0, 120), categoria: 'Editor', keywords: [], postedAt: new Date().toISOString(), igId: r.id });
    localStorage.setItem('pn-autopost-state', JSON.stringify(st));
  } catch {
    /* sem armazenamento */
  }
  let comentario = false;
  try {
    onStep('Publicando a descrição também como comentário…');
    await postComment(nativeIgHttp, { userId: ig.userId, token }, r.id, legenda);
    comentario = true;
  } catch {
    /* token sem permissão de comentar: segue */
  }
  return { id: r.id, comentario };
}
