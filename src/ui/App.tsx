import { useEffect, useState } from 'react';
import { ProjectsScreen } from './ProjectsScreen';
import { Editor } from './Editor';
import { Toast } from './Toast';
import { PostadorStatusBar } from './PostadorStatus';
import { DialogHost, confirmDialog } from './dialogs';
import { exitApp, installBackButton } from '../platform/backButton';
import { TooltipLayer } from './Tooltip';
import { health } from '../platform/api';

/** Roteamento mínimo por hash: #/ = projetos, #/p/<id> = editor. */
function useRoute() {
  const [hash, setHash] = useState(() => location.hash);
  useEffect(() => {
    const on = () => setHash(location.hash);
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  const m = /^#\/p\/([\w-]+)/.exec(hash);
  return m ? { name: 'editor' as const, id: m[1]! } : { name: 'projects' as const };
}

export function App() {
  const route = useRoute();
  const [serverIssue, setServerIssue] = useState<string | null>(null);

  // botão voltar do Android: sem nada aberto, editor → lista de projetos; lista → perguntar se sai
  useEffect(() => {
    void installBackButton(() => {
      if (/^#\/p\//.test(location.hash)) {
        location.hash = '#/';
        return;
      }
      void confirmDialog({ title: 'Sair do PN Studio?', message: 'Seus projetos ficam salvos no aparelho.', confirmLabel: 'Sair' }).then(
        (ok) => {
          if (ok) void exitApp();
        },
      );
    });
  }, []);

  useEffect(() => {
    health()
      .then((h) => setServerIssue(h.error))
      .catch((e: unknown) => setServerIssue(e instanceof Error ? e.message : String(e)));
  }, []);

  return (
    <>
      {serverIssue && <div className="banner-error">{serverIssue}</div>}
      {route.name === 'editor' ? <Editor key={route.id} projectId={route.id} /> : <ProjectsScreen />}
      <PostadorStatusBar />
      <Toast />
      <DialogHost />
      <TooltipLayer />
    </>
  );
}
