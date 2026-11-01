/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      colors: {
        app: '#0e0e0e',
        sidebar: '#151515',
        raised: '#1d1d1d',
        overlay: '#202020',
        selected: '#262626',
        'selected-strong': '#303030',
        'text-1': '#f4f4f4',
        'text-2': '#a6a6a6',
        'text-3': '#8f8f8f',
        'text-inverse': '#0e0e0e',
        working: '#e8b04b',
        danger: '#ff6b6b',
        success: '#6fdc9b',
        'blob-idle': '#e6e9ee',
        'blob-online': '#54d598',
        'blob-working': '#3b9eff',
        'blob-thinking': '#8b5cf7',
        'blob-approval': '#f5a524',
        'blob-error': '#f45060',
        'blob-finished': '#34d499',
      },
      fontFamily: {
        sans: ['"Segoe UI Variable Text"', '"Segoe UI"', 'Inter', 'system-ui', 'sans-serif'],
        mono: ['"Cascadia Mono"', 'Consolas', 'ui-monospace', 'monospace'],
      },
      borderRadius: {
        sm: '6px',
        md: '10px',
        lg: '14px',
        pill: '999px',
      },
      keyframes: {
        'fade-in': {
          '0%': { opacity: '0', transform: 'translateY(10px)' },
          '100%': { opacity: '1', transform: 'translateY(0)' },
        },
        'scale-in': {
          '0%': { opacity: '0', transform: 'scale(0.95)' },
          '100%': { opacity: '1', transform: 'scale(1)' },
        },
      },
      animation: {
        'fade-in': 'fade-in 0.5s ease-out',
        'scale-in': 'scale-in 0.3s ease-out',
      },
    },
  },
  plugins: [],
}
