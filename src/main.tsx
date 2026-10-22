import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './render/fonts';
import './styles.css';
import { App } from './ui/App';
import { useEditor } from './state/store';
import { Capacitor } from '@capacitor/core';

// Postador automático: só no app do celular (o web é prévia)
if (Capacitor.isNativePlatform()) {
  void import('./news/autopostApp').then(async ({ getAutoConfig, startAutopostClock }) => {
    if (!getAutoConfig().ativo) return;
    const { postadorNative } = await import('./platform/postadorNative');
    await postadorNative.start().catch(() => undefined);
    startAutopostClock();
  });
}

// Ganchos para testes automatizados (apenas em desenvolvimento).
if (import.meta.env.DEV) (window as unknown as { __editor: typeof useEditor }).__editor = useEditor;

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
