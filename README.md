# 🥊 BossBox

Juego de boxeo en primera persona. Subes la foto de tu jefe (o quien sea) y le partes la cara nivel por nivel.

## 🚀 Cómo subirlo a Vercel (paso a paso, 5 minutos)

### Opción A — La más fácil (sin GitHub, arrastrar y soltar)

1. **Descomprime el ZIP** que tienes (la carpeta `bossbox/`).
2. Entra a [vercel.com/signup](https://vercel.com/signup) y crea cuenta gratis (puedes usar tu email o GitHub).
3. Una vez dentro, ve a [vercel.com/new](https://vercel.com/new).
4. Busca abajo el botón pequeño que dice **"deploy a third-party template"** o más fácil: usa la opción **"Import Project"** y selecciona **"Upload"**.
5. Arrastra la carpeta `bossbox/` completa.
6. Vercel detectará Vite automáticamente. Dale **"Deploy"**.
7. Espera ~1 minuto. Te dan un link tipo `bossbox-tunombre.vercel.app` ✅
8. Ese link lo compartes por WhatsApp, Instagram, donde quieras.

### Opción B — Con GitHub (recomendado si lo vas a actualizar)

1. Crea cuenta en [github.com](https://github.com) si no tienes.
2. Crea un repositorio nuevo llamado `bossbox` (puede ser público o privado).
3. Sube el contenido del ZIP (puedes usar GitHub Desktop o arrastrar archivos por la web).
4. En [vercel.com/new](https://vercel.com/new), conecta tu cuenta de GitHub y selecciona el repo `bossbox`.
5. Dale **"Deploy"**. Listo.
6. Bonus: ahora cada vez que cambies código en GitHub, Vercel re-despliega automáticamente.

## 🌐 Custom domain (opcional)

Si quieres `bossbox.lacasadealvaro.com` o algo así:
1. En Vercel, dentro de tu proyecto → **Settings → Domains**
2. Agrega tu dominio y sigue las instrucciones DNS

## 🛠️ Probar localmente antes de subir (opcional)

Si tienes [Node.js](https://nodejs.org) instalado:

```bash
npm install
npm run dev
```

Abre http://localhost:5173 — ahí lo ves antes de subirlo.

Para hacer el build de producción:

```bash
npm run build
```

Genera la carpeta `dist/` que es lo que Vercel sirve.

## 📁 Estructura del proyecto

```
bossbox/
├── index.html              ← entry HTML
├── package.json            ← dependencias
├── vite.config.js          ← config de Vite
├── tailwind.config.js      ← config de Tailwind
├── postcss.config.js
├── src/
│   ├── main.jsx            ← entry de React
│   ├── index.css           ← Tailwind base
│   └── bossbox.jsx         ← TODO el juego (~2000 líneas)
└── README.md               ← este archivo
```

Todo el juego está en `src/bossbox.jsx`. Si quieres cambiar algo (dificultad, sonidos, gráficos), edítalo ahí.

## 🎮 Cómo se juega

- Sube la foto de tu oponente
- Elige dificultad (NOVICIO → LEYENDA)
- **Tap** botones izq/der = jab rápido
- **Mantén** botones izq/der = HOOK / UPPERCUT (más daño)
- **Mantén BLOQUEO** cuando veas el ⚡ aviso del jefe
- **DODGE** te da invulnerabilidad de 0.35s
- Best-of-3 rounds de 60s

## 🐛 Si algo no funciona

- **No suena en iPhone**: quita el switch de silencio lateral, sube el volumen multimedia
- **El build falla en Vercel**: asegúrate de que subiste TODA la carpeta, no solo algunos archivos
- **La foto no carga**: la foto se guarda solo en el navegador (FileReader); si refrescas, hay que subirla otra vez
