/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        glass: "rgba(17, 24, 39, 0.7)",
        glassBorder: "rgba(255, 255, 255, 0.1)",
        neonGreen: "#39ff14"
      }
    },
  },
  plugins: [],
}