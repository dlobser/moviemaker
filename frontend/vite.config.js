import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  // Relative asset URLs so the build works whether it sits at the site root
  // (you.neocities.org/) or in a subfolder (you.neocities.org/moviemaker/).
  base: './',
})
