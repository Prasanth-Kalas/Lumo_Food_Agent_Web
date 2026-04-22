import type { Config } from "tailwindcss";

const config: Config = {
  content: [
    "./app/**/*.{ts,tsx}",
    "./components/**/*.{ts,tsx}",
    "./lib/**/*.{ts,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        lumo: {
          50: "#f5f7ff",
          100: "#eaf0ff",
          200: "#c8d6ff",
          300: "#9db5ff",
          400: "#6e8cff",
          500: "#4361ee",
          600: "#2f47c9",
          700: "#22349d",
          800: "#1a2878",
          900: "#121b57",
        },
        ink: {
          50: "#f9fafb",
          100: "#f1f3f7",
          200: "#e3e6ee",
          300: "#c9cedc",
          400: "#9aa3bb",
          500: "#6b7394",
          600: "#4b5478",
          700: "#343c5c",
          800: "#222843",
          900: "#151a30",
        },
      },
      fontFamily: {
        sans: [
          "ui-sans-serif",
          "system-ui",
          "-apple-system",
          "Segoe UI",
          "Roboto",
          "sans-serif",
        ],
      },
      boxShadow: {
        card: "0 1px 2px rgba(16, 24, 40, 0.06), 0 1px 3px rgba(16, 24, 40, 0.1)",
        soft: "0 2px 8px rgba(16, 24, 40, 0.08)",
      },
      borderRadius: {
        xl: "0.875rem",
        "2xl": "1.25rem",
      },
      animation: {
        "fade-in": "fade-in 180ms ease-out",
        "slide-up": "slide-up 220ms ease-out",
      },
      keyframes: {
        "fade-in": {
          "0%": { opacity: "0" },
          "100%": { opacity: "1" },
        },
        "slide-up": {
          "0%": { opacity: "0", transform: "translateY(6px)" },
          "100%": { opacity: "1", transform: "translateY(0)" },
        },
      },
    },
  },
  plugins: [],
};

export default config;
