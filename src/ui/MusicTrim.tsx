/**
 * Escolher o trecho da música como no Instagram: a onda da música inteira e uma
 * janela de 15 ou 20 s que se desliza com o dedo. ▶ toca só o trecho escolhido.
 * A duração do post em vídeo segue o trecho.
 */
import { useEffect, useRef, useState, type PointerEvent as RPointerEvent } from 'react';
import { media as mediaApi } from '../platform/api';

const BINS = 300;
const peaksCache = new Map<string, Promise<{ peaks: Float32Array; duration: number; url: string }>>();

async function loadPeaks(mediaId: string) {
  const m = await mediaApi.get(mediaId);
  const buf = await (await fetch(m.url)).arrayBuffer();
  const ctx = new OfflineAudioContext(1, 1, 22050);
  const audio = await ctx.decodeAudioData(buf);
  const data = audio.getChannelData(0);
  const peaks = new Float32Array(BINS);
  const step = Math.max(1, Math.floor(data.length / BINS));
  let max = 0;
  for (let i = 0; i < BINS; i++) {
    let p = 0;
    for (let j = i * step; j < Math.min(data.length, (i + 1) * step); j += 8) p = Math.max(p, Math.abs(data[j]!));
    peaks[i] = p;
    max = Math.max(max, p);
  }
  if (max > 0) for (let i = 0; i < BINS; i++) peaks[i]! /= max;
  return { peaks, duration: audio.duration, url: m.url };
}

const fmt = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

export function MusicTrim({ mediaId, inicio, dur, onChange }: { mediaId: string; inicio: number; dur: number; onChange: (v: { inicio: number; dur: number }) => void }) {
  const [info, setInfo] = useState<{ peaks: Float32Array; duration: number; url: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [start, setStart] = useState(inicio);
  const [len, setLen] = useState(dur);
  const [pos, setPos] = useState<number | null>(null);
  const canvas = useRef<HTMLCanvasElement | null>(null);
  const audio = useRef<HTMLAudioElement | null>(null);
  const drag = useRef<{ x0: number; s0: number } | null>(null);

  useEffect(() => {
    let alive = true;
    let p = peaksCache.get(mediaId);
    if (!p) {
      p = loadPeaks(mediaId);
      peaksCache.set(mediaId, p);
      p.catch(() => peaksCache.delete(mediaId));
    }
    p.then((v) => alive && setInfo(v)).catch(() => alive && setError('Não foi possível ler esta música.'));
    return () => {
      alive = false;
      audio.current?.pause();
    };
  }, [mediaId]);

  const total = info?.duration ?? 0;
  const winLen = Math.min(len, total || len);
  const clampStart = (s: number) => Math.max(0, Math.min(s, Math.max(0, total - winLen)));

  // desenha a onda + janela
  useEffect(() => {
    const c = canvas.current;
    if (!c || !info) return;
    const W = (c.width = c.clientWidth * devicePixelRatio);
    const H = (c.height = c.clientHeight * devicePixelRatio);
    const g = c.getContext('2d')!;
    g.clearRect(0, 0, W, H);
    const a = (start / total) * W;
    const b = ((start + winLen) / total) * W;
    const bw = W / BINS;
    for (let i = 0; i < BINS; i++) {
      const x = i * bw;
      const ph = Math.max(2, info.peaks[i]! * H * 0.86);
      const inside = x + bw / 2 >= a && x + bw / 2 <= b;
      g.fillStyle = inside ? '#ffffff' : 'rgba(255,255,255,0.35)';
      g.fillRect(x + bw * 0.15, (H - ph) / 2, bw * 0.7, ph);
    }
    g.strokeStyle = '#1f8bff';
    g.lineWidth = 3 * devicePixelRatio;
    g.beginPath();
    g.roundRect(a + 1.5, 1.5, Math.max(4, b - a - 3), H - 3, 8 * devicePixelRatio);
    g.stroke();
    if (pos !== null) {
      g.fillStyle = '#ffd400';
      g.fillRect((pos / total) * W - devicePixelRatio, 0, 2 * devicePixelRatio, H);
    }
  }, [info, start, winLen, total, pos]);

  const commit = (s: number, l = len) => onChange({ inicio: Math.round(s * 10) / 10, dur: l });

  const secAt = (e: RPointerEvent) => {
    const r = canvas.current!.getBoundingClientRect();
    return ((e.clientX - r.left) / r.width) * total;
  };
  const down = (e: RPointerEvent) => {
    if (!info) return;
    (e.target as Element).setPointerCapture(e.pointerId);
    const t = secAt(e);
    // tocou fora da janela: a janela vem para lá (centrada no dedo)
    const s0 = t < start || t > start + winLen ? clampStart(t - winLen / 2) : start;
    setStart(s0);
    drag.current = { x0: t, s0 };
  };
  const move = (e: RPointerEvent) => {
    if (!drag.current) return;
    setStart(clampStart(drag.current.s0 + secAt(e) - drag.current.x0));
  };
  const up = () => {
    if (!drag.current) return;
    drag.current = null;
    commit(start);
    if (audio.current && !audio.current.paused) void play(true);
  };

  const play = async (restart = false) => {
    if (!info) return;
    const a = audio.current ?? new Audio(info.url);
    audio.current = a;
    if (!a.paused && !restart) {
      a.pause();
      setPos(null);
      return;
    }
    a.currentTime = start;
    a.ontimeupdate = () => {
      if (a.currentTime >= start + winLen) {
        a.pause();
        setPos(null);
      } else setPos(a.currentTime);
    };
    await a.play().catch(() => setError('Não foi possível tocar.'));
  };

  if (error) return <p className="small post-warn">{error}</p>;
  return (
    <div className="music-trim" data-testid="music-trim">
      <canvas
        ref={canvas}
        className="music-trim-wave"
        onPointerDown={down}
        onPointerMove={move}
        onPointerUp={up}
        onPointerCancel={up}
        data-testid="music-trim-wave"
        aria-label="Deslize para escolher o trecho da música"
      />
      <div className="row-between small">
        <button className="btn sm" disabled={!info} onClick={() => void play()} data-testid="music-trim-play">
          {pos !== null ? '■ Parar' : '▶ Ouvir trecho'}
        </button>
        <span className="muted" data-testid="music-trim-range">
          {info ? `${fmt(start)} – ${fmt(start + winLen)} de ${fmt(total)}` : 'Lendo a música…'}
        </span>
        <span className="row-gap">
          {[15, 20].map((n) => (
            <button
              key={n}
              className={`btn sm ${len === n ? 'primary' : ''}`}
              onClick={() => {
                setLen(n);
                const s = Math.max(0, Math.min(start, Math.max(0, total - n)));
                setStart(s);
                commit(s, n);
              }}
              data-testid={`music-trim-${n}`}
            >
              {n}s
            </button>
          ))}
        </span>
      </div>
    </div>
  );
}
