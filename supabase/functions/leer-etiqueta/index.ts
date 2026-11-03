// Lee la etiqueta de un producto de belleza desde una foto con Gemini.
// Requiere el secreto GEMINI_API_KEY en Supabase (Edge Functions > Secrets).
const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...cors, "Content-Type": "application/json" } });

const PROMPT = `Eres experto en productos de belleza vendidos en México. Lee la etiqueta del producto en la foto.
Devuelve SOLO lo que se lee o se deduce con seguridad; si algo no se ve, déjalo vacío o null.
- nombre: nombre comercial en español claro (ej. "Mascarilla capilar con ácido hialurónico"), incluye la línea o variante si se ve.
- marca: la marca tal como aparece.
- presentacion_cantidad: número (ej. 250).
- presentacion_unidad: "ml", "g" o "pzas".
- genero: "mujer", "hombre" o "unisex".
- categoria: una de cabello, rostro, cuerpo, maquillaje, uñas, perfume, higiene, accesorios, otro.
- descripcion: una frase corta de para qué sirve.`;

const schema = {
  type: "OBJECT",
  properties: {
    nombre: { type: "STRING" }, marca: { type: "STRING" },
    presentacion_cantidad: { type: "NUMBER", nullable: true },
    presentacion_unidad: { type: "STRING", enum: ["ml", "g", "pzas"], nullable: true },
    genero: { type: "STRING", enum: ["mujer", "hombre", "unisex"], nullable: true },
    categoria: { type: "STRING" }, descripcion: { type: "STRING" },
  },
  required: ["nombre", "marca"],
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  const key = Deno.env.get("GEMINI_API_KEY");
  if (!key) return json({ error: "falta_llave" }, 503);
  try {
    const { imagen, mime } = await req.json();
    if (!imagen) return json({ error: "sin_imagen" }, 400);
    const armar = (pensar: boolean) => JSON.stringify({
      contents: [{ parts: [{ text: PROMPT }, { inline_data: { mime_type: mime || "image/jpeg", data: imagen } }] }],
      generationConfig: {
        responseMimeType: "application/json", responseSchema: schema, temperature: 0.1,
        // Leer una etiqueta no necesita "pensar": responde en 2-3 s en lugar de 8
        ...(pensar ? {} : { thinkingConfig: { thinkingLevel: "low" } }),
      },
    });
    const modelos = [Deno.env.get("GEMINI_MODEL"), "gemini-3.8-flash", "gemini-flash-latest", "gemini-flash-lite-latest"]
      .filter((m, i, a) => m && a.indexOf(m) === i) as string[];
    const limite = Date.now() + 22000;                  // la app espera máximo 25 s
    let d: any = null, ultimo = "";
    for (const m of modelos) {
      let sinPensar = true;
      for (let intento = 0; intento < 3 && !d; intento++) {
        const resta = limite - Date.now(); if (resta < 2500) break;
        let r: Response, j: any;
        try {
          r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${m}:generateContent?key=${key}`,
            { method: "POST", headers: { "Content-Type": "application/json" }, body: armar(!sinPensar),
              signal: AbortSignal.timeout(Math.min(14000, resta)) });
          j = await r.json();
        } catch (e) { ultimo = `${m}: ${String(e)}`; break; }   // tardó demasiado: siguiente modelo
        if (r.ok) { d = j; break; }
        ultimo += ` | ${m}${sinPensar ? "(low)" : ""}: ${j?.error?.message || r.status}`;
        if (r.status === 400 && sinPensar) { sinPensar = false; continue; }   // modelo sin ese ajuste: sin él
        if ((r.status === 503 || r.status === 429) && intento === 0) { await new Promise((s) => setTimeout(s, 800)); continue; }
        break;
      }
      if (d || limite - Date.now() < 2500) break;
    }
    if (!d) return json({ error: "gemini", detalle: ultimo }, 502);
    const partes = d?.candidates?.[0]?.content?.parts || [];
    const texto = partes.find((p: any) => p.text && !p.thought)?.text || "{}";
    return json(JSON.parse(texto));
  } catch (e) {
    return json({ error: "fallo", detalle: String(e) }, 500);
  }
});
