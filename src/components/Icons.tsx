// Minimal inline icon set (stroke icons, 16px grid).
type P = { size?: number; className?: string };
const I = (d: string) =>
  function Icon({ size = 14, className }: P) {
    return (
      <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5"
        strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
        <path d={d} />
      </svg>
    );
  };

export const ChevronRight = I("M6 4l4 4-4 4");
export const ChevronDown = I("M4 6l4 4 4-4");
export const Close = I("M4 4l8 8M12 4l-8 8");
export const Plus = I("M8 3v10M3 8h10");
export const Search = I("M7 12A5 5 0 1 0 7 2a5 5 0 0 0 0 10zM14 14l-3.5-3.5");
// A cog (8 teeth) around a hub; the bare-rays version read as a "sun" / theme toggle.
export const Settings = I("M12.76 6.82L14.31 6.95L14.31 9.05L12.76 9.18L12.2 10.53L13.21 11.72L11.72 13.21L10.53 12.2L9.18 12.76L9.05 14.31L6.95 14.31L6.82 12.76L5.47 12.2L4.28 13.21L2.79 11.72L3.8 10.53L3.24 9.18L1.69 9.05L1.69 6.95L3.24 6.82L3.8 5.47L2.79 4.28L4.28 2.79L5.47 3.8L6.82 3.24L6.95 1.69L9.05 1.69L9.18 3.24L10.53 3.8L11.72 2.79L13.21 4.28L12.2 5.47ZM8 10a2 2 0 1 0 0-4 2 2 0 0 0 0 4z");
export const Import = I("M8 2v8M5 7l3 3 3-3M3 12v1.5h10V12");
export const Refresh = I("M13 8a5 5 0 1 1-1.5-3.5M13 2.5V5h-2.5");
export const Trash = I("M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.5 9h6l.5-9");
export const Up = I("M8 13V3M4 7l4-4 4 4");
export const Down = I("M8 3v10M4 9l4 4 4-4");
export const Copy = I("M5.5 5.5h7v7h-7zM3.5 10.5v-7h7");
export const Eye = I("M1.5 8S4 3.5 8 3.5 14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8zM8 10a2 2 0 1 0 0-4 2 2 0 0 0 0 4z");
export const EyeOff = I("M2 2l12 12M6.6 6.6A2 2 0 0 0 9.4 9.4M4.2 4.6C2.5 5.8 1.5 8 1.5 8S4 12.5 8 12.5c1.3 0 2.4-.4 3.3-1M7 3.6c.3 0 .7-.1 1-.1 4 0 6.5 4.5 6.5 4.5s-.5.9-1.4 2");
export const Lock = I("M4 7.5h8v6H4zM5.5 7.5V5a2.5 2.5 0 0 1 5 0v2.5");
export const Sun = I("M8 11a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM8 1v1.5M8 13.5V15M1 8h1.5M13.5 8H15M3 3l1 1M12 12l1 1M3 13l1-1M12 4l1-1");
export const Moon = I("M13.5 9.5A6 6 0 0 1 6.5 2.5a6 6 0 1 0 7 7z");
export const Dots = I("M3.5 8h.01M8 8h.01M12.5 8h.01");
export const Warning = I("M8 2l6.5 11.5h-13zM8 6.5v3M8 11.5h.01");
export const Globe = I("M8 14.5a6.5 6.5 0 1 0 0-13 6.5 6.5 0 0 0 0 13zM1.5 8h13M8 1.5c1.8 2 2.5 4 2.5 6.5S9.8 12.5 8 14.5C6.2 12.5 5.5 10.5 5.5 8S6.2 3.5 8 1.5z");
export const File = I("M4 1.5h5.5L12.5 4.5v10h-8.5zM9 1.5V5h3.5");
export const Clipboard = I("M5.5 2.5h5v2h-5zM5.5 3.5H3.5v11h9v-11h-2");
export const Layers = I("M8 2l6 3-6 3-6-3zM2 8l6 3 6-3M2 11l6 3 6-3");
export const Check = I("M3 8.5l3 3 7-7");
export const Stop = I("M4.5 4.5h7v7h-7z");
export const Pin = I("M6 2h4M7 2v4L5 9h6L9 6V2M8 9v5");
export const Tree = I("M3 3h4M3 3v10M3 8h3M3 13h3M9 3h4M8.5 8h4.5M8.5 13h4.5");
