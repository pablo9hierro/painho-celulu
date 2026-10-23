/**
 * Fila de comandos de edição por voz/texto: cada comando falado vira um item
 * (pendente → executado/erro). "Executar" roda a IA para cada comando pendente
 * e aplica as ações na timeline de verdade. Pode editar manualmente a qualquer
 * momento, antes, entre ou depois dos comandos.
 */
import { useSyncExternalStore } from 'react';
import { aiChat } from '../news/openrouter';
import { getAiKey } from '../news/client';
import { buildContext, planEdit, applyEditActions, type EditAction } from '../news/editAi';
import { getEditor } from '../state/store';

export interface QueuedCommand {
  id: string;
  texto: string;
  status: 'pendente' | 'rodando' | 'feito' | 'erro' | 'vazio';
  acoes?: EditAction[];
  aviso?: string;
  erro?: string;
}

let queue: QueuedCommand[] = [];
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());
export function onQueueChange(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
export function useAiEditQueue(): QueuedCommand[] {
  return useSyncExternalStore(onQueueChange, () => queue);
}

let uid = 0;
export function queueCommand(texto: string) {
  const t = texto.trim();
  if (!t) return;
  queue = [...queue, { id: `c${++uid}`, texto: t, status: 'pendente' }];
  emit();
}
export function removeCommand(id: string) {
  queue = queue.filter((c) => c.id !== id);
  emit();
}
export function clearDone() {
  queue = queue.filter((c) => c.status !== 'feito');
  emit();
}
function setCmd(id: string, patch: Partial<QueuedCommand>) {
  queue = queue.map((c) => (c.id === id ? { ...c, ...patch } : c));
  emit();
}

/** Roda todos os comandos pendentes, na ordem, um de cada vez. */
export async function runQueue(): Promise<void> {
  const key = getAiKey();
  const chat = aiChat(key);
  if (!chat) throw new Error('Coloque a chave da IA em ⚙ Configurações.');
  for (const cmd of queue.filter((c) => c.status === 'pendente')) {
    setCmd(cmd.id, { status: 'rodando' });
    try {
      const s = getEditor();
      const project = s.project;
      if (!project) throw new Error('Nenhum projeto aberto.');
      const ctx = buildContext(project, s.time);
      const r = await planEdit(chat, ctx, cmd.texto);
      if (!r.actions.length) {
        setCmd(cmd.id, { status: 'vazio', aviso: r.aviso || 'Nada para aplicar (comando não reconhecido ou já feito).' });
        continue;
      }
      getEditor().apply((p) => applyEditActions(p, r.actions));
      setCmd(cmd.id, { status: 'feito', acoes: r.actions, aviso: r.aviso });
    } catch (e) {
      setCmd(cmd.id, { status: 'erro', erro: (e as Error).message });
    }
  }
}

/** descrição curta de uma ação, pra mostrar no histórico */
export function describeAction(a: EditAction): string {
  switch (a.tipo) {
    case 'cortar':
      return `cortar ${a.inicio.toFixed(1)}s–${a.fim.toFixed(1)}s`;
    case 'velocidade':
      return `velocidade ${a.fator}x`;
    case 'manchete':
      return `manchete "${a.texto}"`;
    case 'zoom':
      return `zoom ${a.direcao} (${a.foco}) em ${a.inicio.toFixed(1)}s`;
    case 'desfoque':
      return `desfoque (${a.area}) em ${a.inicio.toFixed(1)}s`;
    case 'excluir':
      return 'excluir item';
  }
}
