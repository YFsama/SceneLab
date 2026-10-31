export default {
  plugins: {
    // Tailwind v4: the engine ships as a PostCSS plugin here (Vite picks this
    // file up for both dev and build); prefixing is built in via Lightning CSS,
    // so the old autoprefixer entry is gone.
    '@tailwindcss/postcss': {},
  },
}
