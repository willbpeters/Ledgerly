const base = {
  viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 1.75,
  strokeLinecap: "round" as const, strokeLinejoin: "round" as const,
};

type P = { size?: number };
const S = ({ size = 18 }: P) => ({ ...base, width: size, height: size });

export const Icons = {
  dashboard: (p: P = {}) => <svg {...S(p)}><rect x="3" y="3" width="7" height="9" rx="1.5" /><rect x="14" y="3" width="7" height="5" rx="1.5" /><rect x="14" y="12" width="7" height="9" rx="1.5" /><rect x="3" y="16" width="7" height="5" rx="1.5" /></svg>,
  holdings: (p: P = {}) => <svg {...S(p)}><path d="M3 17l6-6 4 4 8-8" /><path d="M14 7h7v7" /></svg>,
  accounts: (p: P = {}) => <svg {...S(p)}><rect x="2" y="5" width="20" height="14" rx="2" /><path d="M2 10h20" /></svg>,
  activity: (p: P = {}) => <svg {...S(p)}><circle cx="12" cy="12" r="9" /><path d="M12 8v4l3 3" /></svg>,
  budget: (p: P = {}) => <svg {...S(p)}><path d="M21 12a9 9 0 1 1-9-9" /><path d="M12 3v9h9" /></svg>,
  settings: (p: P = {}) => <svg {...S(p)}><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" /></svg>,
  sync: (p: P = {}) => <svg {...S(p)}><path d="M21 12a9 9 0 0 1-15.5 6.2L3 16" /><path d="M3 21v-5h5" /><path d="M3 12a9 9 0 0 1 15.5-6.2L21 8" /><path d="M21 3v5h-5" /></svg>,
  search: (p: P = {}) => <svg {...S(p)}><circle cx="11" cy="11" r="7" /><path d="M20 20l-3.5-3.5" /></svg>,
  panel: (p: P = {}) => <svg {...S(p)}><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M15 4v16" /></svg>,
  alert: (p: P = {}) => <svg {...S(p)}><circle cx="12" cy="12" r="9" /><path d="M12 8v4M12 16h.01" /></svg>,
  up: (p: P = {}) => <svg {...S(p)} strokeWidth={2.25}><path d="M12 19V5M5 12l7-7 7 7" /></svg>,
  down: (p: P = {}) => <svg {...S(p)} strokeWidth={2.25}><path d="M12 5v14M19 12l-7 7-7-7" /></svg>,
  plus: (p: P = {}) => <svg {...S(p)} strokeWidth={2.25}><path d="M12 5v14M5 12h14" /></svg>,
};
