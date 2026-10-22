/** Conjunto de ícones de traço único, desenhados para 20×20. */
import type { SVGProps } from 'react';

const P = (props: Omit<SVGProps<SVGSVGElement>, 'd'> & { d: string | string[] }) => {
  const { d, ...rest } = props;
  return (
    <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden {...rest}>
      {(Array.isArray(d) ? d : [d]).map((x, i) => (
        <path key={i} d={x} />
      ))}
    </svg>
  );
};

type I = SVGProps<SVGSVGElement>;

export const IconMedia = (p: I) => <P {...p} d={['M3 5.5h14v10H3z', 'M8.5 8.2v4.6l3.8-2.3z']} />;
export const IconBrand = (p: I) => <P {...p} d={['M10 2.8l2.1 4.3 4.7.7-3.4 3.3.8 4.7L10 13.6l-4.2 2.2.8-4.7-3.4-3.3 4.7-.7z']} />;
export const IconText = (p: I) => <P {...p} d={['M4 5V3.8h12V5', 'M10 3.8v12.4', 'M7.5 16.2h5']} />;
export const IconTemplate = (p: I) => <P {...p} d={['M3.5 3.5h13v13h-13z', 'M3.5 11.5h13', 'M6 14h5']} />;
export const IconBlur = (p: I) => <P {...p} d={['M3.5 3.5h13v13h-13z']} strokeDasharray="2.2 2" />;
export const IconElements = (p: I) => <P {...p} d={['M3.5 10.5h6v6h-6z', 'M14 3.5l3 5.2h-6z', 'M14 16.5a2.6 2.6 0 100-5.2 2.6 2.6 0 000 5.2z']} />;
export const IconAudio = (p: I) => <P {...p} d={['M3 10v0', 'M6 7v6', 'M9 4v12', 'M12 7.5v5', 'M15 5.5v9', 'M18 9v2']} />;
export const IconPlay = (p: I) => <P {...p} d="M6 4l10 6-10 6z" fill="currentColor" />;
export const IconPause = (p: I) => <P {...p} d={['M6.5 4.5v11', 'M13.5 4.5v11']} strokeWidth="2.4" />;
export const IconSplit = (p: I) => <P {...p} d={['M10 2.5v15', 'M6.5 6L4 8.5 6.5 11', 'M13.5 6L16 8.5 13.5 11']} />;
export const IconTrash = (p: I) => <P {...p} d={['M4 5.5h12', 'M8 5.5V4h4v1.5', 'M5.5 5.5l.8 11h7.4l.8-11']} />;
export const IconCopy = (p: I) => <P {...p} d={['M7 7h9v9H7z', 'M4 13V4h9']} />;
export const IconUndo = (p: I) => <P {...p} d={['M7 4.5L3.5 8 7 11.5', 'M3.5 8H12a4.5 4.5 0 010 9H9']} />;
export const IconRedo = (p: I) => <P {...p} d={['M13 4.5L16.5 8 13 11.5', 'M16.5 8H8a4.5 4.5 0 000 9h3']} />;
export const IconBack = (p: I) => <P {...p} d={['M12 4l-6 6 6 6']} />;
export const IconExport = (p: I) => <P {...p} d={['M10 13V3', 'M6.5 6.5L10 3l3.5 3.5', 'M4 12v4.5h12V12']} />;
export const IconEye = (p: I) => <P {...p} d={['M2.5 10s2.8-5 7.5-5 7.5 5 7.5 5-2.8 5-7.5 5-7.5-5-7.5-5z', 'M10 12.2a2.2 2.2 0 100-4.4 2.2 2.2 0 000 4.4z']} />;
export const IconEyeOff = (p: I) => <P {...p} d={['M3 3l14 14', 'M8.2 5.3A7.6 7.6 0 0110 5c4.7 0 7.5 5 7.5 5a13 13 0 01-2 2.6', 'M5.5 7A12.6 12.6 0 002.5 10s2.8 5 7.5 5a7.2 7.2 0 003.4-.8']} />;
export const IconVolume = (p: I) => <P {...p} d={['M3.5 8v4h3l4 3.5v-11l-4 3.5z', 'M13.5 7.5a3.5 3.5 0 010 5', 'M15.5 5.5a6.4 6.4 0 010 9']} />;
export const IconMute = (p: I) => <P {...p} d={['M3.5 8v4h3l4 3.5v-11l-4 3.5z', 'M13.5 8l4 4', 'M17.5 8l-4 4']} />;
export const IconLock = (p: I) => <P {...p} d={['M5 9h10v7.5H5z', 'M7 9V6.5a3 3 0 016 0V9']} />;
export const IconUnlock = (p: I) => <P {...p} d={['M5 9h10v7.5H5z', 'M7 9V6.5a3 3 0 015.8-1']} />;
export const IconMagnet = (p: I) => <P {...p} d={['M5 3.5v6.5a5 5 0 0010 0V3.5', 'M5 7h3', 'M12 7h3', 'M8 3.5V10a2 2 0 004 0V3.5']} />;
export const IconPlus = (p: I) => <P {...p} d={['M10 4v12', 'M4 10h12']} />;
export const IconClose = (p: I) => <P {...p} d={['M5 5l10 10', 'M15 5L5 15']} />;
export const IconKeyframe = (p: I) => <P {...p} d="M10 3.5l6.5 6.5-6.5 6.5L3.5 10z" />;
export const IconSafe = (p: I) => <P {...p} d={['M5 3.5h10v13H5z', 'M5 6.5h10', 'M5 13.5h10']} />;
export const IconFullscreen = (p: I) => <P {...p} d={['M3 7.5V3h4.5', 'M12.5 3H17v4.5', 'M17 12.5V17h-4.5', 'M7.5 17H3v-4.5']} />;
export const IconExitFullscreen = (p: I) => <P {...p} d={['M7.5 3v4.5H3', 'M17 7.5h-4.5V3', 'M12.5 17v-4.5H17', 'M3 12.5h4.5V17']} />;
export const IconFit = (p: I) => <P {...p} d={['M2.5 4.5v11', 'M17.5 4.5v11', 'M5.5 10h9', 'M8 7.5L5.5 10 8 12.5', 'M12 7.5l2.5 2.5-2.5 2.5']} />;
export const IconStart = (p: I) => <P {...p} d={['M5 4v12', 'M15 4l-7 6 7 6z']} />;
export const IconEnd = (p: I) => <P {...p} d={['M15 4v12', 'M5 4l7 6-7 6z']} />;
export const IconFolder = (p: I) => <P {...p} d="M3 5.5h5l1.5 2H17v8.5H3z" />;
export const IconDots = (p: I) => <P {...p} d={['M5 10h.01', 'M10 10h.01', 'M15 10h.01']} strokeWidth="2.6" />;
export const IconUpload = (p: I) => <P {...p} d={['M10 13V4', 'M6.5 7.5L10 4l3.5 3.5', 'M4 13v3h12v-3']} />;
export const IconDetach = (p: I) => <P {...p} d={['M3 6h14', 'M3 14h14', 'M10 8v4']} />;
export const IconLayers = (p: I) => <P {...p} d={['M10 3l7 4-7 4-7-4z', 'M3 11l7 4 7-4']} />;
export const IconSettings = (p: I) => <P {...p} d={['M4 6h7', 'M15 6h1', 'M4 14h1', 'M9 14h7', 'M13 4v4', 'M7 12v4']} />;
export const IconNews = (p: I) => <P {...p} d={['M4 4.5h10v11H5.5A1.5 1.5 0 014 14z', 'M14 7.5h2v6.5a1.5 1.5 0 01-1.5 1.5', 'M6.5 7.5h5', 'M6.5 10h5', 'M6.5 12.5h3']} />;
export const IconTrend = (p: I) => <P {...p} d={['M3 14.5l4.5-4.5 3 3L17 6.5', 'M12.5 6.5H17V11']} />;
export const IconClip = (p: I) => <P {...p} d={['M12.5 6.5l-5 5a1.8 1.8 0 002.5 2.5l5.5-5.5a3.2 3.2 0 00-4.5-4.5L5.5 9.5a4.6 4.6 0 006.5 6.5l4.5-4.5']} />;
export const IconSend = (p: I) => <P {...p} d={['M3 10l14-6-5 14-2.5-5.5z', 'M9.5 12.5L17 4']} />;
export const IconDownload = (p: I) => <P {...p} d={['M10 3.5v9', 'M6.2 9l3.8 3.8L13.8 9', 'M4 15.5h12']} />;
