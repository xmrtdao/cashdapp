/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      fontFamily: {
        mono: ['Share Tech Mono', 'monospace'],
        display: ['Rajdhani', 'sans-serif'],
      },
      colors: {
        bg0: 'var(--bg0)',
        bg1: 'var(--bg1)',
        bg2: 'var(--bg2)',
        amber: 'var(--amber)',
        amber2: 'var(--amber2)',
        amber3: 'var(--amber3)',
        cyan: 'var(--cyan)',
        green: 'var(--green)',
        pink: 'var(--pink)',
        purple: 'var(--purple)',
      }
    },
  },
  plugins: [],
}
