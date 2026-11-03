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
    const cuerpo = JSON.stringify({
      contents: [{ parts: [{ text: PROMPT }, { inline_data: { mime_type: mime || "image/jpeg", data: imagen } }] }],
      generationConfig: { responseMimeType: "application/json", responseSchema: schema, temperature: 0.1 },
    });
    // Varios modelos de respaldo: si uno está saturado o retirado, prueba el siguiente
    const modelos = [Deno.env.get("GEMINI_MODEL"), "gemini-3.8-flash", "gemini-flash-latest", "gemini-flash-lite-latest"]
      .filter((m, i, a) => m && a.indexOf(m) === i) as string[];
    let d: any = null, ultimo = "";
    for (const m of modelos) {
      for (let intento = 0; intento < 2; intento++) {
        const r = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/${m}:generateContent?key=${key}`,
          { method: "POST", headers: { "Content-Type": "application/json" }, body: cuerpo },
        );
        const j = await r.json();
        if (r.ok) { d = j; break; }
        ultimo = `${m}: ${j?.error?.message || r.status}`;
        if (r.status === 503 || r.status === 429) { await new Promise((s) => setTimeout(s, 1200)); continue; }
        break; // modelo no disponible: siguiente
      }
      if (d) break;
    }
    if (!d) return json({ error: "gemini", detalle: ultimo }, 502);
    const texto = d?.candidates?.[0]?.content?.parts?.[0]?.text || "{}";
    return json(JSON.parse(texto));
  } catch (e) {
    return json({ error: "fallo", detalle: String(e) }, 500);
  }
});
