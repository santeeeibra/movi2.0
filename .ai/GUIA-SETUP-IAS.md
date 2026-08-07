# 🤖 Guía: Todas las IAs juntas en Cursor para Movi
> Windows + PowerShell. Una sola vez, te queda configurado para siempre.

---

## Visión general

```
Cursor (tu editor principal)
├── Claude Code    → Tab de Code en Cursor (codeo largo, arquitectura)
├── Cline          → Extensión en Cursor (agente autónomo, edita archivos solo)
├── Copilot/Codex  → Autocompletado inline mientras escribís
├── Gemini         → Web/CLI para consultas y research
└── Antigravity    → Según tu versión, como extensión o CLI
        ↓
    Todos leen .ai/CONTEXT.md del repo = memoria compartida
```

---

## PASO 1 — Instalar Cursor

1. Ir a https://cursor.com y descargar el instalador para Windows
2. Instalarlo normalmente (siguiente → siguiente → finalizar)
3. Abrirlo y loguearte con tu cuenta (podés usar GitHub)
4. Abrir tu carpeta del proyecto: `Archivo → Abrir Carpeta` → `C:\Users\hermo\Downloads\MOVI-actualizado`

---

## PASO 2 — Activar Claude Code en Cursor

Claude Code ya viene integrado en Cursor como el modelo "claude-sonnet" en el chat de Cursor.

1. En Cursor, presionás `Ctrl + L` para abrir el chat lateral
2. En el selector de modelo (arriba del chat), elegís `claude-sonnet-4-5` o el más reciente disponible
3. ✅ Listo. Cursor usa Claude directamente sin extensión aparte.

**Para Claude Code CLI aparte (opcional):**
```powershell
# En PowerShell como administrador
npm install -g @anthropic-ai/claude-code
claude-code login
```

---

## PASO 3 — Instalar Cline en Cursor

Cline es una extensión de VS Code que también funciona en Cursor (que está basado en VS Code).

1. En Cursor, ir a `Ver → Extensiones` (o `Ctrl + Shift + X`)
2. Buscar **"Cline"** (el logo es un terminal con C)
3. Clic en **Instalar**
4. Una vez instalado, aparece el ícono de Cline en la barra lateral izquierda
5. Clic en el ícono de Cline → **Settings** (engranaje)
6. En **API Provider**, seleccionás tu proveedor (OpenRouter, Anthropic, etc.)
7. Pegás tu API key

**Configurar el combo de modelos MOVI que ya tenés:**
- En Cline Settings → Model, usás los que ya configuraste: `oc/deepseek-v4-flash-free`, `kimi/kimi-for-coding`, etc.

**⚠️ Clave: Agregar el contexto a Cline**

En Cline → Settings → **Custom Instructions**, pegá esto:

```
Al inicio de cada tarea, leé el archivo .ai/CONTEXT.md del proyecto para entender el stack y las reglas.
El proyecto es Movi: app de remises en Vanilla JS + Supabase + Mapbox GL JS. Sin frameworks ni build steps.
Al terminar cambios importantes, actualizá .ai/TASKS.md indicando qué se hizo y qué falta.
Respondé siempre en español.
```

---

## PASO 4 — Activar Codex / GitHub Copilot (autocompletado inline)

1. En Cursor → Extensiones → buscar **"GitHub Copilot"**
2. Instalar → te pedirá loguearte con tu cuenta de GitHub
3. Si tenés Copilot activo en tu GitHub (free o Pro), el autocompletado aparece solo mientras escribís
4. Para usar modelos GPT/Codex directamente en el chat de Cursor:
   - `Ctrl + L` → selector de modelo → buscar `gpt-4o` o `gpt-4`
   - Cursor tiene acceso nativo a modelos OpenAI si cargás créditos o usás el plan Pro de Cursor

---

## PASO 5 — Gemini (como CLI en PowerShell)

Gemini CLI es gratuito y tiene contexto de 1 millón de tokens — ideal para pasarle archivos enteros.

```powershell
# Instalar Node si no lo tenés (verificar primero)
node --version

# Instalar Gemini CLI
npm install -g @google/generative-ai-cli

# O la CLI oficial de Google AI
npm install -g @google-ai/generativelanguage
```

**Forma más fácil — Gemini CLI oficial (2025):**
```powershell
npm install -g @google/gemini-cli
gemini login
```

Una vez instalado, desde PowerShell en la carpeta del proyecto:
```powershell
cd C:\Users\hermo\Downloads\MOVI-actualizado
gemini chat
```

**Darle contexto a Gemini:**
```powershell
# Pasarle el CONTEXT.md directamente
gemini chat --file .ai/CONTEXT.md
```

O dentro del chat de Gemini web (gemini.google.com), pegás el contenido de `CONTEXT.md` al inicio.

---

## PASO 6 — Antigravity

Antigravity funciona diferente según la versión:

**Si es extensión de VS Code/Cursor:**
1. Extensiones → buscar "Antigravity" → Instalar
2. Configurar API key en sus settings
3. Agregar a su system prompt el contenido de `.ai/CONTEXT.md`

**Si es CLI/web:**
- Pegás `CONTEXT.md` al inicio de cada sesión igual que con Gemini

---

## PASO 7 — Crear los archivos de contexto en el repo

En PowerShell:
```powershell
cd C:\Users\hermo\Downloads\MOVI-actualizado
mkdir .ai
```

Después, desde Cursor, creás estos 4 archivos dentro de `.ai/`:

### `.ai/CONTEXT.md`
→ El archivo que te di (el "cerebro" del proyecto)

### `.ai/TASKS.md`
```markdown
# Tareas Movi

## En progreso
- [ ] Integrar auto 3D en rama main

## Pendientes
- [ ] Arreglar panel dev
- [ ] Implementar menú de perfil
- [ ] Implementar configuración
- [ ] Implementar ayuda/soporte
- [ ] Activar Supabase Realtime para tracking conductor

## Completadas
- [x] 73 lugares verificados en Supabase
- [x] Sistema híbrido de lugares (verificados + aprendizaje)
- [x] Tarifas: $2000 mín + $200/km + $80/min
- [x] Pins de origen y destino en mapa
- [x] Auto 3D con 4 capas Mapbox (en local, pendiente push)
```

### `.ai/DECISIONS.md`
```markdown
# Decisiones de Arquitectura

## Vanilla JS sin framework
**Por qué:** Simplicidad, sin build step, deploya directo en Vercel.
**No cambiar** a menos que el proyecto crezca 10x en complejidad.

## Supabase
**Por qué:** SQL real, free tier generoso, Realtime built-in para tracking.

## Mapbox GL JS
**Por qué:** Mejor soporte type:model para auto 3D, más customizable que Google Maps.

## PWA sobre app nativa
**Por qué:** Sin tiendas de apps, instalación directa desde Safari/Chrome.
```

### `.cursorrules`
Este va en la **raíz** del proyecto (no dentro de `.ai/`):
```
# Reglas para Cursor y Codex - Proyecto Movi

Eres un asistente de desarrollo para Movi, una app de remises para Viedma/Patagones, Argentina.

REGLAS OBLIGATORIAS:
- Leer .ai/CONTEXT.md antes de cualquier tarea
- NO usar frameworks (React, Vue, Angular, etc.)
- NO agregar build steps (Vite, Webpack, Parcel, etc.)
- El stack es: HTML + CSS + JS Vanilla (ES Modules) + Supabase + Mapbox GL JS
- Mobile-first siempre
- Color de marca es VERDE, no reemplazarlo
- Comentarios en español
- Variables en camelCase inglés

ANTES DE CADA TAREA:
1. Leer .ai/CONTEXT.md
2. Verificar .ai/TASKS.md para no duplicar trabajo
3. Si la tarea genera un cambio importante, actualizar .ai/TASKS.md al terminar

DEPLOY:
- Cada push a `main` en GitHub redespliega Vercel automáticamente
- Verificar que los cambios no rompan el deploy
```

---

## PASO 8 — Flujo de trabajo diario

```
1. Abrís Cursor con la carpeta de Movi
2. Cline ya tiene las instrucciones en su system prompt → listo
3. Chat de Cursor (Claude/GPT): empezás con "Leé .ai/CONTEXT.md y ayudame con..."
4. Para Gemini: pegás CONTEXT.md al inicio del chat web
5. Autocompletado de Copilot: funciona solo, lee .cursorrules automáticamente
6. Al terminar el día: actualizás .ai/TASKS.md con lo que hiciste
```

---

## Resumen visual

```
Tu repo movi2.0/
├── .cursorrules          ← Copilot + Codex lo leen automático
├── .ai/
│   ├── CONTEXT.md        ← Cerebro compartido (todas las IAs)
│   ├── TASKS.md          ← Qué falta, qué está en progreso
│   └── DECISIONS.md      ← Por qué el stack es así
│
└── [tu código...]

Cursor (editor)
├── Chat con Claude → lee CONTEXT.md manual al inicio
├── Cline → lee CONTEXT.md automático (ya configurado en custom instructions)
├── Copilot inline → lee .cursorrules automático
└── Gemini CLI → pasarle CONTEXT.md con --file o pegándolo
```

---

## Tip final: Alias en PowerShell para arrancar rápido

Agregá esto a tu perfil de PowerShell (`$PROFILE`):
```powershell
# Abrir Movi en Cursor de una
function movi { cursor "C:\Users\hermo\Downloads\MOVI-actualizado" }

# Chat rápido con Gemini con contexto de Movi
function movi-gemini { 
  cd "C:\Users\hermo\Downloads\MOVI-actualizado"
  gemini chat --file .ai/CONTEXT.md 
}
```

Después con solo escribir `movi` en PowerShell se abre Cursor con el proyecto listo.
