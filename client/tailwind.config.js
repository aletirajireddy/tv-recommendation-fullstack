/** @type {import('tailwindcss').Config} */
export default {
    darkMode: "class",
    content: [
        "./index.html",
        "./src/**/*.{js,ts,jsx,tsx}",
    ],
    theme: {
        extend: {
            colors: {
                primary: "var(--primary)",
                "background-light": "var(--bg-app)",
                "background-dark": "var(--bg-app)",
                "panel-light": "var(--bg-panel)",
                "panel-dark": "var(--bg-panel)",
                "border-light": "var(--border)",
                "border-dark": "var(--border)",
                "text-light": "var(--text-main)",
                "text-dark": "var(--text-main)",
                "text-muted-light": "var(--text-muted)",
                "text-muted-dark": "var(--text-muted)",
                "accent-green": "var(--accent-green)",
                "accent-red": "var(--accent-red)",
                "accent-blue": "var(--accent-blue)",
                "accent-orange": "var(--accent-orange)"
            },
            fontFamily: {
                display: ["Inter", "sans-serif"],
                body: ["Inter", "sans-serif"],
                sans: ["Inter", "sans-serif"]
            },
            borderRadius: {
                DEFAULT: "0.25rem",
            },
            fontSize: {
                'xxs': '0.65rem',
            }
        },
    },
    plugins: [],
}
