import type { Config } from "tailwindcss";

export default {
  content: ["./index.html", "./src/web/**/*.{ts,tsx}"],
  theme: {
    extend: {
      fontFamily: {
        sans: ["'Space Grotesk'", "'IBM Plex Sans'", "sans-serif"],
        mono: ["'IBM Plex Mono'", "'Fira Code'", "monospace"],
      },
      colors: {
        ink: "#0f1720",
        mist: "#f3efe7",
        ember: "#f97316",
        pine: "#0f766e",
        skyglass: "#d8eef3",
      },
      boxShadow: {
        panel: "0 20px 60px rgba(15, 23, 32, 0.12)",
      },
      backgroundImage: {
        aurora:
          "radial-gradient(circle at top left, rgba(249, 115, 22, 0.18), transparent 34%), radial-gradient(circle at top right, rgba(15, 118, 110, 0.14), transparent 32%), linear-gradient(180deg, #f6f0e8 0%, #e8f4f0 100%)",
      },
    },
  },
  plugins: [],
} satisfies Config;
