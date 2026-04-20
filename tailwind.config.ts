import type { Config } from "tailwindcss";

export default {
  content: {
    relative: true,
    files: ["./index.html", "./docs-site/index.html", "./src/web/**/*.{ts,tsx}", "./docs-site/**/*.{ts,tsx}"],
  },
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
        aurora: "#e8f4f0", // flattened for accessibility
      },
    },
  },
  plugins: [],
} satisfies Config;
