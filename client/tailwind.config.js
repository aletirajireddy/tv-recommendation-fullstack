/** @type {import('tailwindcss').Config} */
export default {
    content: [
        "./index.html",
        "./src/**/*.{js,ts,jsx,tsx}",
    ],
    theme: {
        extend: {
            colors: {
                dark: {
                    900: '#0a0a0a',
                    800: '#121212',
                    700: '#1e1e1e',
                    600: '#2d2d2d',
                },
                brand: {
                    accent: '#00c853', // Bullish green
                    danger: '#ff5252', // Bearish red
                    purple: '#ba68c8', // Retrace purple
                }
            },
            fontFamily: {
                sans: ['Inter', 'sans-serif'],
            }
        },
    },
    plugins: [],
}
