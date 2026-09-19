import type { Config } from 'tailwindcss';

/**
 * 暗色 + 中世纪风 + 赛博朋克混搭
 * 背景 #05070d，霓虹色板见需求文档「UI 视觉风格」
 */
const config: Config = {
  content: ['./app/**/*.{ts,tsx}', './components/**/*.{ts,tsx}', './lib/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        ink: '#05070d',
        panel: '#0a0e17',
        neon: {
          red: '#ff3b5c',
          blue: '#00f0ff',
          purple: '#8b5cf6',
        },
        ok: '#39ff14',
        warn: '#ffb020',
        gold: '#ffd700',
        fog: '#8aa0b8',
      },
      fontFamily: {
        display: ['Cinzel', 'Georgia', 'serif'],
        mono: ['"JetBrains Mono"', 'ui-monospace', 'SFMono-Regular', 'monospace'],
      },
      boxShadow: {
        glow: '0 0 24px rgba(0, 240, 255, 0.25)',
        'glow-red': '0 0 24px rgba(255, 59, 92, 0.3)',
        'glow-gold': '0 0 24px rgba(255, 215, 0, 0.3)',
      },
      backgroundImage: {
        'grid-faint':
          'linear-gradient(rgba(255,255,255,0.03) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,0.03) 1px, transparent 1px)',
      },
    },
  },
  plugins: [],
};

export default config;
